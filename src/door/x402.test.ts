// The payment gate against a stub facilitator: the real @x402/express middleware, the real batch-settlement
// and exact schemes, and an http server in this file standing in for the facilitator's /supported, /verify
// and /settle. Nothing here touches a chain, a wallet or the network.
//
// What a stub facilitator cannot drive, and so is not tested here: whether an EIP-3009 authorization would
// actually move USDC (the facilitator's verify and settle are answered by the script below, not by Base),
// the on-chain claim of a batch of vouchers (BatchSettlementChannelManager, run by the door's claim timers),
// and a deposit payload, whose verify reads the channel from chain through the facilitator. The second
// voucher on a channel IS verified for real: the scheme checks its EIP-712 signature locally with viem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Response } from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { BATCH_SETTLEMENT_ADDRESS, voucherTypes } from '@x402/evm';
import { OFFER } from '../tenant/test-host.js';
import type { HostApi, OpenResult, OutputPart, TickResult } from '../tenant/host-api.js';
import type { Lease, Micro } from '../types.js';
import { DoorLedger } from './ledger.js';
import { doorApp, type DoorDeps } from './server.js';
import {
  BASE_USDC,
  MAX_TIMEOUT_SECONDS,
  MIN_WINDOW_SECONDS,
  WITHDRAW_DELAY_SECONDS,
  buildSchemes,
  facilitatorOffersBatch,
  isPayerFault,
  microToUsdc,
  paymentIdOf,
  realGate,
  settleReasonOf,
  type X402Config,
} from './x402.js';

const NETWORK = 'eip155:8453';
const PAY_TO = '0x' + '2'.repeat(40);
const CLAIM_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const CLAIM_ADDRESS = privateKeyToAccount(CLAIM_KEY).address;
const LEASE = 'a'.repeat(32);
const OFFER_ID = `${OFFER.hostPubkey}:${OFFER.id}`;
const URLS = ['https://example.com/a'];
const TX = '0x' + '1'.repeat(64);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, 'base64').toString()) as T;
const pad = (s: string, n: number) => '0x' + s.replace(/^0x/i, '').toLowerCase().padStart(n, '0');

interface Accepts {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}
interface Required {
  x402Version: number;
  error?: string;
  resource: unknown;
  accepts: Accepts[];
}

// ---------------------------------------------------------------------------
// The stub facilitator

type VerifyAnswer = { isValid: boolean; invalidReason?: string; payer?: string; extra?: Record<string, unknown> };
type SettleAnswer = { success: boolean; errorReason?: string; transaction: string; network: string; payer?: string };
/** A raw answer: an HTTP status and a body that is not JSON, as a facilitator that is down behind a proxy. */
type Raw = { raw: true; status: number; text: string };

interface Facilitator {
  url: string;
  /** Every POST, in order: the path and the JSON body the resource server sent. */
  calls: Array<{ path: string; body: { x402Version: number; paymentPayload: Record<string, unknown>; paymentRequirements: Accepts } }>;
  verify: (body: Facilitator['calls'][number]['body']) => VerifyAnswer | Raw;
  settle: (body: Facilitator['calls'][number]['body']) => SettleAnswer | Raw;
  close: () => void;
}

