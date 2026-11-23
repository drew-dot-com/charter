// The door's HostApi over HTTPS against the real host app (hostHttpApp) on a loopback port. A tick is paid
// through the host's `tickGate`: `stubGate` (no payment asked), or a gate in this file that answers a crafted
// x402 402 and records what the door sent back. No chain, no facilitator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { BatchSettlementEvmScheme, computeChannelId } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { privateKeyToAccount } from 'viem/accounts';
import { signDoorRequest } from '../door-auth.js';
import { SendTimeoutError } from '../errors.js';
import { hostHttpApp } from '../host/http.js';
import type { Runner } from '../host/runner.js';
import { LeaseStore } from '../host/store.js';
import { onJobExit } from '../lease.js';
import { HostError } from '../tenant/host-api.js';
import type { JobSpec } from '../types.js';
import { BASE_USDC, type Gate } from '../x402/seller.js';
import { stubGate } from './x402.js';
import { CapitalCapError, doorPayer, httpHostApi, paysOnly, UnexpectedPaymentError, type DepositFor, type HostOffer } from './host-http.js';
import { HostQueue } from './host-queue.js';

const T0 = 1_700_000_000_000;
const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const DOOR = privateKeyToAccount(KEY);
const HOST_ID = 'ab'.repeat(32);
const PAY_TO = '0x' + '3'.repeat(40) as `0x${string}`;
const AUTHORIZER = '0x' + '4'.repeat(40);
const PRICE = 5000n;
const JOB: JobSpec = { image: 'charter-job-fetch', args: { URLS: 'https://example.com' } };

const offerAt = (url: string): HostOffer => ({
  id: 'o1', hostPubkey: '', ilpBase: 'g.test', sealKey: '', sealUrl: '', cpu: 1, memoryMiB: 1024, intervalSeconds: 30,
  firstTickGraceSeconds: 90, tickPrice: PRICE, openPrice: 0n, statusPrice: 0n, images: ['charter-job-fetch'], hiddenHost: false,
  hiddenEgress: false, expiresAt: 0, hostId: HOST_ID, url, payTo: PAY_TO,
});

/** What a host's batch-settlement 402 asks for one tick, exactly as the door accepts it. */
const ASK: PaymentRequirements = {
  scheme: 'batch-settlement', network: 'eip155:8453', asset: BASE_USDC, amount: String(PRICE), payTo: PAY_TO, maxTimeoutSeconds: 300,
  extra: { receiverAuthorizer: AUTHORIZER, withdrawDelay: 3600, name: 'USD Coin', version: '2' },
};

function fakeRunner(output: Buffer = Buffer.alloc(0)): Runner {
  return {
    create: async () => undefined, start: async () => undefined, exited: async () => 0, stop: async () => undefined,
    output: async () => output, alive: async () => true, ready: async () => true,
    ensureHome: async () => ({ homeId: '', port: 0, createdAt: 0, paidOnce: false }),
    publishHome: async () => undefined, retireHome: async () => undefined, homeAccess: async () => null,
    removeHome: async () => undefined, writePaidThrough: async () => undefined,
  };
}

/**
 * A tick gate that asks for `asks` in a 402, as an x402 server does, and lets a request carrying a payment
 * through to the tick handler. `paid` holds each payment payload it received; `seen` counts every request.
 */
function challengeGate(asks: PaymentRequirements[], settle?: (payload: { payload: Record<string, unknown> }) => Record<string, unknown> | undefined) {
  const seen: Array<{ paid: boolean }> = [];
  const paid: Array<{ payload: Record<string, unknown> }> = [];
  const gate: Gate = async (req, res, next) => {
    const header = req.get('payment-signature') ?? req.get('x-payment');
    seen.push({ paid: header !== undefined });
    if (header === undefined) {
      res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader({ x402Version: 2, resource: { url: req.originalUrl }, accepts: asks }));
      return void res.status(402).json({});
    }
    const payload = decodePaymentSignatureHeader(header) as unknown as { payload: Record<string, unknown> };
    paid.push(payload);
    const extra = settle?.(payload);
    if (extra) {
      res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader({ success: true, transaction: '', network: 'eip155:8453', extra }));
    }
    next();
  };
  return { gate, seen, paid };
}

