import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { HostError, type HostApi, type OpenResult, type OutputPart, type TickResult } from '../tenant/host-api.js';
import { OFFER } from '../tenant/test-host.js';
import type { Lease, Micro, Offer } from '../types.js';
import { DoorLedger } from './ledger.js';
import { doorApp, type DoorDeps } from './server.js';

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
function fakeHost(over: Partial<HostApi> = {}, tickFail?: Error) {
  const calls: string[] = [];
  let spent: Micro = 0n;
  const opened: Array<{ image: string; args: Record<string, string> }> = [];
  const api: HostApi = {
    open: async (job): Promise<OpenResult> => (calls.push('open'), opened.push(job), { leaseId: LEASE, state: 'awaiting_first_tick' }),
    tick: async (_id, index): Promise<TickResult> => {
      calls.push(`tick:${index}`);
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
      const r = await d.post(`/v1/leases/${LEASE}/ticks`, { index: 3 });
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

test('output parts are proxied as the host answers them; a host 409 unpaid passes through; a bad part is 404', async () => {
  const host = fakeHost();
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
  const d2 = await start(fakeHost({ outputPart: async () => { throw new HostError(409, 'unpaid'); } }));
  try {
    await d2.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    const r = await d2.get(`/v1/leases/${LEASE}/output/0`);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'unpaid' });
  } finally {
    d2.close();
  }
});

test('output parts are cached so a free route cannot be made to spend the door dry', async () => {
  const host = fakeHost();
  const d = await start(host);
  try {
    await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    await d.get(`/v1/leases/${LEASE}/output/0`);
    await d.get(`/v1/leases/${LEASE}/output/0`);
    assert.equal(host.calls.filter((c) => c === 'part:0').length, 1);
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
  l.loss(LEASE, 5000n);
  l.stop(LEASE);
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['ledger.json'], 'no temp file left behind');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.ok(JSON.stringify(raw).includes('"5000"'), 'bigint stored as a string');
  const again = new DoorLedger(file);
  assert.deepEqual(again.get(LEASE), {
    leaseId: LEASE, offerId: OFFER_ID, payer: '0xpayer', ticksPaidByRenter: 1, ticksPaidToHost: 1, losses: 5000n, stopped: true, createdAt: 5,
  });
  assert.equal(again.get('missing'), undefined);
});