/** A facilitator that lists exact and (unless `batch` is false) batch-settlement on Base, verifies and settles every payment. */
async function facilitator(opts: { batch?: boolean } = {}): Promise<Facilitator> {
  const kinds: object[] = [{ x402Version: 2, scheme: 'exact', network: NETWORK }];
  if (opts.batch !== false) kinds.push({ x402Version: 2, scheme: 'batch-settlement', network: NETWORK, extra: { experimental: true } });
  const f: Facilitator = {
    url: '',
    calls: [],
    verify: (b) => ({ isValid: true, payer: payerOf(b.paymentPayload) }),
    settle: (b) => ({ success: true, transaction: TX, network: NETWORK, payer: payerOf(b.paymentPayload) }),
    close: () => undefined,
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      if (req.method === 'GET' && path.startsWith('/supported')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ kinds, extensions: [], signers: {} }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Facilitator['calls'][number]['body'];
      f.calls.push({ path, body });
      const answer = path.startsWith('/verify') ? f.verify(body) : path.startsWith('/settle') ? f.settle(body) : undefined;
      if (answer === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return void res.end('{}');
      }
      if ('raw' in answer) {
        res.writeHead(answer.status, { 'content-type': 'text/plain' });
        return void res.end(answer.text);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => void server.close();
  return f;
}

/** Who a payload says pays: the authorization's `from` for exact, the channel's `payer` for batch. */
function payerOf(payload: Record<string, unknown>): string {
  const p = payload.payload as { authorization?: { from?: string }; channelConfig?: { payer?: string } };
  return (p.authorization?.from ?? p.channelConfig?.payer ?? '').toLowerCase();
}

function config(fac: Facilitator): X402Config {
  return { payTo: PAY_TO, network: NETWORK, facilitatorUrl: fac.url, claimKey: CLAIM_KEY, channelDir: join(mkdtempSync(join(tmpdir(), 'x402-')), 'channels') };
}

// ---------------------------------------------------------------------------
// The door with the real gate, on a scripted host

function fakeHost() {
  const calls: string[] = [];
  let opens = 0;
  const api: HostApi = {
    open: async (): Promise<OpenResult> => (calls.push('open'), { leaseId: (++opens).toString(16).padStart(32, 'a'), state: 'awaiting_first_tick' }),
    tick: async (_id, index): Promise<TickResult> => (calls.push(`tick:${index}`), { paidIntervals: index + 1, paidThrough: Date.now() + 30_000, duplicate: false }),
    status: async (id, opts): Promise<Lease> => (calls.push(opts?.priority === 'high' ? 'status:tick' : 'status'), {
      id, offerId: OFFER.id, job: { image: 'charter-job-fetch', args: { URLS: URLS.join(',') } }, state: 'running', createdAt: 1_000, paidIntervals: 1, paidThrough: Date.now() + 30_000,
    }),
    output: async () => Buffer.alloc(0),
    outputPart: async (_id, part): Promise<OutputPart> => ({ part, parts: 1, data: '' }),
    spent: (): Micro => 0n,
  };
  return { api, calls };
}

/** Lease ids as the fake host hands them out: the first open is LEASE_1, the second LEASE_2. */
const LEASE_1 = '1'.padStart(32, 'a');
const LEASE_2 = '2'.padStart(32, 'a');

async function realDoor(fac: Facilitator, over: Partial<DoorDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'door-'));
  const cfg = config(fac);
  const host = fakeHost();
  const ledger = new DoorLedger(join(dir, 'ledger.json'));
  const app = doorApp({
    offers: async () => [OFFER],
    api: () => host.api,
    hosts: new Map([[OFFER.hostPubkey, OFFER.ilpBase]]),
    ledger,
    x402: cfg,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
    ...over,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const d = {
    cfg, host, ledger, post,
    close: () => void server.close(),
    open: async (): Promise<string> => {
      const r = await post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
      assert.equal(r.status, 200);
      return ((await r.json()) as { leaseId: string }).leaseId;
    },
    /** The 402 challenge for a tick of `leaseId`: what a payment must be built against. */
    challenge: async (leaseId: string): Promise<Required> => {
      const r = await post(`/v1/leases/${leaseId}/ticks`, { index: 0 });
      assert.equal(r.status, 402);
      return unb64<Required>(r.headers.get('payment-required')!);
    },
  };
  return d;
}

/** A PAYMENT-SIGNATURE header for one exact EIP-3009 authorization against the challenge's exact option. */
function exactPayment(required: Required, from: string, nonce: string, window: { validAfter?: number; validBefore?: number } = {}): string {
  const accepted = required.accepts.find((a) => a.scheme === 'exact')!;
  const now = Math.floor(Date.now() / 1000);
  return b64({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: pad(from, 40), to: accepted.payTo, value: accepted.amount,
        validAfter: String(window.validAfter ?? now - 60), validBefore: String(window.validBefore ?? now + MAX_TIMEOUT_SECONDS), nonce: pad(nonce, 64),
      },
    },
  });
}

const paymentResponse = (r: globalThis.Response) => unb64<{ success: boolean; errorReason?: string; transaction?: string }>(r.headers.get('payment-response')!);

// ---------------------------------------------------------------------------
// Pure helpers