async function setup(tickGate: Gate = stubGate(() => PRICE), output?: Buffer) {
  const store = new LeaseStore();
  let base = '';
  const app = hostHttpApp({
    store, runner: fakeRunner(output), offer: offerAt('https://unused'), now: () => T0, log: () => undefined,
    door: () => DOOR.address, origin: () => base, tickGate, offerJson: () => ({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const channelDir = mkdtempSync(join(tmpdir(), 'door-host-http-'));
  const offer = offerAt(base);
  const apiFor = (o: { depositFor?: DepositFor; timeoutMs?: number; fetch?: typeof fetch } = {}) =>
    httpHostApi(offer, {
      payer: doorPayer({ key: KEY, channelDir, depositFor: o.depositFor ?? (() => 500_000n), ...(o.fetch ? { fetch: o.fetch } : {}) }),
      queue: new HostQueue(), now: () => T0, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    });
  const done = () => {
    server.closeAllConnections();
    server.close();
  };
  return { store, offer, channelDir, apiFor, done };
}

test('open, tick, status, output round-trip through httpHostApi', async () => {
  const t = await setup(undefined, Buffer.from('hello world'));
  try {
    const api = t.apiFor();
    const open = await api.open(JOB);
    assert.equal(open.state, 'awaiting_first_tick');
    assert.match(open.leaseId, /^[0-9a-f]{32}$/);

    assert.deepEqual(await api.tick(open.leaseId, 0), { paidIntervals: 1, paidThrough: T0 + 30_000, duplicate: false });

    const lease = await api.status(open.leaseId);
    assert.equal(lease.id, open.leaseId);
    assert.equal(lease.state, 'running');

    t.store.put(onJobExit(t.store.get(open.leaseId)!, 1));
    const part = await api.outputPart(open.leaseId, 0);
    assert.equal(part.part, 0);
    assert.equal((await api.output(open.leaseId)).toString(), 'hello world');

    await assert.rejects(api.status('f'.repeat(32)), (e: unknown) => e instanceof HostError && e.status === 404 && e.error === 'not_found');
    assert.equal(api.spent(), PRICE, 'only the tick is paid');
  } finally {
    t.done();
  }
});

test('spent counts the tick price once per answered tick', async () => {
  const t = await setup();
  try {
    const api = t.apiFor();
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    assert.equal(api.spent(), PRICE);
    await api.tick(leaseId, 1);
    assert.equal(api.spent(), 2n * PRICE);
    // Already counted as spent: never sent again, and nothing more is spent.
    await assert.rejects(api.tick(leaseId, 1), (e: unknown) => e instanceof HostError && e.error === 'duplicate');
    assert.equal(api.spent(), 2n * PRICE);
    // A non-2xx answer is not settled by an x402 server: it costs the door nothing.
    await assert.rejects(api.tick(leaseId, 5), (e: unknown) => e instanceof HostError && e.status === 409);
    await assert.rejects(api.tick('e'.repeat(32), 0), (e: unknown) => e instanceof HostError && e.status === 404);
    assert.equal(api.spent(), 2n * PRICE);
  } finally {
    t.done();
  }
});

test('a tick that times out counts as spent: it may have been paid', async () => {
  let release!: () => void;
  const hung = new Promise<void>((r) => (release = r));
  const t = await setup(async (_req, _res, next) => {
    await hung;
    next();
  });
  try {
    const api = t.apiFor({ timeoutMs: 100 });
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof SendTimeoutError);
    assert.equal(api.spent(), PRICE);
  } finally {
    release();
    t.done();
  }
});

test('a 402 asking more than the snapshot, another payTo, network, asset or exact is refused unexpected_payment and nothing is signed', async () => {
  const keep = paysOnly({ payTo: PAY_TO }, PRICE);
  const variants: Array<[string, PaymentRequirements]> = [
    ['more than the snapshot', { ...ASK, amount: String(PRICE + 1n) }],
    ['less than the snapshot', { ...ASK, amount: String(PRICE - 1n) }],
    ['not a whole number', { ...ASK, amount: '5000.0' }],
    ['another payTo', { ...ASK, payTo: '0x' + '9'.repeat(40) }],
    ['another network', { ...ASK, network: 'eip155:84532' }],
    ['another asset', { ...ASK, asset: '0x' + '5'.repeat(40) }],
    ['exact', { ...ASK, scheme: 'exact' }],
    ['a withdrawDelay over one day', { ...ASK, extra: { ...ASK.extra, withdrawDelay: 86_401 } }],
    ['a withdrawDelay that is not a number', { ...ASK, extra: { ...ASK.extra, withdrawDelay: '60' } }],
    ['a Permit2 deposit', { ...ASK, extra: { ...ASK.extra, assetTransferMethod: 'permit2' } }],
  ];
  for (const [why, r] of variants) assert.deepEqual(keep(2, [r]), [], why);
  const oneDay = { ...ASK, extra: { ...ASK.extra, withdrawDelay: 86_400 } };
  const upper = { ...ASK, payTo: PAY_TO.toUpperCase().replace('0X', '0x'), asset: BASE_USDC.toLowerCase() };
  assert.deepEqual(keep(2, [ASK, oneDay, upper]), [ASK, oneDay, upper], 'the exact ask is kept; addresses compare case-insensitively');
  assert.deepEqual(keep(2, [variants[0]![1], ASK]), [ASK], 'only the matching entry of several is kept');

  // End to end: a host whose 402 asks for another payTo gets nothing signed and the door spends nothing.
  for (const [why, r] of variants) {
    const g = challengeGate([r]);
    const t = await setup(g.gate);
    try {
      const api = t.apiFor();
      const { leaseId } = await api.open(JOB);
      await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 402 && e.error === 'unexpected_payment', why);
      assert.deepEqual(g.seen, [{ paid: false }], `${why}: no payment was sent`);
      assert.equal(api.spent(), 0n, why);
    } finally {
      t.done();
    }
  }
  // The payer's fetch on its own throws UnexpectedPaymentError.
  const g = challengeGate([variants[3]![1]]);
  const t = await setup(g.gate);
  try {
    const api = t.apiFor();
    const { leaseId } = await api.open(JOB);
    const pay = doorPayer({ key: KEY, channelDir: t.channelDir, depositFor: () => 500_000n }).paidFetch(t.offer, PRICE);
    const path = `/v1/leases/${leaseId}/ticks`;
    const body = JSON.stringify({ index: 0 });
    const headers = { ...(await signDoorRequest(DOOR, t.offer.url, 'POST', path, body, T0)), 'content-type': 'application/json' };
    await assert.rejects(pay(t.offer.url + path, { method: 'POST', headers, body }), (e: unknown) => e instanceof UnexpectedPaymentError);
    assert.deepEqual(g.seen, [{ paid: false }]);
  } finally {
    t.done();
  }
});

test('channel state reloads from disk', async () => {
  // The channel this host's 402 names, as the door's client derives it.
  const config = new BatchSettlementEvmScheme({ address: DOOR.address, signTypedData: async () => '0x' }).buildChannelConfig(ASK);
  const channelId = computeChannelId(config, ASK.network).toLowerCase();
  let charged = 35_000n;
  const g = challengeGate([ASK], () => {
    charged += PRICE;
    return { chargedAmount: String(PRICE), channelState: { chargedCumulativeAmount: String(charged) } };
  });
  const t = await setup(g.gate);
  try {
    // The library's own storage, where the door keeps this host's channel: 35000 charged of 500000 deposited.
    const storage = new FileClientChannelStorage({ directory: join(t.channelDir, HOST_ID) });
    await storage.set(channelId, { chargedCumulativeAmount: '35000', balance: '500000' });

    const first = t.apiFor();
    const { leaseId } = await first.open(JOB);
    await first.tick(leaseId, 0);
    // A restarted door: a new payer on the same directory continues the cumulative amount.
    await t.apiFor().tick(leaseId, 1);

    const vouchers = g.paid.map((p) => ({ type: p.payload.type, max: (p.payload.voucher as { maxClaimableAmount: string }).maxClaimableAmount }));
    assert.deepEqual(vouchers, [{ type: 'voucher', max: '40000' }, { type: 'voucher', max: '45000' }]);
    assert.equal((await storage.get(channelId))?.chargedCumulativeAmount, '45000');
  } finally {
    t.done();
  }
});

test('depositFor over_cap throws CapitalCapError before any request', async () => {
  const g = challengeGate([ASK]);
  const t = await setup(g.gate);
  try {
    const asked: string[] = [];
    const api = t.apiFor({ depositFor: (id) => (asked.push(id), 'over_cap') });
    const { leaseId } = await api.open(JOB);
    // No channel yet: the deposit is known to be needed, so nothing is sent at all.
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof CapitalCapError);
    assert.deepEqual(g.seen, []);
    assert.deepEqual(asked, [HOST_ID]);
    assert.equal(api.spent(), 0n);

    // A channel too low for this tick needs a top-up: refused before anything is signed.
    const config = new BatchSettlementEvmScheme({ address: DOOR.address, signTypedData: async () => '0x' }).buildChannelConfig(ASK);
    const storage = new FileClientChannelStorage({ directory: join(t.channelDir, HOST_ID) });
    await storage.set(computeChannelId(config, ASK.network).toLowerCase(), { chargedCumulativeAmount: '100000', balance: '100000' });
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof CapitalCapError);
    assert.deepEqual(g.seen, [{ paid: false }], 'only the unpaid request that drew the 402');
    assert.equal(api.spent(), 0n);
  } finally {
    t.done();
  }
});

test('a first tick deposits exactly what depositFor allows', async () => {
  const g = challengeGate([ASK]);
  const t = await setup(g.gate);
  try {
    const api = t.apiFor({ depositFor: () => 300_000n });
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    assert.equal(g.paid.length, 1);
    assert.equal(g.paid[0]!.payload.type, 'deposit');
    assert.equal((g.paid[0]!.payload.deposit as { amount: string }).amount, '300000');
    assert.equal(api.spent(), PRICE);
  } finally {
    t.done();
  }
});
