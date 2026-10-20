import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HostError, hostApi, type HostApi, type OpenResult, type OutputPart, type TickResult } from '../tenant/host-api.js';
import { OFFER } from '../tenant/test-host.js';
import type { Lease, Micro, Offer } from '../types.js';
import { DoorLedger, offerOfSnapshot, snapshotOffer } from './ledger.js';
import { doorApp, type DoorDeps } from './server.js';
import * as payerMod from '../payer.js';


const b64 = (o: unknown, pretty = false) => Buffer.from(JSON.stringify(o, null, pretty ? 2 : undefined)).toString('base64');
const pad = (s: string, n: number) => '0x' + s.replace(/^0x/i, '').toLowerCase().padStart(n, '0');
const nowSeconds = () => 1_000_000 / 1000;
/** A payment header carrying one EIP-3009 authorization. `variant` 1 re-encodes the same authorization: other key order, whitespace, an extra field, upper-case hex. */
function pay(from: string, nonce: string, variant: 0 | 1 = 0, window: { validAfter?: string; validBefore?: string } = {}): string {
  const auth = {
    from: pad(from, 40), to: '0x' + '2'.repeat(40), value: '5000',
    validAfter: window.validAfter ?? '0', validBefore: window.validBefore ?? '9999999999', nonce: pad(nonce, 64),
  };
  if (variant === 0) return b64({ x402Version: 2, payload: { authorization: auth, signature: '0xsig' } });
  const { nonce: n, from: f, ...rest } = auth;
  const up = (h: string) => h.toUpperCase().replace('0X', '0x');
  return b64({ extra: { note: 'x' }, payload: { signature: '0xsig', authorization: { nonce: up(n), ...rest, from: up(f) } }, x402Version: 2 }, true);
}
const PAYER_FAULT = 'invalid_exact_evm_insufficient_balance';
const keyOf = (from: string, nonce: string) => createHash('sha256').update(`${pad(from, 40)}:${pad(nonce, 64)}`).digest('hex');

const OFFER_ID = `${OFFER.hostPubkey}:${OFFER.id}`;
const LEASE = 'a'.repeat(32);
const URLS = ['https://example.com/a', 'http://example.com/b'];

function lease(over: Partial<Lease> = {}): Lease {
  return {
    id: LEASE, offerId: OFFER.id, job: { image: 'charter-job-fetch', args: { URLS: URLS.join(',') } },
    state: 'running', createdAt: 1_000, paidIntervals: 1, paidThrough: 31_000, ...over,
  };
}

/** A scripted HostApi. Each method can be overridden; calls are recorded. */
function fakeHost(
  over: Partial<HostApi> = {},
  tickFailure?: Error | ((n: number) => Error | undefined),
  prices: { open?: Micro; status?: Micro } = {},
) {
  let tickCount = 0;
  const calls: string[] = [];
  let spent: Micro = 0n;
  const opened: Array<{ image: string; args: Record<string, string> }> = [];
  // A status read made for a tick (priority high) is recorded apart from the free reads the GET routes cause.
  const statusCall = (opts?: { priority?: 'high' }) => {
    calls.push(opts?.priority === 'high' ? 'status:tick' : 'status');
    spent += prices.status ?? 0n;
  };
  const api: HostApi = {
    open: async (job): Promise<OpenResult> => (calls.push('open'), opened.push(job), (spent += prices.open ?? 0n), { leaseId: LEASE, state: 'awaiting_first_tick' }),
    tick: async (_id, index): Promise<TickResult> => {
      calls.push(`tick:${index}`);
      const tickFail = typeof tickFailure === 'function' ? tickFailure(++tickCount) : tickFailure;
      // As hostApi: a packet the host answered is paid even when the answer is an error.
      if (tickFail instanceof HostError) spent += 5000n;
      if (tickFail) throw tickFail;
      spent += 5000n;
      return { paidIntervals: index + 1, paidThrough: 31_000, duplicate: false };
    },
    status: async (_id, opts) => (statusCall(opts), lease()),
    output: async () => Buffer.alloc(0),
    outputPart: async (_id, part): Promise<OutputPart> => (calls.push(`part:${part}`), { part, parts: 2, data: Buffer.from(`p${part}`).toString('base64') }),
    spent: (): Micro => spent,
    ...over,
  };
  // Overridden reads are counted too.
  const { status, outputPart } = api;
  if (over.status) api.status = async (id, opts) => (statusCall(opts), status(id, opts));
  if (over.outputPart) api.outputPart = async (id, n) => (calls.push(`part:${n}`), outputPart(id, n));
  return { api, calls, opened };
}

async function start(host: ReturnType<typeof fakeHost>, over: Partial<DoorDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'door-'));
  const ledger = new DoorLedger(join(dir, 'ledger.json'));
  const gate: string[] = [];
  const settled: Array<{ leaseId: string; price: Micro }> = [];
  const clock = { t: 1_000_000 };
  let offerCalls = 0;
  const deps: DoorDeps = {
    offers: async () => (offerCalls++, [OFFER]),
    api: () => host.api,
    hosts: new Map([[OFFER.hostPubkey, OFFER.ilpBase]]),
    ledger,
    x402: 'free-for-tests',
    now: () => clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
    ...over,
    testHooks: { onGate: (id) => void gate.push(id), settle: (i) => void settled.push(i), ...over.testHooks },
  };
  const server = doorApp(deps).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, ledger, gate, settled, clock, dir, offerCalls: () => offerCalls,
    close: () => void server.close(),
    post: (path: string, body: unknown, headers: Record<string, string | undefined> = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', ...headers }).filter(([, v]) => v !== undefined)) as Record<string, string>,
        body: JSON.stringify(body),
      }),
    get: (path: string) => fetch(base + path),
  };
}

test('open, tick and status return the host state, and the ledger counts both sides', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    const open = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), { leaseId: LEASE, state: 'awaiting_first_tick' });
    assert.deepEqual(host.opened, [{ image: 'charter-job-fetch', args: { URLS: URLS.join(',') } }]);

    const tick = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'x-test-payer': '0xabc' });
    assert.equal(tick.status, 200);
    assert.deepEqual(await tick.json(), { paidIntervals: 1, paidThrough: 31_000, duplicate: false });
    assert.deepEqual(d.settled, [{ leaseId: LEASE, price: 5000n }]);
    assert.ok(host.calls.includes('tick:0'));

    const st = await d.get(`/v1/leases/${LEASE}`);
    assert.equal(st.status, 200);
    const body = (await st.json()) as { lease: Lease; stopped: boolean };
    assert.equal(body.lease.state, 'running');
    assert.equal(body.stopped, false);

    const rec = d.ledger.get(LEASE)!;
    assert.equal(rec.offerId, OFFER_ID);
    assert.equal(rec.ticksPaidByRenter, 1);
    assert.equal(rec.ticksPaidToHost, 1);
    assert.equal(rec.payer, '0xabc');
    assert.equal(rec.losses, 0n);
  } finally {
    d.close();
  }
});

test('POST /v1/leases validates the body and the offer', async () => {
  const d = await start(fakeHost());
  try {
    assert.equal((await d.post('/v1/leases', { offerId: `${'f'.repeat(64)}:nope`, urls: URLS })).status, 404);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER.id, urls: URLS })).status, 404, 'a bare id never matches');
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: [] })).status, 400);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: Array(6).fill('https://e.com') })).status, 400);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: ['ftp://e.com'] })).status, 400);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: ['not a url'] })).status, 400);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: ['https://a.com,https://b.com'] })).status, 400, 'a comma would split the job arg');
    assert.equal((await d.post('/v1/leases', { urls: URLS })).status, 400);
    assert.equal((await d.post('/v1/leases', 'not an object')).status, 400);
  } finally {
    d.close();
  }
  const noImage: Offer = { ...OFFER, images: ['something-else'] };
  const d2 = await start(fakeHost(), { offers: async () => [noImage] });
  try {
    assert.equal((await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 400);
  } finally {
    d2.close();
  }
  const expired: Offer = { ...OFFER, expiresAt: 500_000 };
  const d3 = await start(fakeHost(), { offers: async () => [expired] });
  try {
    assert.equal((await d3.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 404, 'an expired offer is not open');
  } finally {
    d3.close();
  }
});