test('microToUsdc writes micro-USDC as the six-decimal string x402 prices take', () => {
  assert.equal(microToUsdc(5000n), '0.005000');
  assert.equal(microToUsdc(0n), '0.000000');
  assert.equal(microToUsdc(1_234_567n), '1.234567');
  assert.equal(microToUsdc(1_000_000n), '1.000000');
});

test('paymentIdOf: a malformed header is bad, no header is none, a good exact header is its canonical authorization', () => {
  const req = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as express.Request;
  assert.equal(paymentIdOf(req({})), 'none');
  for (const h of ['not base64!', b64('a string'), b64(null), b64({ x402Version: 2 }), b64({ payload: { authorization: 'nope' } }), b64({ payload: { authorization: { from: '0x1', nonce: '0x2' } } })]) {
    assert.equal(paymentIdOf(req({ 'payment-signature': h })), 'bad', h);
  }
  // A header that decodes but is not JSON, and an array-valued header, are bad too.
  assert.equal(paymentIdOf(req({ 'payment-signature': Buffer.from('{oops').toString('base64') })), 'bad');
  assert.equal(paymentIdOf(req({ 'payment-signature': ['a', 'b'] })), 'bad');
  const auth = { from: pad('0xAB', 40).toUpperCase().replace('0X', '0x'), to: PAY_TO, value: '5000', validAfter: '10', validBefore: '500', nonce: pad('0xCD', 64).toUpperCase().replace('0X', '0x') };
  assert.deepEqual(paymentIdOf(req({ 'x-payment': b64({ x402Version: 2, payload: { signature: '0x', authorization: auth } }) })), {
    kind: 'exact', from: pad('0xab', 40), nonce: pad('0xcd', 64), validAfter: 10, validBefore: 500,
  });
  // A window that is not a plain decimal is bad: a negative, a float, an exponent, a hex.
  for (const validBefore of ['-1', '1.5', '1e9', '0x10', '']) {
    assert.equal(paymentIdOf(req({ 'payment-signature': b64({ payload: { authorization: { ...auth, validBefore } } }) })), 'bad', validBefore);
  }
});

test('settleReasonOf reads errorReason out of PAYMENT-RESPONSE, and is undefined when the header is absent, not base64, or carries no string reason', () => {
  const res = (h: unknown) => ({ getHeader: () => h }) as unknown as Response;
  assert.equal(settleReasonOf(res(b64({ success: false, errorReason: 'invalid_exact_evm_signature' }))), 'invalid_exact_evm_signature');
  assert.equal(settleReasonOf(res(undefined)), undefined);
  assert.equal(settleReasonOf(res(['a'])), undefined);
  assert.equal(settleReasonOf(res('not base64!')), undefined);
  assert.equal(settleReasonOf(res(b64({ success: false, errorReason: 5 }))), undefined);
  assert.equal(settleReasonOf(res(b64({ success: true, transaction: TX }))), undefined);
});

test('isPayerFault: exactly the six codes for no balance, a used nonce and a bad signature; nothing else, and never undefined', () => {
  for (const fault of [
    'invalid_exact_evm_insufficient_balance', 'invalid_exact_evm_nonce_already_used', 'invalid_exact_evm_signature',
    'invalid_batch_settlement_evm_insufficient_balance', 'invalid_batch_settlement_evm_receive_authorization_signature', 'invalid_batch_settlement_evm_voucher_signature',
  ]) assert.equal(isPayerFault(fault), true, fault);
  for (const other of [undefined, '', 'Settlement failed', 'invalid_exact_evm_payload_authorization_valid_before', 'INVALID_EXACT_EVM_SIGNATURE', 'invalid_exact_evm_signature ']) {
    assert.equal(isPayerFault(other), false, String(other));
  }
});

test('facilitatorOffersBatch: true when /supported lists batch-settlement on the network, false on another network only, false when unreachable', async () => {
  const both = await facilitator();
  const exactOnly = await facilitator({ batch: false });
  try {
    assert.equal(await facilitatorOffersBatch(both.url, NETWORK), true);
    assert.equal(await facilitatorOffersBatch(both.url, 'eip155:84532'), false, 'batch on Base says nothing about Base Sepolia');
    assert.equal(await facilitatorOffersBatch(exactOnly.url, NETWORK), false);
  } finally {
    both.close();
    exactOnly.close();
  }
  assert.equal(await facilitatorOffersBatch(both.url, NETWORK), false, 'a facilitator that has gone away counts as no');
  assert.equal(await facilitatorOffersBatch('http://127.0.0.1:1', NETWORK), false);
});

