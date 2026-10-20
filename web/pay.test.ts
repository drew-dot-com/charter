import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lease } from '../src/types.js';
import { BASE_USDC } from './wallet.js';
import { applyStatus, newTickState, runTick, type TickDeps, type TickState } from './ticker.js';
import { batchState, makePost, type PayDeps } from './pay.js';
import type { PublicOffer } from './format.js';
import { account, fakeWallet } from './test-wallet.js';

const PAY_TO = '0x' + '2'.repeat(40);
const LEASE_ID = 'a'.repeat(32);
const OFFER: PublicOffer = { offerId: `${'ab'.repeat(32)}:o1`, cpu: 1, memoryMiB: 1024, intervalSeconds: 30, tickPrice: '5000', hiddenHost: true };
const ACCEPT = { scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount: '5000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };

/** A door as the page sees it: a 402 challenge on an unpaid tick, 200 once a payment signature comes. */
function fakeDoor(accept: object = ACCEPT) {
  const requests: string[] = [];
  let paid = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(`${req.method} ${new URL(req.url).pathname}`);
    if (new URL(req.url).pathname === '/v1/offers') return Response.json([]);
    if (req.headers.get('payment-signature')) {
      paid++;
      return Response.json({ paidIntervals: 1, paidThrough: 130_000, duplicate: false });
    }
    if (req.headers.has('x-dev')) return Response.json({ paidIntervals: 1, paidThrough: 130_000, duplicate: false });
    const required = { x402Version: 2, resource: { url: req.url }, accepts: [accept] };
    return new Response('{}', { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') } });
  }) as typeof fetch;
  return { f, requests, paid: () => paid };
}

function setup(over: Partial<PayDeps> = {}, door = fakeDoor()) {
  const signed: string[] = [];
  const pay: PayDeps = {
    leaseId: LEASE_ID,
    origin: 'http://door.test',
    dev: false,
    wallet: { address: account.address, eth: fakeWallet(signed) },
    fetch: door.f,
    door: async () => ({ payTo: PAY_TO, network: 'eip155:8453' }),
    offer: () => OFFER,
    ...over,
  };
  const s: TickState = newTickState();
  applyStatus(s, { id: LEASE_ID, offerId: 'o1', job: { image: 'charter-job-fetch', args: {} }, state: 'awaiting_first_tick', createdAt: 0, paidIntervals: 0 } as Lease);
  const deps: TickDeps = {
    post: makePost(pay),
    refresh: async () => {},
    requestPoll: () => {},
    sleep: async () => {},
    now: () => 100_000,
    alive: () => true,
  };
  return { s, deps, signed, door };
}

test('the lease page keeps ticking after its offer has gone from /v1/offers: the price comes from the lease status', async () => {
  const t = setup();
  await runTick(t.s, t.deps);
  assert.equal(t.s.halt, undefined);
  assert.equal(t.s.lease?.paidIntervals, 1);
  assert.deepEqual(t.signed, ['eth_signTypedData_v4']);
  assert.equal(t.door.paid(), 1);
  assert.ok(!t.door.requests.some((r) => r.includes('/v1/offers')), 'the offers list is never consulted');
});

test('a failure to load /v1/door gives the retryable "Could not confirm the price" halt, and nothing is signed or sent', async () => {
  const t = setup({ door: async () => undefined });
  await runTick(t.s, t.deps);
  assert.match(t.s.halt?.message ?? '', /Could not confirm the price/);
  assert.doesNotMatch(t.s.halt?.message ?? '', /Unexpected payment request/);
  assert.equal(t.s.halt?.retry, true);
  assert.deepEqual(t.signed, []);
  assert.deepEqual(t.door.requests, []);
});

test('a lease status that carries no offer gives the same retryable halt', async () => {
  const t = setup({ offer: () => undefined });
  await runTick(t.s, t.deps);
  assert.match(t.s.halt?.message ?? '', /Could not confirm the price/);
  assert.equal(t.s.halt?.retry, true);
  assert.deepEqual(t.signed, []);
});

test('a 402 that does not match the price, the asset, the payee or the network still gives the security halt', async () => {
  for (const bad of [{ amount: '5001' }, { asset: '0x' + '9'.repeat(40) }, { payTo: '0x' + '3'.repeat(40) }, { network: 'eip155:1' }]) {
    const t = setup({}, fakeDoor({ ...ACCEPT, ...bad }));
    await runTick(t.s, t.deps);
    assert.match(t.s.halt?.message ?? '', /Unexpected payment request/, JSON.stringify(bad));
    assert.equal(t.s.halt?.retry, false);
    assert.deepEqual(t.signed, []);
  }
});

test('a door that names a network other than Base is the security halt too', async () => {
  const t = setup({ door: async () => ({ payTo: PAY_TO, network: 'eip155:1' }) });
  await runTick(t.s, t.deps);
  assert.match(t.s.halt?.message ?? '', /Unexpected payment request/);
  assert.equal(t.s.halt?.retry, false);
});

test('local test mode posts the tick with the plain fetch: no wallet, no door lookup', async () => {
  const door = fakeDoor();
  const t = setup({ dev: true, wallet: undefined, door: async () => { throw new Error('not asked'); }, offer: () => undefined, fetch: ((u: RequestInfo | URL, i?: RequestInit) => door.f(u, { ...i, headers: { ...(i?.headers as object), 'x-dev': '1' } })) as typeof fetch }, door);
  await runTick(t.s, t.deps);
  assert.equal(t.s.halt, undefined);
  assert.equal(t.s.lease?.paidIntervals, 1);
});

// ---------------------------------------------------------------------------
// batch-settlement from the lease page: a channel per wallet, exact as the fallback.

const RECEIVER_AUTHORIZER = '0x' + 'd'.repeat(40);
const BATCH_ACCEPT = { ...ACCEPT, scheme: 'batch-settlement', extra: { name: 'USD Coin', version: '2', receiverAuthorizer: RECEIVER_AUTHORIZER, withdrawDelay: 3600 } };

function memoryStore(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) };
}