test('POST /v1/leases with python opens a python job on an offer that lists the image', async () => {
  const both: Offer = { ...OFFER, images: ['charter-job-fetch', 'charter-job-python'] };
  const host = fakeHost();
  const d = await start(host, { offers: async () => [both] });
  const script = 'import numpy as np\nprint("pi", np.pi)\n' + '#'.repeat(8 * 1024 - 40);
  try {
    const open = await d.post('/v1/leases', { offerId: OFFER_ID, python: { script } });
    assert.equal(open.status, 200);
    assert.deepEqual(host.opened, [{ image: 'charter-job-python', args: { SCRIPT: script } }]);
  } finally {
    d.close();
  }
});

test('POST /v1/leases refuses a bad python body, and a python job on an offer without the image', async () => {
  const both: Offer = { ...OFFER, images: ['charter-job-fetch', 'charter-job-python'] };
  const host = fakeHost();
  const d = await start(host, { offers: async () => [both] });
  try {
    for (const python of [{ script: '' }, { script: '  \n' }, { script: 'x'.repeat(8 * 1024 + 1) }, { script: 'a\0b' }, { script: 5 }, 'print(1)', null]) {
      assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, python })).status, 400, JSON.stringify(python)?.slice(0, 40));
    }
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS, python: { script: 'print(1)' } })).status, 400, 'one job per lease');
    assert.equal(host.opened.length, 0);
  } finally {
    d.close();
  }
  const d2 = await start(fakeHost());
  try {
    const r = await d2.post('/v1/leases', { offerId: OFFER_ID, python: { script: 'print(1)' } });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'image_not_offered' });
  } finally {
    d2.close();
  }
});

test('GET /v1/offers lists an offer that carries only the python image', async () => {
  const py: Offer = { ...OFFER, images: ['charter-job-python'] };
  const d = await start(fakeHost(), { offers: async () => [py] });
  try {
    const list = (await (await d.get('/v1/offers')).json()) as Array<{ images: string[] }>;
    assert.deepEqual(list.map((o) => o.images), [['charter-job-python']]);
  } finally {
    d.close();
  }
});

test('a host open that throws answers 502 and records no lease', async () => {
  const d = await start(fakeHost({ open: async () => { throw new Error('socket hang up at 10.0.0.1'); } }));
  try {
    const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'host_unreachable' });
  } finally {
    d.close();
  }
});

test('a boot failure is passed on with its reason', async () => {
  const host = fakeHost({ open: async () => ({ leaseId: LEASE, state: 'closed', closedReason: 'boot_failed', error: 'boot_timeout' }) });
  const d = await start(host);
  try {
    const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { leaseId: LEASE, state: 'closed', closedReason: 'boot_failed', error: 'boot_timeout' });
  } finally {
    d.close();
  }
});

test('a host tick that throws answers 502 and nothing settles', async () => {
  const host = fakeHost({}, new Error('packet refused'));
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'host_unreachable' });
    assert.deepEqual(d.settled, []);
    const rec = d.ledger.get(LEASE)!;
    assert.equal(rec.ticksPaidByRenter, 0);
    assert.equal(rec.ticksPaidToHost, 0);
    assert.equal(rec.stopped, false);
  } finally {
    d.close();
  }
});

test('a host 5xx on the tick answers 502 and nothing settles', async () => {
  const host = fakeHost({}, new HostError(500, 'internal'));
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'internal' });
    assert.deepEqual(d.settled, []);
    const rec = d.ledger.get(LEASE)!;
    assert.equal(rec.losses, 5000n, 'the host answered, so the door paid');
    assert.equal(rec.stopped, true);
  } finally {
    d.close();
  }
});

test('host 409 lease_done and not_running answer 409 and nothing settles', async () => {
  for (const code of ['lease_done', 'not_running']) {
    const host = fakeHost({}, new HostError(409, code));
    const d = await start(host);
    try {
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
      assert.equal(r.status, 409);
      assert.deepEqual(await r.json(), { error: code });
      assert.deepEqual(d.settled, []);
      assert.equal(d.ledger.get(LEASE)!.ticksPaidByRenter, 0);
      assert.equal(d.ledger.get(LEASE)!.losses, 5000n, 'the host was paid for that answer');
      // A renter cannot keep a finished lease's ticks costing the door: the next one stops at the door.
      host.calls.length = 0;
      const again = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 4 });
      assert.equal(again.status, 409);
      assert.deepEqual(await again.json(), { error: 'stopped' });
      assert.deepEqual(host.calls, []);
    } finally {
      d.close();
    }
  }
});

test('settlement fails after the host was paid: loss recorded, lease stopped, next tick 409 stopped before any payment challenge', async () => {
  const host = fakeHost();
  const d = await start(host, { testHooks: { settle: () => { throw new Error('facilitator down'); } } });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(r.status, 402, 'the renter is told the payment did not settle');
    const rec = d.ledger.get(LEASE)!;
    assert.equal(rec.ticksPaidToHost, 1);
    assert.equal(rec.ticksPaidByRenter, 0);
    assert.equal(rec.losses, 5000n);
    assert.equal(rec.stopped, true);

    d.gate.length = 0;
    host.calls.length = 0;
    const next = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 1 });
    assert.equal(next.status, 409);
    assert.deepEqual(await next.json(), { error: 'stopped' });
    assert.deepEqual(d.gate, [], 'no payment gate, so no 402 challenge');
    assert.deepEqual(host.calls, [], 'the host is not paid again');
    assert.equal(d.ledger.get(LEASE)!.losses, 5000n);

    const st = (await (await d.get(`/v1/leases/${LEASE}`)).json()) as { stopped: boolean };
    assert.equal(st.stopped, true);
  } finally {
    d.close();
  }
});

test('the renter goes silent: the host closes the lease, the door shows it, the ledger shows one renter tick', async () => {
  let closed = false;
  const host = fakeHost({
    status: async () => lease(closed ? { state: 'closed', closedReason: 'missed_tick' } : {}),
  });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
    closed = true;
    d.clock.t += 6_000; // past the 5 s status cache
    const st = (await (await d.get(`/v1/leases/${LEASE}`)).json()) as { lease: Lease };
    assert.equal(st.lease.state, 'closed');
    assert.equal(st.lease.closedReason, 'missed_tick');
    assert.equal(d.ledger.get(LEASE)!.ticksPaidByRenter, 1);
    assert.equal(d.ledger.get(LEASE)!.losses, 0n);
  } finally {
    d.close();
  }
});

test('tick bodies are validated before any payment gate', async () => {
  const d = await start(fakeHost());
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: -1 })).status, 400);
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 1.5 })).status, 400);
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, {})).status, 400);
    assert.equal((await d.post(`/v1/leases/${'b'.repeat(32)}/ticks`, { index: 0 })).status, 404);
    assert.equal((await d.post(`/v1/leases/not-a-lease/ticks`, { index: 0 })).status, 404);
    assert.deepEqual(d.gate, []);
  } finally {
    d.close();
  }
});

test('the 11th POST /v1/leases from one IP within an hour answers 429, and the window slides', async () => {
  let n = 0;
  const d = await start(fakeHost({ open: async () => ({ leaseId: (++n).toString(16).padStart(32, '0'), state: 'awaiting_first_tick' }) }));
  try {
    for (let i = 0; i < 10; i++) assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 200);
    const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(r.status, 429);
    d.clock.t += 3_600_001;
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 200);
  } finally {
    d.close();
  }
});

test('GET /v1/offers is free, CORS-open, trimmed to what a renter needs, and cached for 60 s', async () => {
  const noImage: Offer = { ...OFFER, id: 'o2', images: ['x'] };
  const d = await start(fakeHost(), { offers: async () => [OFFER, noImage] });
  try {
    const r = await d.get('/v1/offers');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const body = (await r.json()) as Array<Record<string, unknown>>;
    assert.equal(body.length, 1, 'an offer without the fetch image is not listed');
    assert.deepEqual(body[0], {
      offerId: OFFER_ID, cpu: 1, memoryMiB: 1024, intervalSeconds: 30, tickPrice: '5000', images: ['charter-job-fetch'],
      hiddenHost: true, hiddenEgress: false, expiresAt: OFFER.expiresAt,
    });
    assert.ok(!JSON.stringify(body).includes('sealKey') && !JSON.stringify(body).includes('ilpBase'));
  } finally {
    d.close();
  }
  const d2 = await start(fakeHost());
  try {
    await d2.get('/v1/offers');
    await d2.get('/v1/offers');
    assert.equal(d2.offerCalls(), 1);
    d2.clock.t += 61_000;
    await d2.get('/v1/offers');
    assert.equal(d2.offerCalls(), 2);
  } finally {
    d2.close();
  }
});

