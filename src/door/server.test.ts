import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HostError, hostApi, type HostApi, type OpenResult, type OutputPart, type TickResult } from '../tenant/host-api.js';
import { OFFER } from '../tenant/test-host.js';
import type { Lease, Micro, Offer } from '../types.js';
import { DoorLedger } from './ledger.js';
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
function fakeHost(over: Partial<HostApi> = {}, tickFailure?: Error | ((n: number) => Error | undefined)) {
  let tickCount = 0;
  const calls: string[] = [];
  let spent: Micro = 0n;
  const opened: Array<{ image: string; args: Record<string, string> }> = [];
  const api: HostApi = {
    open: async (job): Promise<OpenResult> => (calls.push('open'), opened.push(job), { leaseId: LEASE, state: 'awaiting_first_tick' }),
    tick: async (_id, index): Promise<TickResult> => {
      calls.push(`tick:${index}`);
      const tickFail = typeof tickFailure === 'function' ? tickFailure(++tickCount) : tickFailure;
      // As hostApi: a packet the host answered is paid even when the answer is an error.
      if (tickFail instanceof HostError) spent += 5000n;
      if (tickFail) throw tickFail;
      spent += 5000n;
      return { paidIntervals: index + 1, paidThrough: 31_000, duplicate: false };
    },
    status: async () => (calls.push('status'), lease()),
    output: async () => Buffer.alloc(0),
    outputPart: async (_id, part): Promise<OutputPart> => (calls.push(`part:${part}`), { part, parts: 2, data: Buffer.from(`p${part}`).toString('base64') }),
    spent: (): Micro => spent,
    ...over,
  };
  // Overridden reads are counted too.
  const { status, outputPart } = api;
  if (over.status) api.status = async (id) => (calls.push('status'), status(id));
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
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
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
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
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

test('C1: a done lease is served from its cached final status with no further host calls', async () => {
  for (const state of ['done', 'closed'] as const) {
    const host = fakeHost({ status: async () => lease({ state }) });
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

test('C1: host reads per lease are capped at 20 + 4 per renter tick; past it the last status is served and uncached output is 429', async () => {
  const host = fakeHost({ status: async () => lease({ outputParts: 2 }) });
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    for (let i = 0; i < 40; i++) {
      const r = await d.get(`/v1/leases/${LEASE}`);
      assert.equal(r.status, 200, `get ${i}`);
      d.clock.t += 6_000;
    }
    assert.equal(host.calls.filter((c) => c === 'status').length, 20);
    assert.equal((await d.get(`/v1/leases/${LEASE}/output/0`)).status, 429);
    assert.equal(host.calls.filter((c) => c.startsWith('part:')).length, 0);
    // One renter tick settled buys four more reads.
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 })).status, 200);
    d.clock.t += 6_000;
    await d.get(`/v1/leases/${LEASE}`);
    assert.equal(host.calls.filter((c) => c === 'status').length, 21);
    assert.equal(d.ledger.get(LEASE)!.hostReads, 21);
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

test('CORS: GETs and POST /v1/leases* are open and the x402 headers are exposed; preflight answers 204', async () => {
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
    const open = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(open.headers.get('access-control-allow-origin'), '*');
    assert.ok((open.headers.get('access-control-expose-headers') ?? '').toLowerCase().includes('payment-required'));
    const tick = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 });
    assert.equal(tick.headers.get('access-control-allow-origin'), '*');
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

test('DoorLedger: JSON file, bigint losses, atomic writes, reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'sub', 'ledger.json');
  const l = new DoorLedger(file);
  l.open({ leaseId: LEASE, offerId: OFFER_ID, createdAt: 5 });
  l.renterTick(LEASE, '0xpayer');
  l.hostTick(LEASE);
  l.loss(LEASE, 5000n, 'settle_failed', 7);
  l.stop(LEASE);
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['ledger.json'], 'no temp file left behind');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.ok(JSON.stringify(raw).includes('"5000"'), 'bigint stored as a string');
  const again = new DoorLedger(file);
  assert.deepEqual(again.get(LEASE), {
    leaseId: LEASE, offerId: OFFER_ID, payer: '0xpayer', ticksPaidByRenter: 1, ticksPaidToHost: 1, losses: 5000n, lossKind: 'settle_failed', lossAt: 7, stopped: true, createdAt: 5, nextIndex: 1, hostReads: 0,
  });
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
      { validBefore: String(now + 100) }, // under maxTimeoutSeconds (120) minus 10
      { validBefore: String(now - 1) },
      { validAfter: String(now + 100) }, // not valid yet
    ]) {
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xcc1', '0xf2', 0, window) });
      assert.equal(r.status, 400, JSON.stringify(window));
      assert.deepEqual(await r.json(), { error: 'authorization_window' });
    }
    assert.deepEqual(d.gate, []);
    assert.deepEqual(host.calls, []);
    // The boundary and the usual client shape (valid from 10 minutes ago, 120 s to run) pass.
    assert.equal((await d.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xcc1', '0xf3', 0, { validBefore: String(now + 110), validAfter: String(now) }) })).status, 200);
  } finally {
    d.close();
  }
  const d2 = await start(fakeHost());
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const now = nowSeconds();
    assert.equal((await d2.post(`/v1/leases/${LEASE}/ticks`, { index: 0 }, { 'payment-signature': pay('0xcc2', '0xf4', 0, { validAfter: String(now - 600), validBefore: String(now + 120) }) })).status, 200);
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
      return { ...a, tick: (...args) => (queuedTicks++, a.tick(...args)) };
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
    // Lease 2's authorization is good for 110 s: its send must start by 95 s from now.
    const second = d.post(`/v1/leases/${LEASE_2}/ticks`, { index: 0 }, { 'payment-signature': pay('0xd2', '0xd2', 0, { validBefore: String(t + 110) }) });
    while (q.queuedTicks() < 2) await new Promise((r) => setTimeout(r, 2));
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