// ---------------------------------------------------------------------------
// The gate on its own: the 402 challenge

/** The real gate on a bare express app, with the handler the door would run after it. */
async function bareGate(fac: Facilitator, offerBatch: boolean) {
  const cfg = config(fac);
  const app = express();
  app.use(express.json());
  app.post('/v1/leases/:id/ticks', realGate(cfg, (id) => (id === LEASE ? 5000n : undefined), buildSchemes(cfg), offerBatch), (_req, res) => void res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    post: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"index":0}' }),
    close: () => void server.close(),
  };
}

test('the 402 challenge: batch-settlement then exact, USDC on Base, the lease price, payTo, 300 s; the batch option carries the claim authorizer and the withdraw delay', async () => {
  const fac = await facilitator();
  const g = await bareGate(fac, true);
  try {
    const r = await g.post(`/v1/leases/${LEASE}/ticks`);
    assert.equal(r.status, 402);
    const required = unb64<Required>(r.headers.get('payment-required')!);
    assert.equal(required.x402Version, 2);
    assert.deepEqual(required.accepts.map((a) => a.scheme), ['batch-settlement', 'exact']);
    for (const a of required.accepts) {
      assert.equal(a.network, NETWORK);
      assert.equal(a.asset, BASE_USDC);
      assert.equal(a.amount, '5000');
      assert.equal(a.payTo.toLowerCase(), PAY_TO);
      assert.equal(a.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    }
    const batch = required.accepts[0]!.extra!;
    assert.equal(batch.receiverAuthorizer, CLAIM_ADDRESS);
    assert.equal(batch.withdrawDelay, WITHDRAW_DELAY_SECONDS);
    const exact = required.accepts[1]!.extra!;
    assert.equal(exact.name, 'USD Coin', 'the EIP-3009 domain of USDC on Base');
    assert.equal(exact.version, '2');
    // The facilitator was asked what it supports, once, and nothing else.
    assert.equal(fac.calls.length, 0);
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'the bare gate sets no CORS; the door does');
  } finally {
    g.close();
    fac.close();
  }
});

test('with offerBatch false the challenge lists exact only, and a lease without a price is a 500, not a free tick', async () => {
  const fac = await facilitator({ batch: false });
  const g = await bareGate(fac, false);
  try {
    const r = await g.post(`/v1/leases/${LEASE}/ticks`);
    assert.equal(r.status, 402);
    assert.deepEqual(unb64<Required>(r.headers.get('payment-required')!).accepts.map((a) => a.scheme), ['exact']);
    // The route guard resolves the lease before the gate, so a missing price is a bug: it must not let the tick through.
    // The middleware logs the error; keep it out of the test output.
    const error = console.error;
    console.error = () => undefined;
    try {
      const missing = await g.post(`/v1/leases/${'b'.repeat(32)}/ticks`);
      assert.equal(missing.status, 500);
    } finally {
      console.error = error;
    }
  } finally {
    g.close();
    fac.close();
  }
});

// ---------------------------------------------------------------------------
// Exact payments through the door