test('status is cached for 5 s; an unknown lease is 404 and never reaches the host', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.get(`/v1/leases/${LEASE}`);
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(host.calls.filter((c) => c === 'status').length, 1);
    d.clock.t += 5_001;
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(host.calls.filter((c) => c === 'status').length, 2);
    const before = host.calls.length;
    assert.equal((await d.get(`/v1/leases/${'c'.repeat(32)}`)).status, 404);
    assert.equal((await d.get(`/v1/leases/${'c'.repeat(32)}/output/0`)).status, 404);
    assert.equal(host.calls.length, before);
    assert.equal(d.ledger.get('c'.repeat(32)), undefined);
  } finally {
    d.close();
  }
});

const DONE = () => lease({ state: 'done', outputParts: 2 });

test('output parts are proxied as the host answers them; a host 409 unpaid passes through; a bad part is 404', async () => {
  const host = fakeHost({ status: async () => DONE() });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.get(`/v1/leases/${LEASE}/output/1`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await r.json(), { part: 1, parts: 2, data: Buffer.from('p1').toString('base64') });
    assert.equal((await d.get(`/v1/leases/${LEASE}/output/x`)).status, 404);
  } finally {
    d.close();
  }
  const d2 = await start(fakeHost({ status: async () => DONE(), outputPart: async () => { throw new HostError(409, 'unpaid'); } }));
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d2.get(`/v1/leases/${LEASE}/output/0`);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'unpaid' });
  } finally {
    d2.close();
  }
});

test('C1: a part the host never listed, or any part before output exists, is 404 with no host call', async () => {
  const host = fakeHost({ status: async () => DONE() });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.get(`/v1/leases/${LEASE}/output/0`)).status, 200);
    const before = host.calls.length;
    for (const n of [2, 3, 50, 99999, 4294967296]) assert.equal((await d.get(`/v1/leases/${LEASE}/output/${n}`)).status, 404);
    assert.equal(host.calls.length, before, 'enumerating past parts costs nothing');
  } finally {
    d.close();
  }
  const running = fakeHost();
  const d2 = await start(running);
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d2.get(`/v1/leases/${LEASE}/output/0`)).status, 404);
    assert.equal(running.calls.filter((c) => c.startsWith('part:')).length, 0);
  } finally {
    d2.close();
  }
});

test('C1: each output part is fetched once, kept on disk, and served from disk after a restart', async () => {
  const host = fakeHost({ status: async () => DONE() });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const first = await (await d.get(`/v1/leases/${LEASE}/output/0`)).json();
    d.clock.t += 3_600_000;
    assert.deepEqual(await (await d.get(`/v1/leases/${LEASE}/output/0`)).json(), first);
    assert.equal(host.calls.filter((c) => c === 'part:0').length, 1);
    assert.ok(readdirSync(join(d.dir, 'output', LEASE)).length >= 1);
  } finally {
    d.close();
  }
  const again = fakeHost({ status: async () => { throw new Error('should not be called'); } });
  const d2 = await start(again, { dataDir: d.dir, ledger: new DoorLedger(join(d.dir, 'ledger.json')) });
  try {
    const r = await d2.get(`/v1/leases/${LEASE}/output/0`);
    assert.equal(r.status, 200);
    assert.equal(again.calls.length, 0, 'a stored part needs no host call');
  } finally {
    d2.close();
  }
});

test('C1: a done lease with its landing is served from its cached final status with no further host calls', async () => {
  for (const state of ['done', 'closed'] as const) {
    const host = fakeHost({ status: async () => lease({ state, landing: { chain: 'solana', tx: '1'.repeat(88), shared: true } }) });
    const d = await start(host);
    try {
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      for (let i = 0; i < 5; i++) {
        assert.equal((await d.get(`/v1/leases/${LEASE}`)).status, 200);
        d.clock.t += 24 * 3_600_000;
      }
      assert.equal(host.calls.filter((c) => c === 'status').length, 1, state);
    } finally {
      d.close();
    }
  }
});

test('a done lease that has paid intervals and no landing is read again from the host, at most once per 10 minutes, on the read budget', async () => {
  let landing: Lease['landing'];
  const host = fakeHost({ status: async () => lease({ state: 'done', paidIntervals: 3, outputParts: 1, ...(landing ? { landing } : {}) }) });
  const d = await start(host);
  const statusCalls = () => host.calls.filter((c) => c === 'status').length;
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(((await (await d.get(`/v1/leases/${LEASE}`)).json()) as { lease: Lease }).lease.landing, undefined);
    assert.equal(statusCalls(), 1);
    d.clock.t += 9 * 60_000;
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(statusCalls(), 1, 'not before 10 minutes');
    landing = { chain: 'solana', tx: '2'.repeat(88), shared: true };
    d.clock.t += 2 * 60_000;
    const body = (await (await d.get(`/v1/leases/${LEASE}`)).json()) as { lease: Lease };
    assert.equal(statusCalls(), 2, 'after 10 minutes it asks the host again');
    assert.deepEqual(body.lease.landing, landing);
    assert.equal(d.ledger.get(LEASE)!.hostReads, 2, 'charged to the read budget');
    // With the landing in, the status is final for good.
    d.clock.t += 24 * 3_600_000;
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(statusCalls(), 2);
  } finally {
    d.close();
  }
});

test('the landing refresh never serves an error: a host that fails, or a spent budget, gives the last status; a lease that paid nothing is not refreshed', async () => {
  let fail = false;
  const host = fakeHost({
    status: async () => {
      if (fail) throw new HostError(500, 'boom');
      return lease({ state: 'done', paidIntervals: 3 });
    },
  });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.get(`/v1/leases/${LEASE}`);
    fail = true;
    d.clock.t += 11 * 60_000;
    const r = await d.get(`/v1/leases/${LEASE}`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { lease: Lease }).lease.state, 'done');
    const calls = host.calls.filter((c) => c === 'status').length;
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(host.calls.filter((c) => c === 'status').length, calls, 'a failed refresh waits another 10 minutes');
  } finally {
    d.close();
  }
  const none = fakeHost({ status: async () => lease({ state: 'done', paidIntervals: 0 }) });
  const d2 = await start(none);
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d2.get(`/v1/leases/${LEASE}`);
    d2.clock.t += 60 * 60_000;
    await d2.get(`/v1/leases/${LEASE}`);
    assert.equal(none.calls.filter((c) => c === 'status').length, 1);
  } finally {
    d2.close();
  }
});

test('the status answer carries the offer the door resolved at open time, which the ledger keeps and the relay need not still list', async () => {
  let listed = true;
  const host = fakeHost();
  const d = await start(host, { offers: async () => (listed ? [OFFER] : []) });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    listed = false;
    d.clock.t += 24 * 3_600_000;
    const r = await d.get('/v1/offers');
    assert.deepEqual(await r.json(), [], 'the offer is gone from the list');
    const body = (await (await d.get(`/v1/leases/${LEASE}`)).json()) as { offer?: Record<string, unknown> };
    assert.deepEqual(body.offer, {
      offerId: OFFER_ID, cpu: OFFER.cpu, memoryMiB: OFFER.memoryMiB, intervalSeconds: 30, tickPrice: '5000',
      images: ['charter-job-fetch'], hiddenHost: true, hiddenEgress: false, expiresAt: OFFER.expiresAt,
    });
    assert.equal(new DoorLedger(join(d.dir, 'ledger.json')).get(LEASE)!.offer?.tickPrice, '5000', 'persisted in the ledger');
  } finally {
    d.close();
  }
});