/** A door offering both schemes that refuses batch payments with a 402 (the facilitator would not take the deposit). */
function batchRefusingDoor() {
  const payloads: Array<Record<string, unknown>> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = req.headers.get('payment-signature');
    const required = { x402Version: 2, resource: { url: req.url }, accepts: [BATCH_ACCEPT, ACCEPT] };
    const challenge = () => new Response('{}', { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') } });
    if (!h) return challenge();
    const p = JSON.parse(Buffer.from(h, 'base64').toString()) as { payload: Record<string, unknown> };
    payloads.push(p.payload);
    if (p.payload.type === 'deposit' || p.payload.type === 'voucher') return challenge();
    return Response.json({ paidIntervals: 1, paidThrough: 130_000, duplicate: false });
  }) as typeof fetch;
  return { f, payloads };
}

test('a 402 to a batch payment turns batch off for this page: the retry pays exact, and nothing is lost but one prompt', async () => {
  batchState.disabled = false;
  const door = batchRefusingDoor();
  const signed: string[] = [];
  const post = makePost({
    leaseId: LEASE_ID, origin: 'http://door.test', dev: false, wallet: { address: account.address, eth: fakeWallet(signed) }, fetch: door.f,
    door: async () => ({ payTo: PAY_TO, network: 'eip155:8453' }), offer: () => OFFER, store: memoryStore(),
  });
  const first = await post(0);
  assert.equal(first.status, 402);
  assert.equal(door.payloads[0]!.type, 'deposit', 'batch was tried first');
  assert.equal(batchState.disabled, true);
  const second = await post(0);
  assert.equal(second.status, 200);
  assert.ok('authorization' in door.payloads[1]!, 'the retry is an exact authorization');
  assert.deepEqual(signed, ['eth_signTypedData_v4', 'eth_signTypedData_v4']);
  batchState.disabled = false;
});

test('with a store, ticks go out as batch vouchers after one deposit; without one (storage denied), as exact', async () => {
  batchState.disabled = false;
  const store = memoryStore();
  const payloads: Array<Record<string, unknown>> = [];
  let charged = 0n;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const h = req.headers.get('payment-signature');
    if (!h) {
      const required = { x402Version: 2, resource: { url: req.url }, accepts: [BATCH_ACCEPT, ACCEPT] };
      return new Response('{}', { status: 402, headers: { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') } });
    }
    payloads.push((JSON.parse(Buffer.from(h, 'base64').toString()) as { payload: Record<string, unknown> }).payload);
    charged += 5000n;
    const response = Buffer.from(JSON.stringify({ success: true, transaction: '', network: 'eip155:8453', payer: account.address, extra: { chargedAmount: '5000', channelState: { chargedCumulativeAmount: charged.toString() } } })).toString('base64');
    return new Response(JSON.stringify({ paidIntervals: 1, paidThrough: 130_000, duplicate: false }), { status: 200, headers: { 'content-type': 'application/json', 'PAYMENT-RESPONSE': response } });
  }) as typeof fetch;
  const signed: string[] = [];
  const deps = { leaseId: LEASE_ID, origin: 'http://door.test', dev: false, wallet: { address: account.address, eth: fakeWallet(signed) }, fetch: f, door: async () => ({ payTo: PAY_TO, network: 'eip155:8453' }), offer: () => OFFER };
  const post = makePost({ ...deps, store });
  assert.equal((await post(0)).status, 200);
  assert.equal((await post(1)).status, 200);
  assert.deepEqual(payloads.map((p) => p.type), ['deposit', 'voucher']);
  assert.deepEqual(signed, ['eth_signTypedData_v4'], 'one prompt for two ticks');
  const noStore = makePost({ ...deps, store: undefined });
  assert.equal((await noStore(2)).status, 200);
  assert.ok('authorization' in payloads[2]!, 'no store, no channel: exact');
});