test('an exact payment the facilitator verifies and settles: 200, the host ticked between verify and settle, PAYMENT-RESPONSE carries the transaction, the ledger counts the renter', async () => {
  const fac = await facilitator();
  const d = await realDoor(fac);
  try {
    const id = await d.open();
    assert.equal(id, LEASE_1);
    const required = await d.challenge(id);
    const order: string[] = [];
    fac.verify = (b) => (order.push('verify'), { isValid: true, payer: payerOf(b.paymentPayload) });
    fac.settle = (b) => (order.push('settle'), { success: true, transaction: TX, network: NETWORK, payer: payerOf(b.paymentPayload) });
    const tick = d.host.api.tick;
    d.host.api.tick = (...a) => (order.push('host tick'), tick(...a));
    const r = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(required, '0xabc', '0x01') });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { paidIntervals: number; paidThrough: number; duplicate: boolean };
    assert.equal(body.paidIntervals, 1);
    assert.equal(body.duplicate, false);
    assert.deepEqual(order, ['verify', 'host tick', 'settle'], 'the host is paid only after the payment verified, and settlement waits for the host');
    assert.deepEqual(paymentResponse(r), { success: true, transaction: TX, network: NETWORK, payer: pad('0xabc', 40) });
    // What the facilitator was asked, both times: the same payload, against the exact option for 5000 micro-USDC.
    assert.deepEqual(fac.calls.map((c) => c.path), ['/verify', '/settle']);
    for (const c of fac.calls) {
      assert.equal(c.body.x402Version, 2);
      assert.equal(c.body.paymentRequirements.scheme, 'exact');
      assert.equal(c.body.paymentRequirements.amount, '5000');
      assert.equal(c.body.paymentRequirements.payTo.toLowerCase(), PAY_TO);
      assert.equal((c.body.paymentPayload.payload as { authorization: { nonce: string } }).authorization.nonce, pad('0x01', 64));
    }
    const rec = d.ledger.get(id)!;
    assert.equal(rec.ticksPaidByRenter, 1);
    assert.equal(rec.ticksPaidToHost, 1);
    assert.equal(rec.payer, pad('0xabc', 40));
    assert.equal(rec.losses, 0n);
  } finally {
    d.close();
    fac.close();
  }
});

test('a payment the facilitator refuses: 402 with the reason, no host call, and the payment key is released so the same header verifies on a retry', async () => {
  const fac = await facilitator();
  const d = await realDoor(fac);
  try {
    const id = await d.open();
    const required = await d.challenge(id);
    const header = exactPayment(required, '0xdd1', '0xf5');
    fac.verify = (b) => ({ isValid: false, invalidReason: 'invalid_exact_evm_signature', payer: payerOf(b.paymentPayload) });
    const refused = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': header });
    assert.equal(refused.status, 402);
    assert.equal(unb64<Required>(refused.headers.get('payment-required')!).error, 'invalid_exact_evm_signature');
    assert.equal(d.host.calls.filter((c) => c.startsWith('tick')).length, 0);
    assert.equal(d.host.calls.includes('status:tick'), false, 'nothing is read from the host before the payment verifies');
    assert.deepEqual(fac.calls.map((c) => c.path), ['/verify']);
    const rec = d.ledger.get(id)!;
    assert.equal(rec.ticksPaidByRenter, 0);
    assert.equal(rec.losses, 0n);
    assert.equal(rec.stopped, false, 'a refused payment is not a loss and does not stop the lease');

    // The facilitator is down behind a proxy: a non-JSON 502. Still 402 to the renter, still no host call, key still free.
    fac.verify = () => ({ raw: true, status: 502, text: 'bad gateway' });
    const down = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': header });
    assert.equal(down.status, 402);
    assert.equal(d.host.calls.filter((c) => c.startsWith('tick')).length, 0);

    // Now it verifies: the identical header is not payment_reused, because only a verified key is kept.
    fac.verify = (b) => ({ isValid: true, payer: payerOf(b.paymentPayload) });
    const ok = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': header });
    assert.equal(ok.status, 200, await ok.text());
    assert.deepEqual(fac.calls.map((c) => c.path), ['/verify', '/verify', '/verify', '/settle']);
    // And from here the authorization is spent: the same header on a second lease is 409 before any facilitator call.
    const id2 = await d.open();
    const reused = await d.post(`/v1/leases/${id2}/ticks`, { index: 0 }, { 'payment-signature': header });
    assert.equal(reused.status, 409);
    assert.deepEqual(await reused.json(), { error: 'payment_reused' });
    assert.equal(fac.calls.length, 4);
  } finally {
    d.close();
    fac.close();
  }
});

