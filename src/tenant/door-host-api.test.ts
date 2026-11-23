import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoorLedger } from '../door/ledger.js';
import { doorApp } from '../door/server.js';
import type { Answer, DoorClient } from '../fund/door-client.js';
import { homeJob } from '../jobs.js';
import type { JobSpec } from '../types.js';
import { DoorOfferMovedError, doorHostApi } from './door-host-api.js';
import { HostError } from './host-api.js';
import { runLease } from './run-lease.js';
import { exitJob, listedRegistry, OFFER, testHost } from './test-host.js';

const JOB: JobSpec = { image: 'charter-job-fetch', args: { URLS: 'https://example.com/a,https://example.com/b' } };
const RESULT = Buffer.from(JSON.stringify({ ok: true }));
const OFFER_ID = `${OFFER.hostId}:${OFFER.id}`;
/** What the stand-in client says each paid tick cost: the exact price a 402 would ask. */
const PRICE = 5000n;

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** A DoorClient over plain fetch to a free-for-tests door: a 2xx paid call reports PRICE as paid. */
function plainClient(base: string): DoorClient & { paths: string[] } {
  const paths: string[] = [];
  const post = async (path: string, json: unknown) =>
    answer(await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }));
  return {
    payTo: `0x${'2'.repeat(40)}`,
    paths,
    get: async (path) => (paths.push(`GET ${path}`), answer(await fetch(base + path))),
    post: async (path, json) => (paths.push(`POST ${path}`), post(path, json)),
    pay: async (path, json) => {
      paths.push(`PAY ${path}`);
      const a = await post(path, json);
      return a.status >= 200 && a.status < 300 ? { ...a, paid: PRICE } : a;
    },
    fund: async () => {
      throw new Error('not here');
    },
  };
}

async function door(h: Awaited<ReturnType<typeof testHost>>, offers = [OFFER]) {
  const dir = mkdtempSync(join(tmpdir(), 'door-host-api-'));
  const server = doorApp({
    offers: async () => offers,
    api: () => h.api,
    registry: listedRegistry(dir, [...new Set(offers.map((o) => o.hostId))]),
    ledger: new DoorLedger(join(dir, 'ledger.json')),
    x402: 'free-for-tests',
    now: () => h.clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => void server.close() };
}

test('doorHostApi drives runLease to done against a stub door', async () => {
  const h = await testHost({
    runner: { output: async () => RESULT },
    afterTick: (host, n) => {
      if (n === 2) exitJob(host, host.store.all()[0]!.id, RESULT);
    },
  });
  const d = await door(h);
  try {
    const c = plainClient(d.base);
    const r = await runLease(doorHostApi(c, OFFER_ID), { id: OFFER_ID, intervalSeconds: OFFER.intervalSeconds }, JOB, {
      maxIntervals: 10, now: () => h.clock.t, sleep: h.sleep,
    });
    assert.equal(r.lease.state, 'done');
    assert.equal(r.lease.paidIntervals, 2);
    assert.deepEqual(r.output, RESULT);
    assert.equal(r.spent, 2n * PRICE, 'spent sums what the paid ticks cost');
    assert.equal(h.sent.open, 1);
    assert.equal(h.sent.tick, 2);
    // Open is the free POST /v1/leases; only ticks go through the paying call.
    assert.equal(c.paths[0], 'POST /v1/leases');
    assert.deepEqual(c.paths.filter((p) => p.startsWith('PAY')), [`PAY /v1/leases/${r.lease.id}/ticks`, `PAY /v1/leases/${r.lease.id}/ticks`]);
    assert.ok(c.paths.includes(`GET /v1/leases/${r.lease.id}/output/0`));
  } finally {
    d.close();
    h.close();
  }
});

test('the door\'s error answers become HostError; a refused tick costs nothing', async () => {
  const h = await testHost();
  const d = await door(h);
  try {
    const api = doorHostApi(plainClient(d.base), OFFER_ID);
    await assert.rejects(api.status('f'.repeat(32)), (e: unknown) => e instanceof HostError && e.status === 404 && e.error === 'not_found');
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 5), (e: unknown) => e instanceof HostError && e.status === 409 && e.error === 'out_of_order');
    assert.equal(api.spent(), 0n);
  } finally {
    d.close();
    h.close();
  }
});

test('open sends the job the way the door takes it', async () => {
  const sent: unknown[] = [];
  const c = {
    post: async (_p: string, json: unknown) => (sent.push(json), { status: 200, body: { leaseId: 'a'.repeat(32), state: 'closed', closedReason: 'boot_failed' } }),
  } as unknown as DoorClient;
  const api = doorHostApi(c, OFFER_ID);
  await api.open(JOB);
  await api.open({ image: 'charter-job-python', args: { SCRIPT: 'print(1)' } });
  await api.open(homeJob(['ssh-ed25519 AAAA'], 'charter-hermes'));
  assert.deepEqual(sent, [
    { offerId: OFFER_ID, urls: ['https://example.com/a', 'https://example.com/b'] },
    { offerId: OFFER_ID, python: { script: 'print(1)' } },
    { offerId: OFFER_ID, home: { sshKeys: ['ssh-ed25519 AAAA'], image: 'charter-hermes' } },
  ]);
});

test('a home the door opened on another offer (where the home lives) is named, nothing paid', async () => {
  const LEASE = 'b'.repeat(32);
  const other = { offerId: `${'cd'.repeat(32)}:h2`, intervalSeconds: 600, tickPrice: '9000' };
  const paths: string[] = [];
  const c = {
    post: async () => ({ status: 200, body: { leaseId: LEASE, state: 'awaiting_first_tick' } }),
    get: async (p: string) => (paths.push(p), { status: 200, body: { lease: { id: LEASE, state: 'awaiting_first_tick', paidIntervals: 0 }, offer: other } }),
    pay: async () => assert.fail('nothing is paid'),
  } as unknown as DoorClient;
  const api = doorHostApi(c, OFFER_ID);
  await assert.rejects(
    api.open(homeJob(['ssh-ed25519 AAAA'])),
    (e: unknown) => e instanceof DoorOfferMovedError && e.leaseId === LEASE && e.offer.offerId === other.offerId,
  );
  assert.deepEqual(paths, [`/v1/leases/${LEASE}`]);
  // The same home opened on the offer named: no error.
  const same = { ...c, get: async () => ({ status: 200, body: { lease: { id: LEASE, state: 'awaiting_first_tick', paidIntervals: 0 }, offer: { ...other, offerId: OFFER_ID } } }) } as unknown as DoorClient;
  assert.equal((await doorHostApi(same, OFFER_ID).open(homeJob(['ssh-ed25519 AAAA']))).leaseId, LEASE);
});