test('an existing lease works after its offer leaves the relay and the door restarts: status, output and a tick, with zero relay lookups', async () => {
  const host = fakeHost({ status: async () => lease({ state: 'running', outputParts: 2 }) });
  const d1 = await start(host);
  await d1.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
  assert.equal((await d1.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
  d1.close();

  let relay = 0;
  const seen: Offer[] = [];
  const d2 = await start(host, {
    offers: async () => (relay++, []),
    ledger: new DoorLedger(join(d1.dir, 'ledger.json')),
    dataDir: d1.dir,
    api: (o) => (seen.push(o), host.api),
  });
  try {
    const st = await d2.get(`/v1/leases/${LEASE}`);
    assert.equal(st.status, 200);
    assert.equal(((await st.json()) as { offer: { tickPrice: string } }).offer.tickPrice, '5000');
    assert.equal((await d2.get(`/v1/leases/${LEASE}/output/1`)).status, 200);
    assert.equal((await d2.post(`/v1/leases/${LEASE}/ticks`, { index: 1 })).status, 200);
    assert.deepEqual(d2.settled, [{ leaseId: LEASE, price: 5000n }], 'the price came from the snapshot');
    assert.equal(relay, 0, 'no relay lookups for an existing lease');
    assert.ok(seen.length >= 3);
    for (const o of seen) assert.deepEqual(o, OFFER, 'the host api is built from the full snapshot');
    assert.equal((await d2.get('/v1/offers').then((r) => r.json())).length, 0, 'the list still reads the relay');
    assert.equal(relay, 1);
  } finally {
    d2.close();
  }
});

test('C1: host reads per lease are capped at 40 + 8 per renter tick; past it the last status is served and uncached output is 429', async () => {
  const host = fakeHost({ status: async () => lease({ outputParts: 2 }) });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    for (let i = 0; i < 60; i++) {
      const r = await d.get(`/v1/leases/${LEASE}`);
      assert.equal(r.status, 200, `get ${i}`);
      d.clock.t += 6_000;
    }
    assert.equal(host.calls.filter((c) => c === 'status').length, 40);
    assert.equal((await d.get(`/v1/leases/${LEASE}/output/0`)).status, 429);
    assert.equal(host.calls.filter((c) => c.startsWith('part:')).length, 0);
    // One renter tick settled buys eight more reads.
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
    for (let i = 0; i < 12; i++) {
      d.clock.t += 6_000;
      await d.get(`/v1/leases/${LEASE}`);
    }
    assert.equal(host.calls.filter((c) => c === 'status').length, 48);
    assert.equal(host.calls.filter((c) => c === 'status:tick').length, 1, 'the tick read is paid by the tick, not the read budget');
    assert.equal(d.ledger.get(LEASE)!.hostReads, 48);
  } finally {
    d.close();
  }
});

test('C1: more than 120 GETs a minute from one IP on /v1/leases/* answers 429, and the window slides', async () => {
  const d = await start(fakeHost());
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    for (let i = 0; i < 120; i++) assert.equal((await d.get(`/v1/leases/${LEASE}`)).status, 200, `get ${i}`);
    const r = await d.get(`/v1/leases/${LEASE}`);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal((await d.get('/v1/offers')).status, 200, 'offers are not behind that limit');
    d.clock.t += 60_001;
    assert.equal((await d.get(`/v1/leases/${LEASE}`)).status, 200);
  } finally {
    d.close();
  }
});

function counterOpen() {
  let n = 0;
  return async (): Promise<OpenResult> => ({ leaseId: (++n).toString(16).padStart(32, '0'), state: 'awaiting_first_tick' });
}
const LEASE_1 = '1'.padStart(32, '0');
const LEASE_2 = '2'.padStart(32, '0');

test('C2: two concurrent ticks on one lease reach the host once; the second is 409 busy before the gate', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let hostTicks = 0;
  const host = fakeHost({
    tick: async (_id, index) => {
      hostTicks++;
      await held;
      return { paidIntervals: index + 1, paidThrough: 31_000, duplicate: false };
    },
  });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const first = d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xa1', '0x01') });
    while (hostTicks === 0) await new Promise((r) => setTimeout(r, 2));
    const second = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xa2', '0x02') });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'busy' });
    assert.equal(d.gate.length, 1, 'the second never reached the gate');
    release();
    assert.equal((await first).status, 200);
    assert.equal(hostTicks, 1);
    // The lease is free again afterwards.
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 1 }, { 'payment-signature': pay('0xa3', '0x03') })).status, 200);
  } finally {
    d.close();
  }
});

test('C2: one payment header cannot buy ticks on two leases; the hash survives a restart', async () => {
  const host = fakeHost({ open: counterOpen() });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'payment-signature': pay('0xaaa', '0xe1') })).status, 200);
    const gated = d.gate.length;
    host.calls.length = 0;
    const r = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xaaa', '0xe1') });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'payment_reused' });
    assert.equal(d.gate.length, gated, 'refused before the gate');
    assert.deepEqual(host.calls, [], 'no host call');
    // Another authorization from the same payer is another payment, and passes.
    assert.equal((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xaaa', '0xe2') })).status, 200);
  } finally {
    d.close();
  }
  const again = new DoorLedger(join(d.dir, 'ledger.json'));
  assert.equal(again.hasPayment(keyOf('0xaaa', '0xe1')), true);
});

test('C2: the hash is added on verify, even when settlement then fails', async () => {
  const host = fakeHost({ open: counterOpen() });
  const d = await start(host, { testHooks: { settle: () => { throw new Error('down'); } } });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'payment-signature': pay('0xbbb', '0xe3') })).status, 402);
    assert.equal((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xbbb', '0xe3') })).status, 409);
  } finally {
    d.close();
  }
});

test('I3: a retry of an accepted index, or a skipped one, is 409 out_of_order with no 402 challenge and no host call', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
    const gated = d.gate.length;
    host.calls.length = 0;
    for (const index of [0, 2, 7]) {
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index });
      assert.equal(r.status, 409, `index ${index}`);
      assert.deepEqual(await r.json(), { error: 'out_of_order', expected: 1 });
    }
    assert.equal(d.gate.length, gated);
    assert.deepEqual(host.calls, []);
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 1 })).status, 200);
  } finally {
    d.close();
  }
});

test('payer block: a loss booked because the host refused a tick does not block the payer on a new lease', async () => {
  const host = fakeHost({ open: counterOpen() }, (n) => (n === 1 ? new HostError(409, 'lease_done') : undefined));
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'x-test-payer': '0xAbC', 'payment-signature': pay('0xc1', '0x01') });
    assert.equal(r.status, 409);
    const rec = d.ledger.get(LEASE_1)!;
    assert.equal(rec.losses, 5000n);
    assert.equal(rec.lossKind, 'host_refused');
    assert.equal(rec.payer, '0xabc');
    assert.equal(d.ledger.payerHasLoss('0xabc', d.clock.t), false);
    assert.equal((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-test-payer': '0xabc', 'payment-signature': pay('0xc2', '0x02') })).status, 200);
  } finally {
    d.close();
  }
});

test('payer block: a settlement failure is stored as settle_failed', async () => {
  const d = await start(fakeHost(), { testHooks: { settle: () => { throw new Error(PAYER_FAULT); } } });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'x-test-payer': '0xabc' });
    assert.equal(d.ledger.get(LEASE)!.lossKind, 'settle_failed');
    assert.equal(new DoorLedger(join(d.dir, 'ledger.json')).payerHasLoss('0xABC', d.clock.t), true, 'the block survives a restart');
  } finally {
    d.close();
  }
});

test('a tick on a lease whose cached status is done or closed is refused before the gate with zero host calls', async () => {
  for (const [state, error] of [['done', 'lease_done'], ['closed', 'not_running']] as const) {
    const host = fakeHost({ status: async () => lease({ state }) });
    const d = await start(host);
    try {
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      await d.get(`/v1/leases/${LEASE}`);
      host.calls.length = 0;
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
      assert.equal(r.status, 409, state);
      assert.deepEqual(await r.json(), { error });
      assert.deepEqual(d.gate, []);
      assert.deepEqual(host.calls, []);
      assert.equal(d.ledger.get(LEASE)!.losses, 0n);
      assert.equal(d.ledger.get(LEASE)!.stopped, false);
    } finally {
      d.close();
    }
  }
});