test('a settlement that fails for the payer\'s own reason is booked settle_failed and blocks the payer; a transient reason is booked transient and does not', async () => {
  for (const [reason, kind, blocks] of [
    ['invalid_exact_evm_insufficient_balance', 'settle_failed', true],
    ['invalid_exact_evm_nonce_already_used', 'settle_failed', true],
    ['invalid_exact_evm_signature', 'settle_failed', true],
    ['invalid_exact_evm_payload_authorization_valid_before', 'settle_failed_transient', false],
    ['invalid_exact_evm_transaction_failed', 'settle_failed_transient', false],
  ] as const) {
    const fac = await facilitator();
    const d = await realDoor(fac);
    try {
      const id = await d.open();
      const required = await d.challenge(id);
      fac.settle = (b) => ({ success: false, errorReason: reason, transaction: '', network: NETWORK, payer: payerOf(b.paymentPayload) });
      const r = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(required, '0xabc', '0x01') });
      assert.equal(r.status, 402, reason);
      assert.equal(paymentResponse(r).errorReason, reason, 'the facilitator\'s reason reaches the renter in PAYMENT-RESPONSE');
      assert.equal(d.host.calls.filter((c) => c.startsWith('tick')).length, 1, 'the host was paid for the tick');
      const rec = d.ledger.get(id)!;
      assert.equal(rec.ticksPaidToHost, 1);
      assert.equal(rec.ticksPaidByRenter, 0);
      assert.equal(rec.losses, 5000n, reason);
      assert.equal(rec.lossKind, kind, reason);
      assert.equal(rec.stopped, true);
      assert.equal(rec.payer, pad('0xabc', 40));
      // The same payer on a new lease, with a payment that verifies: refused only after a payer-fault loss, and before any host call.
      fac.settle = (b) => ({ success: true, transaction: TX, network: NETWORK, payer: payerOf(b.paymentPayload) });
      const id2 = await d.open();
      const before = d.host.calls.length;
      const next = await d.post(`/v1/leases/${id2}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(await d.challenge(id2), '0xabc', '0x02') });
      assert.equal(next.status, blocks ? 403 : 200, reason);
      if (blocks) {
        assert.deepEqual(await next.json(), { error: 'payer_blocked' });
        assert.equal(d.host.calls.length, before);
      }
    } finally {
      d.close();
      fac.close();
    }
  }
});

test('a settle call that gets no usable answer (the facilitator down): 402 with the transport failure as the reason, booked transient, the payer not blocked', async () => {
  const fac = await facilitator();
  const d = await realDoor(fac);
  try {
    const id = await d.open();
    const required = await d.challenge(id);
    fac.settle = () => ({ raw: true, status: 503, text: 'service unavailable' });
    const r = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(required, '0xabc', '0x01') });
    assert.equal(r.status, 402);
    const reason = paymentResponse(r).errorReason;
    assert.match(reason ?? '', /^Facilitator settle failed \(503\)/);
    assert.equal(isPayerFault(reason), false);
    const rec = d.ledger.get(id)!;
    assert.equal(rec.losses, 5000n);
    assert.equal(rec.lossKind, 'settle_failed_transient');
    assert.equal(rec.stopped, true);
    assert.equal(d.ledger.payerHasLoss(pad('0xabc', 40), Date.now()), false);
  } finally {
    d.close();
    fac.close();
  }
});

test('the authorization window is checked before the facilitator is asked: too short, lapsed or not yet valid is 400 authorization_window; the 110 s boundary passes', async () => {
  const fac = await facilitator();
  const d = await realDoor(fac);
  try {
    const id = await d.open();
    const required = await d.challenge(id);
    const now = Math.floor(Date.now() / 1000);
    for (const window of [
      { validBefore: now + MIN_WINDOW_SECONDS - 5 },
      { validBefore: now - 1 },
      { validAfter: now + 30 },
    ]) {
      const r = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(required, '0xabc', '0x01', window) });
      assert.equal(r.status, 400, JSON.stringify(window));
      assert.deepEqual(await r.json(), { error: 'authorization_window' });
    }
    assert.equal(fac.calls.length, 0, 'a payment that cannot outlast verify-to-settle never reaches the facilitator');
    // Right at the boundary, measured a moment later, so add a second of slack.
    const ok = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(required, '0xabc', '0x01', { validBefore: now + MIN_WINDOW_SECONDS + 5 }) });
    assert.equal(ok.status, 200, await ok.text());
    // A payment whose `accepted` names another amount than the challenge matches no requirement: 402, no verify call.
    const cheap = JSON.parse(Buffer.from(exactPayment(required, '0xabc', '0x02'), 'base64').toString()) as { accepted: Accepts };
    cheap.accepted = { ...cheap.accepted, amount: '1' };
    const id2 = await d.open();
    const mismatch = await d.post(`/v1/leases/${id2}/ticks`, { index: 0 }, { 'payment-signature': b64(cheap) });
    assert.equal(mismatch.status, 402);
    assert.equal(unb64<Required>(mismatch.headers.get('payment-required')!).error, 'No matching payment requirements');
    assert.deepEqual(fac.calls.map((c) => c.path), ['/verify', '/settle']);
  } finally {
    d.close();
    fac.close();
  }
});

// ---------------------------------------------------------------------------
// Batch-settlement vouchers through the door

const renter = privateKeyToAccount(('0x' + 'cd'.repeat(32)) as `0x${string}`);
const stranger = privateKeyToAccount(('0x' + 'ef'.repeat(32)) as `0x${string}`);

/** A channel from the renter to the door, as the page's x402 client would configure it against the challenge. */
function channelOf(required: Required) {
  const batch = required.accepts.find((a) => a.scheme === 'batch-settlement')!;
  const channelConfig = {
    payer: renter.address, payerAuthorizer: renter.address, receiver: batch.payTo, receiverAuthorizer: batch.extra!.receiverAuthorizer as string,
    token: batch.asset, withdrawDelay: batch.extra!.withdrawDelay as number, salt: pad('0x5', 64),
  };
  return { accepted: batch, channelConfig, channelId: computeChannelId(channelConfig as never, NETWORK) as string };
}

/** A PAYMENT-SIGNATURE header carrying a cumulative voucher for `maxClaimable` micro-USDC, signed by `signer`. */
async function voucher(required: Required, maxClaimable: bigint, signer = renter): Promise<string> {
  const { accepted, channelConfig, channelId } = channelOf(required);
  const signature = await signer.signTypedData({
    domain: { name: 'x402 Batch Settlement', version: '1', chainId: 8453, verifyingContract: BATCH_SETTLEMENT_ADDRESS },
    types: voucherTypes,
    primaryType: 'Voucher',
    message: { channelId: channelId as `0x${string}`, maxClaimableAmount: maxClaimable },
  });
  return b64({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { type: 'voucher', channelConfig, voucher: { channelId, maxClaimableAmount: maxClaimable.toString(), signature } },
  });
}

const CHANNEL_STATE = { balance: '100000', totalClaimed: '0', withdrawRequestedAt: 0, refundNonce: '0' };

test('vouchers: the first is verified by the facilitator and settled locally; the second is verified locally by its signature; a wrong cumulative amount or a stranger\'s signature is refused before the host', async () => {
  const fac = await facilitator();
  const d = await realDoor(fac, { schemes: undefined });
  try {
    const id = await d.open();
    const required = await d.challenge(id);
    const { channelId } = channelOf(required);
    fac.verify = (b) => ({ isValid: true, payer: payerOf(b.paymentPayload), extra: { channelId, ...CHANNEL_STATE } });

    const first = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': await voucher(required, 5000n) });
    assert.equal(first.status, 200, await first.text());
    assert.deepEqual(fac.calls.map((c) => c.path), ['/verify'], 'a voucher is settled against the channel record, not through the facilitator');
    assert.equal(fac.calls[0]!.body.paymentRequirements.scheme, 'batch-settlement');
    assert.equal(paymentResponse(first).success, true);
    assert.equal(paymentResponse(first).transaction, '', 'nothing is on chain until the claim');
    assert.equal(d.ledger.get(id)!.payer, renter.address.toLowerCase());
    assert.equal(d.ledger.get(id)!.ticksPaidByRenter, 1);

    // The channel record now mirrors what the facilitator said, so the next voucher is checked here: its EIP-712 signature with viem.
    const second = await d.post(`/v1/leases/${id}/ticks`, { index: 1 }, { 'payment-signature': await voucher(required, 10_000n) });
    assert.equal(second.status, 200, await second.text());
    assert.equal(fac.calls.length, 1, 'no facilitator call for the second voucher');
    assert.equal(d.ledger.get(id)!.ticksPaidByRenter, 2);
    assert.equal(d.host.calls.filter((c) => c.startsWith('tick')).length, 2);

    // A voucher that does not add exactly one tick to what the channel has been charged.
    const stale = await d.post(`/v1/leases/${id}/ticks`, { index: 2 }, { 'payment-signature': await voucher(required, 12_000n) });
    assert.equal(stale.status, 402);
    const challenge = unb64<Required>(stale.headers.get('payment-required')!);
    assert.equal(challenge.error, 'invalid_batch_settlement_evm_cumulative_amount_mismatch');
    const state = challenge.accepts[0]!.extra!.channelState as { chargedCumulativeAmount: string };
    assert.equal(state.chargedCumulativeAmount, '10000', 'the 402 tells the client where the channel stands, so it signs the right next voucher');

    // The right amount, signed by someone who is not the channel's authorizer.
    const forged = await d.post(`/v1/leases/${id}/ticks`, { index: 2 }, { 'payment-signature': await voucher(required, 15_000n, stranger) });
    assert.equal(forged.status, 402);
    assert.equal(unb64<Required>(forged.headers.get('payment-required')!).error, 'invalid_batch_settlement_evm_voucher_signature');

    assert.equal(d.host.calls.filter((c) => c.startsWith('tick')).length, 2, 'neither refused voucher reached the host');
    assert.equal(fac.calls.length, 1);
    assert.equal(d.ledger.get(id)!.losses, 0n);
    assert.equal(d.ledger.get(id)!.stopped, false);

    // The right voucher after a refusal is just the next voucher: never payment_reused.
    const third = await d.post(`/v1/leases/${id}/ticks`, { index: 2 }, { 'payment-signature': await voucher(required, 15_000n) });
    assert.equal(third.status, 200, await third.text());
    assert.equal(d.ledger.get(id)!.ticksPaidByRenter, 3);
  } finally {
    d.close();
    fac.close();
  }
});

test('a voucher on a channel whose payer has asked to withdraw: the door, reading its own channel record, answers 409 before the gate', async () => {
  const fac = await facilitator();
  // The door is handed the schemes, as main.ts does, so its withdrawing check reads the scheme's channel records.
  const cfg = config(fac);
  const schemes = buildSchemes(cfg);
  const d = await realDoor(fac, { x402: cfg, schemes });
  try {
    const id = await d.open();
    const required = await d.challenge(id);
    const { channelId } = channelOf(required);
    // The facilitator saw a withdraw request on chain when it verified the first voucher.
    fac.verify = (b) => ({ isValid: true, payer: payerOf(b.paymentPayload), extra: { channelId, ...CHANNEL_STATE, withdrawRequestedAt: 1_700_000_000 } });
    const first = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': await voucher(required, 5000n) });
    assert.equal(first.status, 200, await first.text());
    assert.equal(((await schemes.batch.getStorage().get(channelId))?.withdrawRequestedAt ?? 0) > 0, true, 'the record keeps the withdraw request');
    const second = await d.post(`/v1/leases/${id}/ticks`, { index: 1 }, { 'payment-signature': await voucher(required, 10_000n) });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'channel_withdrawing' });
    assert.equal(fac.calls.length, 1);
    assert.equal(d.host.calls.filter((c) => c.startsWith('tick')).length, 1);
  } finally {
    d.close();
    fac.close();
  }
});

test('a facilitator that lists exact only: offerBatch false keeps the door up and a voucher is refused as matching nothing', async () => {
  const fac = await facilitator({ batch: false });
  assert.equal(await facilitatorOffersBatch(fac.url, NETWORK), false);
  const d = await realDoor(fac, { offerBatch: false });
  try {
    const id = await d.open();
    const required = await d.challenge(id);
    assert.deepEqual(required.accepts.map((a) => a.scheme), ['exact']);
    // A voucher built as if batch had been offered.
    const batchish: Required = { ...required, accepts: [{ ...required.accepts[0]!, scheme: 'batch-settlement', extra: { receiverAuthorizer: CLAIM_ADDRESS, withdrawDelay: WITHDRAW_DELAY_SECONDS } }] };
    const r = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': await voucher(batchish, 5000n) });
    assert.equal(r.status, 402);
    assert.equal(unb64<Required>(r.headers.get('payment-required')!).error, 'No matching payment requirements');
    assert.equal(fac.calls.length, 0);
    // And exact still works.
    const ok = await d.post(`/v1/leases/${id}/ticks`, { index: 0 }, { 'payment-signature': exactPayment(required, '0xabc', '0x01') });
    assert.equal(ok.status, 200, await ok.text());
  } finally {
    d.close();
    fac.close();
  }
});
