import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { signDoorRequest } from '../door-auth.js';
import { stubGate } from '../door/x402.js';
import { onJobExit } from '../lease.js';
import type { JobSpec, Offer } from '../types.js';
import type { TestHooks } from '../x402/seller.js';
import { hostHttpApp } from './http.js';
import type { Runner } from './runner.js';
import { LeaseStore } from './store.js';

const OFFER: Offer = {
  id: 'o1', hostPubkey: '', ilpBase: 'g.test', sealKey: '0x04' + 'ab'.repeat(64), sealUrl: 'http://x.anyone/ilp', cpu: 1,
  memoryMiB: 1024, intervalSeconds: 30, firstTickGraceSeconds: 90, tickPrice: 5000n, openPrice: 0n, statusPrice: 0n, images: ['charter-job-fetch'],
  hiddenHost: false, hiddenEgress: false, expiresAt: 0,
};
const JOB: JobSpec = { image: 'charter-job-fetch', args: { URLS: 'https://example.com' } };
const T0 = 1_700_000_000_000;
const ORIGIN = 'https://host.example';
const DOOR = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
const OTHER = privateKeyToAccount(('0x' + '22'.repeat(32)) as `0x${string}`);
const OFFER_JSON = { offer: { id: 'o1', tickPrice: '5000' } };

function fakeRunner(output: Buffer = Buffer.alloc(0)) {
  const calls: string[] = [];
  const r: Runner = {
    create: async (id) => void calls.push(`create ${id}`),
    start: async (id) => void calls.push(`start ${id}`),
    exited: async () => 0,
    stop: async (id) => void calls.push(`stop ${id}`),
    output: async () => output,
    alive: async () => true,
    ready: async () => true,
    ensureHome: async () => ({ homeId: '', port: 0, createdAt: 0, paidOnce: false }),
    publishHome: async () => undefined,
    retireHome: async () => undefined,
    homeAccess: async () => null,
    removeHome: async () => undefined,
    writePaidThrough: async () => undefined,
  };
  return { r, calls };
}

async function setup(output?: Buffer) {
  const store = new LeaseStore();
  const { r, calls } = fakeRunner(output);
  const gated: string[] = [];
  const hooks: TestHooks = { onGate: (id) => void gated.push(id) };
  const app = hostHttpApp({
    store, runner: r, offer: OFFER, now: () => T0, log: () => undefined,
    door: () => DOOR.address, origin: () => ORIGIN, tickGate: stubGate(() => OFFER.tickPrice, hooks), offerJson: () => OFFER_JSON,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A request as the door sends it: signed over the host's origin, method, path with query, and body. */
  const signed = async (method: string, path: string, body?: unknown, o: { signer?: PrivateKeyAccount; sentBody?: string } = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const auth = await signDoorRequest(o.signer ?? DOOR, ORIGIN, method, path, text, T0);
    const headers: Record<string, string> = { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: o.sentBody ?? text }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const plain = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { store, calls, gated, signed, plain, done: () => void server.close() };
}

test('GET /v1/offer needs no signature and returns the offer', async () => {
  const t = await setup();
  try {
    assert.deepEqual(await t.plain('GET', '/v1/offer'), { status: 200, body: OFFER_JSON });
    assert.deepEqual(await t.plain('GET', '/v1/health'), { status: 200, body: { ok: true } });
  } finally {
    t.done();
  }
});

test('open without a door signature is 401 not_door', async () => {
  const t = await setup();
  try {
    assert.deepEqual(await t.plain('POST', '/v1/leases', { job: JOB }), { status: 401, body: { error: 'not_door' } });
    assert.deepEqual(await t.signed('POST', '/v1/leases', { job: JOB }, { signer: OTHER }), { status: 401, body: { error: 'not_door' } });
    assert.deepEqual(await t.plain('GET', `/v1/leases/${'a'.repeat(32)}`), { status: 401, body: { error: 'not_door' } });
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.store.all(), []);
  } finally {
    t.done();
  }
});

test('open, tick 0, status, output through the signed app', async () => {
  const t = await setup(Buffer.from('hello'));
  try {
    const open = await t.signed('POST', '/v1/leases', { job: JOB });
    assert.equal(open.status, 200);
    assert.equal(open.body.state, 'awaiting_first_tick');
    const leaseId = open.body.leaseId as string;
    assert.match(leaseId, /^[0-9a-f]{32}$/);
    assert.deepEqual(t.calls, [`create ${leaseId}`], 'nothing runs before tick 0');

    const tick = await t.signed('POST', `/v1/leases/${leaseId}/ticks`, { index: 0 });
    assert.deepEqual(tick, { status: 200, body: { paidIntervals: 1, paidThrough: T0 + 30_000, duplicate: false } });
    assert.deepEqual(t.calls, [`create ${leaseId}`, `start ${leaseId}`]);
    assert.deepEqual(t.gated, [leaseId]);

    const status = await t.signed('GET', `/v1/leases/${leaseId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.lease.id, leaseId);
    assert.equal(status.body.lease.state, 'running');
    assert.equal(status.body.lease.paidIntervals, 1);

    t.store.put(onJobExit(t.store.get(leaseId)!, 1));
    const part = await t.signed('GET', `/v1/leases/${leaseId}/output/0`);
    assert.deepEqual(part, { status: 200, body: { part: 0, parts: 1, data: Buffer.from('hello').toString('base64') } });
  } finally {
    t.done();
  }
});

test('a tick for an unknown lease is 404 before the gate charges', async () => {
  const t = await setup();
  try {
    for (const id of ['b'.repeat(32), 'nope']) {
      assert.deepEqual(await t.signed('POST', `/v1/leases/${id}/ticks`, { index: 0 }), { status: 404, body: { error: 'not_found' } }, id);
    }
    assert.deepEqual(t.gated, [], 'the gate was never reached');
  } finally {
    t.done();
  }
});

test('a signature covers the query string, and a tampered body is 401', async () => {
  const t = await setup();
  try {
    const leaseId = (await t.signed('POST', '/v1/leases', { job: JOB })).body.leaseId as string;
    const withQuery = await t.signed('GET', `/v1/leases/${leaseId}?x=1`);
    assert.equal(withQuery.status, 200);
    assert.equal(withQuery.body.lease.id, leaseId);

    const tampered = await t.signed('POST', `/v1/leases/${leaseId}/ticks`, { index: 0 }, { sentBody: JSON.stringify({ index: 1 }) });
    assert.deepEqual(tampered, { status: 401, body: { error: 'not_door' } });
    assert.deepEqual(t.gated, []);
    assert.equal(t.store.get(leaseId)!.paidIntervals, 0);
  } finally {
    t.done();
  }
});