test('I4: a settlement failure records the payer, and that payer is refused on a new lease before any host call', async () => {
  const host = fakeHost({ open: counterOpen() });
  let fail = true;
  const d = await start(host, { testHooks: { settle: () => { if (fail) throw new Error(PAYER_FAULT); } } });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'x-test-payer': '0xAbC', 'payment-signature': pay('0xd1', '0x01') })).status, 402);
    assert.equal(d.ledger.get(LEASE_1)!.payer, '0xabc');
    assert.equal(d.ledger.get(LEASE_1)!.losses, 5000n);
    fail = false;
    host.calls.length = 0;
    const r = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-test-payer': '0xABC', 'payment-signature': pay('0xd2', '0x02') });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'payer_blocked' });
    assert.deepEqual(host.calls, []);
    assert.deepEqual(d.settled, [], 'nothing settled for the blocked payer');
    // A different payer is fine.
    assert.equal((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-test-payer': '0xdef', 'payment-signature': pay('0xd3', '0x03') })).status, 200);
  } finally {
    d.close();
  }
});

test('CORS: GETs and the tick route are open with the x402 headers exposed; POST /v1/leases is same-origin only (F-I1)', async () => {
  const d = await start(fakeHost());
  try {
    const pre = await fetch(`${d.base}/v1/leases/${LEASE}/ticks`, { method: 'OPTIONS', headers: { origin: 'https://x.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'payment-signature,content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match((pre.headers.get('access-control-allow-headers') ?? '').toLowerCase(), /payment-signature/);
    assert.match((pre.headers.get('access-control-allow-headers') ?? '').toLowerCase(), /x-payment/);
    const expose = (pre.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    for (const h of ['payment-required', 'payment-response', 'x-payment-response']) assert.ok(expose.includes(h), h);
    // The page is served by the door itself, so opening a lease needs no CORS: another origin cannot open one.
    const preOpen = await fetch(`${d.base}/v1/leases`, { method: 'OPTIONS', headers: { origin: 'https://x.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(preOpen.headers.get('access-control-allow-origin'), null);
    assert.equal(preOpen.headers.get('access-control-allow-methods'), null);
    const open = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(open.status, 200);
    assert.equal(open.headers.get('access-control-allow-origin'), null);
    const tick = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(tick.headers.get('access-control-allow-origin'), '*');
    assert.equal((await d.get(`/v1/leases/${LEASE}`)).headers.get('access-control-allow-origin'), '*');
  } finally {
    d.close();
  }
});

test('GET / answers a plain "Charter door" when web/dist is missing, and serves it when present', async () => {
  const d = await start(fakeHost());
  try {
    const r = await d.get('/');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'Charter door');
    assert.equal((await d.get('/nope')).status, 404);
  } finally {
    d.close();
  }
  const web = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(web, 'assets', 'a.js'), 'x');
  const d2 = await start(fakeHost(), { webDir: web });
  try {
    assert.equal(await (await d2.get('/')).text(), '<h1>hi</h1>');
    assert.equal(await (await d2.get('/assets/a.js')).text(), 'x');
  } finally {
    d2.close();
  }
});

test('GET /v1/dev answers 200 only in free-for-tests mode, so the page can skip x402', async () => {
  const d = await start(fakeHost());
  try {
    const r = await d.get('/v1/dev');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { dev: true });
  } finally {
    d.close();
  }
  const real = await start(fakeHost(), { x402: { payTo: '0x' + '2'.repeat(40), network: 'eip155:8453', facilitatorUrl: 'http://127.0.0.1:1', claimKey: CLAIM_KEY, channelDir: mkdtempSync(join(tmpdir(), 'ch-')) } });
  try {
    assert.equal((await real.get('/v1/dev')).status, 404);
  } finally {
    real.close();
  }
});


/** A facilitator that only answers /supported, enough for the real gate to build a 402 challenge. */
async function withRealDoor(run: (d: Awaited<ReturnType<typeof start>>) => Promise<void>): Promise<void> {
  const fac = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.startsWith('/supported') ? { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [], signers: {} } : {}));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fac.once('listening', r));
  const d = await start(fakeHost(), { x402: { payTo: PAY_TO, network: 'eip155:8453', facilitatorUrl: `http://127.0.0.1:${(fac.address() as AddressInfo).port}`, claimKey: CLAIM_KEY, channelDir: mkdtempSync(join(tmpdir(), 'ch-')) } });
  try {
    await run(d);
  } finally {
    d.close();
    fac.close();
  }
}
const PAY_TO = '0x' + '2'.repeat(40);
const CLAIM_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`;

test('GET /v1/door tells the page where payments go: payTo and network, free and with CORS; absent in test mode', async () => {
  await withRealDoor(async (d) => {
    const r = await d.get('/v1/door');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { payTo: PAY_TO, network: 'eip155:8453' });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
  const t = await start(fakeHost());
  try {
    assert.equal((await t.get('/v1/door')).status, 404);
  } finally {
    t.close();
  }
});

test('the 402 challenge offers exact USDC on Base for the tick price, to payTo, valid for 300 s', async () => {
  await withRealDoor(async (d) => {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(r.status, 402);
    const required = JSON.parse(Buffer.from(r.headers.get('payment-required')!, 'base64').toString()) as { accepts: Array<Record<string, unknown>> };
    assert.equal(required.accepts.length, 1);
    const a = required.accepts[0]!;
    assert.equal(a.scheme, 'exact');
    assert.equal(a.network, 'eip155:8453');
    assert.equal(a.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    assert.equal(a.amount, '5000');
    assert.equal((a.payTo as string).toLowerCase(), PAY_TO);
    assert.equal(a.maxTimeoutSeconds, 300);
  });
});

test('DoorLedger: JSON file, bigint losses, atomic writes, reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'sub', 'ledger.json');
  const l = new DoorLedger(file);
  l.open({ leaseId: LEASE, offerId: OFFER_ID, createdAt: 5, offer: snapshotOffer(OFFER) });
  l.renterTick(LEASE, '0xpayer');
  l.hostTick(LEASE);
  l.loss(LEASE, 5000n, 'settle_failed', 7);
  l.stop(LEASE);
  // The loss is also the day's unpaid spend, kept beside the ledger.
  assert.deepEqual(readdirSync(join(dir, 'sub')).sort(), ['ledger.json', 'ledger.json.unpaid'], 'no temp file left behind');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.ok(JSON.stringify(raw).includes('"5000"'), 'bigint stored as a string');
  const again = new DoorLedger(file);
  assert.deepEqual(again.get(LEASE), {
    leaseId: LEASE, offerId: OFFER_ID, payer: '0xpayer', ticksPaidByRenter: 1, ticksPaidToHost: 1, losses: 5000n, lossKind: 'settle_failed', lossAt: 7, stopped: true, createdAt: 5, nextIndex: 1, hostReads: 0, offer: snapshotOffer(OFFER),
  });
  assert.deepEqual(offerOfSnapshot(again.get(LEASE)!.offer), OFFER, 'the snapshot round-trips the whole offer, bigints included');
  assert.equal(again.get('missing'), undefined);
});

test('DoorLedger: payment hashes are kept bounded, newest last, and compacted on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'ledger.json');
  const l = new DoorLedger(file, 3);
  const h = (n: number) => String(n).padStart(64, '0');
  for (let i = 1; i <= 10; i++) {
    assert.equal(l.hasPayment(h(i)), false);
    l.addPayment(h(i));
  }
  assert.equal(l.hasPayment(h(10)), true);
  assert.equal(l.hasPayment(h(1)), false, 'a hash past the bound is forgotten');
  const again = new DoorLedger(file, 3);
  assert.equal(again.hasPayment(h(10)), true);
  assert.equal(again.hasPayment(h(1)), false);
  assert.ok(readFileSync(`${file}.payments`, 'utf8').split('\n').filter(Boolean).length <= 7, 'file is compacted');
});

test('DoorLedger.unblock refuses anything that is not a lowercase-able 0x address', () => {
  const l = new DoorLedger(join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json'));
  for (const bad of ['nope', '0xabc', '0x' + 'g'.repeat(40), '0x' + 'a'.repeat(41)]) assert.throws(() => l.unblock(bad, 1), /address/);
  l.unblock('0x' + 'AB'.repeat(20), 1);
});

test('R3-1: exactly one of payment-signature and x-payment, non-empty: an empty one beside a reused authorization is 400, not a way around the checks', async () => {
  const host = fakeHost({ open: counterOpen() });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const good = pay('0xaa1', '0xf1');
    assert.equal((await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'payment-signature': good })).status, 200);
    const gated = d.gate.length;
    host.calls.length = 0;
    for (const headers of [
      { 'payment-signature': '', 'x-payment': good },
      { 'payment-signature': good, 'x-payment': good },
      { 'payment-signature': good, 'x-payment': '' },
      { 'payment-signature': '' },
      { 'x-payment': '' },
    ]) {
      const r = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, headers);
      assert.equal(r.status, 400, JSON.stringify(Object.keys(headers)));
      assert.deepEqual(await r.json(), { error: 'bad_payment' });
    }
    assert.equal(d.gate.length, gated);
    assert.deepEqual(host.calls, []);
  } finally {
    d.close();
  }
});

test('R3-2: a payload carrying permit2Authorization, or a nonce or address that is not canonical hex, is 400 bad_payment', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    host.calls.length = 0;
    const auth = { from: pad('0xaa', 40), to: pad('2', 40), value: '5000', validAfter: '0', validBefore: '9999999999', nonce: pad('0x1', 64) };
    const permit2 = { from: pad('0xbb', 40), nonce: pad('0x2', 64), deadline: '9999999999' };
    for (const payload of [
      { authorization: auth, permit2Authorization: permit2 },
      { permit2Authorization: permit2 },
      { authorization: { ...auth, nonce: 12345 } },
      { authorization: { ...auth, nonce: '0x1' } },
      { authorization: { ...auth, nonce: '1'.repeat(64) } },
      { authorization: { ...auth, from: '0xabc' } },
    ]) {
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': b64({ x402Version: 2, payload }) });
      assert.equal(r.status, 400, JSON.stringify(Object.keys(payload)));
      assert.deepEqual(await r.json(), { error: 'bad_payment' });
    }
    assert.deepEqual(d.gate, []);
    assert.deepEqual(host.calls, []);
  } finally {
    d.close();
  }
});

test('R3-3: an authorization window that cannot outlast the verify-to-settle gap is 400 authorization_window before the gate', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    host.calls.length = 0;
    const now = nowSeconds();
    for (const window of [
      { validBefore: String(now + 100) }, // under the 110 s minimum
      { validBefore: String(now - 1) },
      { validAfter: String(now + 100) }, // not valid yet
    ]) {
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xcc1', '0xf2', 0, window) });
      assert.equal(r.status, 400, JSON.stringify(window));
      assert.deepEqual(await r.json(), { error: 'authorization_window' });
    }
    assert.deepEqual(d.gate, []);
    assert.deepEqual(host.calls, []);
    // The boundary and the usual client shape (valid from 10 minutes ago, 300 s to run) pass.
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xcc1', '0xf3', 0, { validBefore: String(now + 110), validAfter: String(now) }) })).status, 200);
  } finally {
    d.close();
  }
  const d2 = await start(fakeHost());
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const now = nowSeconds();
    assert.equal((await d2.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xcc2', '0xf4', 0, { validAfter: String(now - 600), validBefore: String(now + 300) }) })).status, 200);
  } finally {
    d2.close();
  }
  const d3 = await start(fakeHost());
  try {
    await d3.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d3.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': b64({ payload: { authorization: { from: pad('1', 40), nonce: pad('1', 64) } } }) });
    assert.equal(r.status, 400, 'a window that is not numbers is a bad payment');
    assert.deepEqual(await r.json(), { error: 'bad_payment' });
  } finally {
    d3.close();
  }
});

test('R3-6: a verify failure releases the key, so an identical retry is allowed', async () => {
  const host = fakeHost();
  let verifies = false;
  const d = await start(host, { testHooks: { verify: () => verifies } });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const h = pay('0xdd1', '0xf5');
    const first = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': h });
    assert.equal(first.status, 402);
    assert.equal(host.calls.filter((c) => c.startsWith('tick')).length, 0);
    assert.equal(d.ledger.hasPayment(keyOf('0xdd1', '0xf5')), false, 'only a verified key is persisted');
    verifies = true;
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': h })).status, 200);
    assert.equal(d.ledger.hasPayment(keyOf('0xdd1', '0xf5')), true);
  } finally {
    d.close();
  }
});

test('R3-6: concurrent identical authorizations on two leases reach the host once', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let hostTicks = 0;
  const host = fakeHost({
    open: counterOpen(),
    tick: async (_id, index) => {
      hostTicks++;
      await held;
      return { paidIntervals: index + 1, paidThrough: 31_000, duplicate: false };
    },
  });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const first = d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'payment-signature': pay('0xee1', '0xf6') });
    while (hostTicks === 0) await new Promise((r) => setTimeout(r, 2));
    const second = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xee1', '0xf6', 1) });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'payment_reused' });
    release();
    assert.equal((await first).status, 200);
    assert.equal(hostTicks, 1);
  } finally {
    d.close();
  }
});

test('N1: one authorization re-encoded two ways on two leases: the second is 409 payment_reused with zero host calls', async () => {
  const host = fakeHost({ open: counterOpen() });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'payment-signature': pay('0xAbC', '0xAA', 0) })).status, 200);
    const gated = d.gate.length;
    host.calls.length = 0;
    const r = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xAbC', '0xAA', 1) });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'payment_reused' });
    assert.equal(d.gate.length, gated);
    assert.deepEqual(host.calls, []);
    // The legacy header spelling carries the same authorization.
    assert.equal((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-payment': pay('0xabc', '0xaa', 1) })).status, 409);
  } finally {
    d.close();
  }
});

test('N1: a payment that does not decode to from and nonce is 400 bad_payment before the gate', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    host.calls.length = 0;
    for (const h of ['not base64 !!', b64({ payload: {} }), b64({ payload: { authorization: { from: '0x1' } } }), b64('text'), b64(null)]) {
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': h });
      assert.equal(r.status, 400, h);
      assert.deepEqual(await r.json(), { error: 'bad_payment' });
    }
    assert.deepEqual(d.gate, []);
    assert.deepEqual(host.calls, []);
  } finally {
    d.close();
  }
});

test('N2: a transient settlement failure is booked but never blocks; only the exact payer-fault codes do', async () => {
  for (const [reason, blocks, kind] of [
    ['facilitator unreachable', false, 'settle_failed_transient'],
    ['nonce too low', false, 'settle_failed_transient'],
    ['invalid_exact_evm_transaction_failed: bad signature from the facilitator wallet', false, 'settle_failed_transient'],
    ['insufficient funds for gas', false, 'settle_failed_transient'],
    ['invalid_exact_evm_payload_authorization_valid_before', false, 'settle_failed_transient'],
    ['invalid_exact_evm_insufficient_balance', true, 'settle_failed'],
    ['invalid_exact_evm_nonce_already_used', true, 'settle_failed'],
    ['invalid_exact_evm_signature', true, 'settle_failed'],
  ] as const) {
    const host = fakeHost({ open: counterOpen() });
    let fail = true;
    const d = await start(host, { testHooks: { settle: () => { if (fail) throw new Error(reason); } } });
    try {
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      assert.equal((await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'x-test-payer': '0xabc' })).status, 402);
      assert.equal(d.ledger.get(LEASE_1)!.losses, 5000n, reason);
      assert.equal(d.ledger.get(LEASE_1)!.lossKind, kind, reason);
      assert.equal(d.ledger.get(LEASE_1)!.stopped, true);
      fail = false;
      const next = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-test-payer': '0xabc' });
      assert.equal(next.status, blocks ? 403 : 200, reason);
    } finally {
      d.close();
    }
  }
});

test('N2: a block lapses 24 h after the loss, and unblock (even from another process) clears it', async () => {
  const host = fakeHost({ open: counterOpen() });
  const d = await start(host, { testHooks: { settle: () => { throw new Error(PAYER_FAULT); } } });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const ADDR = '0x' + 'ab'.repeat(20);
    await d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'x-test-payer': ADDR });
    assert.equal(d.ledger.payerHasLoss(ADDR.toUpperCase(), d.clock.t + 23 * 3_600_000), true);
    assert.equal(d.ledger.payerHasLoss(ADDR, d.clock.t + 24 * 3_600_000 + 1), false, 'lapsed');
    assert.equal((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-test-payer': ADDR })).status, 403);
    // The operator command runs in another process: it writes the file the running door re-reads.
    new DoorLedger(join(d.dir, 'ledger.json')).unblock(ADDR, d.clock.t + 1);
    d.clock.t += 2;
    assert.equal(d.ledger.payerHasLoss(ADDR, d.clock.t), false);
    assert.notEqual((await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'x-test-payer': ADDR })).status, 403);
  } finally {
    d.close();
  }
});

test('N3: a tick whose send timed out answers 502 host_timeout, books host_refused (it may have been paid) and stops the lease', async () => {
  const host = fakeHost({ tick: async () => { throw new payerMod.SendTimeoutError(); } });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'x-test-payer': '0xabc' });
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: 'host_timeout' });
    const rec = d.ledger.get(LEASE)!;
    assert.equal(rec.losses, 5000n);
    assert.equal(rec.lossKind, 'host_refused');
    assert.equal(rec.stopped, true);
    assert.deepEqual(d.settled, []);
    assert.equal(d.ledger.payerHasLoss('0xabc', d.clock.t), false);
  } finally {
    d.close();
  }
});

/** A door whose host calls go through the real hostApi and serialized queue, onto a scripted payer. */
async function queuedDoor() {
  const clock = { t: 1_000_000 };
  const sends: Array<{ dest: string; body: unknown; opts: { deadline?: number } }> = [];
  const held = new Map<string, () => void>();
  let opens = 0;
  let queuedTicks = 0;
  const inner: payerMod.Payer = {
    async send(dest, req, opts) {
      sends.push({ dest, body: req.body, opts });
      if (dest.endsWith('.charter-open')) {
        return { status: 200, body: { leaseId: (++opens).toString(16).padStart(32, '0'), state: 'awaiting_first_tick' }, paid: 1000n };
      }
      if (dest.endsWith('.charter-status')) {
        const id = req.path.split('/')[2]!;
        return { status: 200, body: { lease: { ...lease(), id } }, paid: 100n };
      }
      const { leaseId, index } = req.body as { leaseId: string; index: number };
      if (leaseId === LEASE_1 && index === 0) await new Promise<void>((r) => held.set(leaseId, r));
      return { status: 200, body: { paidIntervals: index + 1, paidThrough: 31_000, duplicate: false }, paid: 5000n };
    },
  };
  const queue = payerMod.serialized(inner, { now: () => clock.t, setTimer: () => ({}), clearTimer: () => undefined });
  const d = await start(fakeHost(), {
    now: () => clock.t,
    api: (o) => {
      const a = hostApi(queue, o);
      // Each tick is a status read for the tick, then the tick: both are counted as they reach the queue.
      return { ...a, status: (...args) => (args[1]?.priority === 'high' && queuedTicks++, a.status(...args)), tick: (...args) => (queuedTicks++, a.tick(...args)) };
    },
  });
  return { d, clock, sends, held, queuedTicks: () => queuedTicks };
}

test('R4: a tick whose deadline passes while queued behind another send is skipped: 503 retry_later, no host call, no loss, nothing settled', async () => {
  const q = await queuedDoor();
  const { d, clock } = q;
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const t = clock.t / 1000;
    const first = d.post(`/v1/leases/${LEASE_1}/ticks`, { index: 0 }, { 'payment-signature': pay('0xd1', '0xd1', 0, { validBefore: String(t + 600) }) });
    while (!q.held.has(LEASE_1)) await new Promise((r) => setTimeout(r, 2));
    // Lease 2's authorization is good for 110 s: its sends must start by 95 s from now.
    const second = d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xd2', '0xd2', 0, { validBefore: String(t + 110) }) });
    while (q.queuedTicks() < 3) await new Promise((r) => setTimeout(r, 2));
    clock.t += 95_000;
    q.held.get(LEASE_1)!();
    assert.equal((await first).status, 200);
    const r = await second;
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'retry_later' });

    const ticks = q.sends.filter((s) => s.dest.endsWith('.charter-tick'));
    assert.equal(ticks.length, 1, 'the skipped tick never reached the payer');
    assert.equal(ticks[0]!.opts.deadline, (t + 600) * 1000 - 15_000, 'a tick send carries validBefore minus 15 s');
    assert.deepEqual(d.settled.map((s) => s.leaseId), [LEASE_1], 'nothing settled for the skipped tick');
    const rec = d.ledger.get(LEASE_2)!;
    assert.equal(rec.losses, 0n);
    assert.equal(rec.ticksPaidToHost, 0);
    assert.equal(rec.ticksPaidByRenter, 0);
    assert.equal(rec.stopped, false);

    // The renter retries the same index with a fresh authorization.
    const t2 = clock.t / 1000;
    const retry = await d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xd2', '0xd3', 0, { validBefore: String(t2 + 120) }) });
    assert.equal(retry.status, 200);
    assert.equal(d.ledger.get(LEASE_2)!.ticksPaidByRenter, 1);
  } finally {
    d.close();
  }
});

test('R4: the 31st tick POST in a minute from one IP answers 429 before the gate, and the window slides', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
    for (let i = 0; i < 29; i++) assert.equal((await d.post(`/v1/leases/${'b'.repeat(32)}/ticks`, { index: 0 })).status, 404);
    const gated = d.gate.length;
    host.calls.length = 0;
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 1 });
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'rate_limited' });
    assert.equal(d.gate.length, gated);
    assert.deepEqual(host.calls, []);
    d.clock.t += 60_001;
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 1 })).status, 200);
  } finally {
    d.close();
  }
});

// ---------------------------------------------------------------------------
// Final review fixes

test('F-C1: only offers from CHARTER_DOOR_HOSTS (pubkey and ilpBase both) are listed or opened', async () => {
  const otherHost: Offer = { ...OFFER, hostPubkey: 'cd'.repeat(32) };
  const otherBase: Offer = { ...OFFER, id: 'o2', ilpBase: 'g.elsewhere' };
  const host = fakeHost();
  const d = await start(host, { offers: async () => [OFFER, otherHost, otherBase] });
  try {
    const list = (await (await d.get('/v1/offers')).json()) as Array<{ offerId: string }>;
    assert.deepEqual(list.map((o) => o.offerId), [OFFER_ID]);
    for (const offerId of [`${otherHost.hostPubkey}:${otherHost.id}`, `${OFFER.hostPubkey}:o2`]) {
      const r = await d.post('/v1/leases', { offerId, urls: URLS });
      assert.equal(r.status, 404, offerId);
    }
    assert.deepEqual(host.calls, [], 'an offer the door does not trust is never paid');
  } finally {
    d.close();
  }
});

test('F-C1: an offer priced over the door maxima (open 10000, status 1000, tick 50000) is neither listed nor opened', async () => {
  for (const over of [{ openPrice: 10_001n }, { statusPrice: 1_001n }, { tickPrice: 50_001n }]) {
    const host = fakeHost();
    const d = await start(host, { offers: async () => [{ ...OFFER, ...over }] });
    try {
      assert.deepEqual(await (await d.get('/v1/offers')).json(), [], JSON.stringify(over, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
      assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 404);
      assert.deepEqual(host.calls, []);
    } finally {
      d.close();
    }
  }
  const atMax = await start(fakeHost(), { offers: async () => [{ ...OFFER, openPrice: 10_000n, statusPrice: 1_000n, tickPrice: 50_000n }] });
  try {
    assert.equal(((await (await atMax.get('/v1/offers')).json()) as unknown[]).length, 1);
    assert.equal((await atMax.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 200);
  } finally {
    atMax.close();
  }
});

test('F-I1: POST routes refuse any content-type but application/json with 415, before any host call or gate', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS }, { 'content-type': type });
      assert.equal(r.status, 415, String(type));
      assert.deepEqual(await r.json(), { error: 'unsupported_media_type' });
    }
    assert.deepEqual(host.calls, []);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS }, { 'content-type': 'application/json; charset=utf-8' })).status, 200);
    const t = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'content-type': 'text/plain' });
    assert.equal(t.status, 415);
    assert.deepEqual(d.gate, []);
  } finally {
    d.close();
  }
});

test('F-I1: at most 30 opens an hour across all IPs; the 31st answers 503 capacity with no host call, and the window slides', async () => {
  let n = 0;
  const host = fakeHost({ open: async () => ({ leaseId: (++n).toString(16).padStart(32, '0'), state: 'awaiting_first_tick' }) });
  const d = await start(host, { trustProxy: true });
  try {
    for (let i = 0; i < 30; i++) {
      const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS }, { 'x-forwarded-for': `10.0.${i % 5}.1` });
      assert.equal(r.status, 200, `open ${i}`);
    }
    const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS }, { 'x-forwarded-for': '10.9.9.9' });
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: 'capacity' });
    assert.equal(n, 30);
    d.clock.t += 3_600_001;
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS }, { 'x-forwarded-for': '10.9.9.9' })).status, 200);
  } finally {
    d.close();
  }
});

test('F-I1: door spend no renter paid for (opens, reads, losses) is counted per UTC day and kept across a restart', async () => {
  const host = fakeHost({}, new HostError(500, 'internal'), { open: 1000n, status: 100n });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(d.ledger.unpaidToday(d.clock.t), 1000n, 'the open');
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(d.ledger.unpaidToday(d.clock.t), 1100n, 'a free read');
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 502);
    assert.equal(d.ledger.unpaidToday(d.clock.t), 1100n + 100n + 5000n, 'the read before the tick, and the lost tick');
    assert.equal(new DoorLedger(join(d.dir, 'ledger.json')).unpaidToday(d.clock.t), 6200n);
    assert.equal(d.ledger.unpaidToday(d.clock.t + 86_400_000), 0n, 'a new UTC day starts at zero');
  } finally {
    d.close();
  }
});

test('F-I1: past 500000 micro-USDC of unpaid spend in a UTC day, opens, ticks and uncached reads answer 503 capacity', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.get(`/v1/leases/${LEASE}`);
    d.ledger.addUnpaid(500_000n, d.clock.t);
    host.calls.length = 0;
    const open = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(open.status, 503);
    assert.deepEqual(await open.json(), { error: 'capacity' });
    const tick = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(tick.status, 503);
    assert.deepEqual(await tick.json(), { error: 'capacity' });
    assert.deepEqual(d.gate, [], 'refused before the payment gate');
    d.clock.t += 6_000;
    const st = await d.get(`/v1/leases/${LEASE}`);
    assert.equal(st.status, 200, 'a cached status is still served');
    assert.equal((await d.get(`/v1/leases/${LEASE}/output/0`)).status, 404);
    assert.deepEqual(host.calls, [], 'no host call past the cap');
    // The next UTC day.
    d.clock.t += 86_400_000;
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
  } finally {
    d.close();
  }
  const fresh = await start(fakeHost());
  try {
    await fresh.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    fresh.ledger.addUnpaid(500_000n, fresh.clock.t);
    const r = await fresh.get(`/v1/leases/${LEASE}`);
    assert.equal(r.status, 503, 'nothing cached to serve');
    assert.deepEqual(await r.json(), { error: 'capacity' });
  } finally {
    fresh.close();
  }
});

test('F-I3: after the payment verifies the door reads the status fresh; a lease that just finished gets 409 and no host tick, no settle, no loss', async () => {
  for (const [state, error] of [['done', 'lease_done'], ['closed', 'not_running']] as const) {
    let now: 'running' | typeof state = 'running';
    const host = fakeHost({ status: async () => lease({ state: now }) });
    const d = await start(host);
    try {
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      await d.get(`/v1/leases/${LEASE}`);
      now = state; // the job finished inside the door's 5 s status cache
      host.calls.length = 0;
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xf1', `0x${state === 'done' ? 'f1' : 'f2'}`) });
      assert.equal(r.status, 409, state);
      assert.deepEqual(await r.json(), { error });
      assert.equal(d.gate.length, 1, 'the payment verified');
      assert.deepEqual(host.calls, ['status:tick'], 'one fresh read, no host tick');
      assert.deepEqual(d.settled, []);
      const rec = d.ledger.get(LEASE)!;
      assert.equal(rec.losses, 0n);
      assert.equal(rec.stopped, false);
      assert.equal(rec.ticksPaidToHost, 0);
    } finally {
      d.close();
    }
  }
});

test('F-I3: a tick reads the status once, fresh, even with a fresh cached status, then pays the host; a failed read pays no tick', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
    assert.deepEqual(host.calls, ['open', 'status', 'status:tick', 'tick:0']);
  } finally {
    d.close();
  }
  const broken = fakeHost({ status: async () => { throw new HostError(500, 'internal'); } });
  const d2 = await start(broken);
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d2.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(r.status, 502);
    assert.ok(!broken.calls.some((c) => c.startsWith('tick:')));
    assert.deepEqual(d2.settled, []);
    assert.equal(d2.ledger.get(LEASE)!.losses, 0n);
  } finally {
    d2.close();
  }
});

test('minor: a host tick answer with duplicate: true is 409 duplicate, nothing settles, and the door books the loss and stops the lease', async () => {
  const host = fakeHost({ tick: async (_id, index) => (host.calls.push(`tick:${index}`), { paidIntervals: 1, paidThrough: 31_000, duplicate: true }) });
  const d = await start(host, { api: () => ({ ...host.api, spent: (() => { let n = 0n; return () => (n += 5000n) - 5000n; })() }) });
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'duplicate' });
    assert.deepEqual(d.settled, []);
    const rec = d.ledger.get(LEASE)!;
    assert.equal(rec.ticksPaidByRenter, 0);
    assert.equal(rec.stopped, true);
    assert.equal(rec.lossKind, 'host_refused');
  } finally {
    d.close();
  }
});

test('F-I4: a tick is refused 503 retry_later after verify, with no host call, when the channel headroom is under tickPrice + 10000', async () => {
  for (const [headroom, status] of [[14_999n, 503], [undefined, 503], ['throws', 503], [15_000n, 200]] as const) {
    const host = fakeHost();
    // Enough for the open; the case's headroom from the tick on.
    let opened = false;
    const d = await start(host, {
      headroom: async () => {
        if (!opened) return 1_000_000n;
        if (headroom === 'throws') throw new Error('describe failed');
        return headroom;
      },
    });
    try {
      await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      opened = true;
      host.calls.length = 0;
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
      assert.equal(r.status, status, String(headroom));
      if (status === 503) {
        assert.deepEqual(await r.json(), { error: 'retry_later' });
        assert.deepEqual(host.calls, []);
        assert.deepEqual(d.settled, []);
        assert.equal(d.ledger.get(LEASE)!.losses, 0n);
        assert.equal(d.ledger.get(LEASE)!.stopped, false);
      }
    } finally {
      d.close();
    }
  }
});

test('Task 11: an open is refused 503 capacity, with no host call, when the channel headroom is under openPrice + tickPrice + 10000', async () => {
  for (const [headroom, status] of [[15_999n, 503], [undefined, 503], ['throws', 503], [16_000n, 200]] as const) {
    const host = fakeHost();
    const d = await start(host, {
      headroom: async () => {
        if (headroom === 'throws') throw new Error('describe failed');
        return headroom;
      },
    });
    try {
      const r = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      assert.equal(r.status, status, String(headroom));
      if (status === 503) {
        assert.deepEqual(await r.json(), { error: 'capacity' });
        assert.deepEqual(host.calls, []);
        assert.equal(d.ledger.get(LEASE), undefined);
      }
    } finally {
      d.close();
    }
  }
});

test('Task 11: with no open channel, a refused open starts reopen at most once a minute, unawaited; low but known headroom never does', async () => {
  const clock = { t: 1_000_000 };
  let reopens = 0;
  let headroom: bigint | undefined;
  const host = fakeHost();
  const d = await start(host, { now: () => clock.t, headroom: async () => headroom, reopen: () => (reopens++, new Promise<void>(() => undefined)) });
  try {
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 503);
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 503);
    assert.equal(reopens, 1, 'one reopen a minute, and the hung one did not hold the request');
    clock.t += 60_000;
    headroom = 100n;
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 503);
    assert.equal(reopens, 1, 'a channel that is open but low is rotated by hand, not reopened');
    headroom = undefined;
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS })).status, 503);
    assert.equal(reopens, 2);
    assert.deepEqual(host.calls, []);
  } finally {
    d.close();
  }
});
