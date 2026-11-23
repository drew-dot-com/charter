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
import type { JobSpec, Offer } from '../types.js';
import { BASE_USDC, type Gate } from '../x402/seller.js';
import { stubGate } from './x402.js';
import { CapitalCapError, channelSalt, DepositPendingError, doorPayer, httpHostApi, MAX_OUTPUT_PARTS, PENDING_CHECK_MS, paysOnly, UnexpectedPaymentError, type DepositFor, type DoorPayer, type ReadContract } from './host-http.js';
import { CapitalBook } from './capital.js';
import { HostQueue } from './host-queue.js';
import { reapChannels } from './hosts.js';
import { listedRegistry } from '../tenant/test-host.js';

const T0 = 1_700_000_000_000;
const KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;
const DOOR = privateKeyToAccount(KEY);
const HOST_ID = 'ab'.repeat(32);
const PAY_TO = '0x' + '3'.repeat(40) as `0x${string}`;
const AUTHORIZER = '0x' + '4'.repeat(40);
const PRICE = 5000n;
const JOB: JobSpec = { image: 'charter-job-fetch', args: { URLS: 'https://example.com' } };

const offerAt = (url: string): Offer => ({
  id: 'o1', cpu: 1, memoryMiB: 1024, intervalSeconds: 30,
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
 * `settle`: answer a success PAYMENT-RESPONSE charging PRICE (cumulative from `charged`), on a 2xx only as
 * the real middleware does, or on any status. `answer`: the gate answers a paid request with this status itself.
 */
function challengeGate(asks: PaymentRequirements[], o: { settle?: 'on2xx' | 'always'; charged?: bigint; answer?: number } = {}) {
  const seen: Array<{ paid: boolean }> = [];
  const paid: Array<{ payload: Record<string, unknown> }> = [];
  let charged = o.charged ?? 0n;
  const gate: Gate = async (req, res, next) => {
    const header = req.get('payment-signature') ?? req.get('x-payment');
    seen.push({ paid: header !== undefined });
    if (header === undefined) {
      res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader({ x402Version: 2, resource: { url: req.originalUrl }, accepts: asks }));
      return void res.status(402).json({});
    }
    paid.push(decodePaymentSignatureHeader(header) as unknown as { payload: Record<string, unknown> });
    const settleNow = () => {
      charged += PRICE;
      const extra = { chargedAmount: String(PRICE), channelState: { chargedCumulativeAmount: String(charged) } };
      res.setHeader('PAYMENT-RESPONSE', encodePaymentResponseHeader({ success: true, transaction: '', network: 'eip155:8453', extra }));
    };
    if (o.answer !== undefined) {
      if (o.settle === 'always') settleNow();
      return void res.status(o.answer).json({ error: 'boom' });
    }
    if (o.settle) {
      const end = res.end.bind(res);
      res.end = ((...a: unknown[]) => {
        if (o.settle === 'always' || (res.statusCode >= 200 && res.statusCode < 300)) settleNow();
        return (end as (...x: unknown[]) => typeof res)(...a);
      }) as typeof res.end;
    }
    next();
  };
  return { gate, seen, paid };
}

/** The channel id the door's client derives from ASK for a host (its salt is the hostId). */
function askChannelId(hostId = HOST_ID): string {
  const config = new BatchSettlementEvmScheme({ address: DOOR.address, signTypedData: async () => '0x' }, { salt: channelSalt(hostId) }).buildChannelConfig(ASK);
  return computeChannelId(config, ASK.network).toLowerCase();
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
  type DepositHook = (hostId: string, channelId: string, amount: bigint) => void;
  const payerFor = (o: { depositFor?: DepositFor; atRisk?: (hostId: string) => bigint; onDeposit?: DepositHook; onDepositLapsed?: DepositHook; readContract?: ReadContract; now?: () => number } = {}) =>
    doorPayer({
      key: KEY, channelDir, depositFor: o.depositFor ?? (() => 500_000n), atRisk: o.atRisk ?? (() => 0n),
      ...(o.onDeposit ? { onDeposit: o.onDeposit } : {}), ...(o.onDepositLapsed ? { onDepositLapsed: o.onDepositLapsed } : {}), ...(o.readContract ? { readContract: o.readContract } : {}), ...(o.now ? { now: o.now } : {}),
    });
  const apiFor = (o: { depositFor?: DepositFor; timeoutMs?: number; payer?: DoorPayer } = {}) =>
    httpHostApi(offer, {
      payer: o.payer ?? payerFor(o.depositFor ? { depositFor: o.depositFor } : {}),
      queue: new HostQueue(), now: () => T0, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    });
  const done = () => {
    server.closeAllConnections();
    server.close();
  };
  return { store, offer, channelDir, apiFor, payerFor, done };
}

test('open, tick, status, output round-trip through httpHostApi', async () => {
  const t = await setup(challengeGate([ASK], { settle: 'on2xx' }).gate, Buffer.from('hello world'));
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
  const g = challengeGate([ASK], { settle: 'on2xx' });
  const t = await setup(g.gate);
  try {
    const api = t.apiFor();
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    assert.equal(api.spent(), PRICE);
    await api.tick(leaseId, 1);
    assert.equal(api.spent(), 2n * PRICE);
    // Already counted as spent: never sent again, and nothing more is spent.
    await assert.rejects(api.tick(leaseId, 1), (e: unknown) => e instanceof HostError && e.error === 'duplicate');
    assert.equal(g.paid.length, 2, 'the repeat signed nothing');
    assert.equal(api.spent(), 2n * PRICE);
    // A non-2xx answer the host did not settle costs the door nothing.
    await assert.rejects(api.tick(leaseId, 5), (e: unknown) => e instanceof HostError && e.status === 409);
    await assert.rejects(api.tick('e'.repeat(32), 0), (e: unknown) => e instanceof HostError && e.status === 404);
    assert.equal(api.spent(), 2n * PRICE);
    // Nor did it count the index: index 5 may be sent again.
    await assert.rejects(api.tick(leaseId, 5), (e: unknown) => e instanceof HostError && e.status === 409);
  } finally {
    t.done();
  }
});

test('a host that settles and answers non-2xx: spent is what the channel moved, and the index is never re-sent', async () => {
  const g = challengeGate([ASK], { settle: 'always', answer: 500 });
  const t = await setup(g.gate);
  try {
    const api = t.apiFor();
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500 && e.error === 'boom');
    assert.equal(api.spent(), PRICE, 'the host charged the channel, so the door spent it');
    assert.equal(g.paid.length, 1);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 409 && e.error === 'duplicate');
    assert.equal(g.paid.length, 1, 'the retry signed nothing');
    assert.equal(api.spent(), PRICE);
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
    const pay = doorPayer({ key: KEY, channelDir: t.channelDir, depositFor: () => 500_000n, atRisk: () => 0n }).paidFetch(t.offer, PRICE);
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
  const channelId = askChannelId();
  const g = challengeGate([ASK], { settle: 'on2xx', charged: 35_000n });
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
    const storage = new FileClientChannelStorage({ directory: join(t.channelDir, HOST_ID) });
    await storage.set(askChannelId(), { chargedCumulativeAmount: '100000', balance: '100000' });
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof CapitalCapError);
    assert.deepEqual(g.seen, [{ paid: false }], 'only the unpaid request that drew the 402');
    assert.equal(api.spent(), 0n);
  } finally {
    t.done();
  }
});

test('depositFor below what the channel needs throws CapitalCapError: never raised to the minimum', async () => {
  const g = challengeGate([ASK]);
  const t = await setup(g.gate);
  try {
    const api = t.apiFor({ depositFor: () => PRICE - 1n });
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof CapitalCapError);
    assert.deepEqual(g.seen, [{ paid: false }], 'nothing was signed');
    assert.equal(api.spent(), 0n);
  } finally {
    t.done();
  }
});

test('a first tick deposits exactly what depositFor allows', async () => {
  const g = challengeGate([ASK], { settle: 'on2xx' });
  const t = await setup(g.gate);
  try {
    const deposits: Array<[string, string, bigint]> = [];
    const payer = t.payerFor({ depositFor: () => 300_000n, onDeposit: (...a) => void deposits.push(a) });
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    assert.equal(g.paid.length, 1);
    assert.equal(g.paid[0]!.payload.type, 'deposit');
    assert.equal((g.paid[0]!.payload.deposit as { amount: string }).amount, '300000');
    assert.deepEqual(deposits, [[HOST_ID, askChannelId(), 300_000n]]);
    assert.equal(api.spent(), PRICE);
    // The settle put the deposit in the record, so it is not pending: the next tick is a plain voucher.
    await api.tick(leaseId, 1);
    assert.equal(g.paid[1]!.payload.type, 'voucher');
  } finally {
    t.done();
  }
});

test('a paid tick keeps its channel config on disk, so the door can withdraw the channel later', async () => {
  const g = challengeGate([ASK], { settle: 'on2xx' });
  const t = await setup(g.gate);
  try {
    const payer = t.payerFor();
    assert.deepEqual(await payer.channels(HOST_ID), [], 'no channel yet');
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    await api.tick(leaseId, 1);
    const sent = g.paid[0]!.payload.channelConfig as Record<string, unknown>;
    const want = [{ channelId: askChannelId(), config: sent, balance: 500_000n, charged: 2n * PRICE }];
    assert.equal((sent.receiver as string).toLowerCase(), PAY_TO.toLowerCase());
    assert.deepEqual(await payer.channels(HOST_ID), want);
    assert.deepEqual(await t.payerFor().channels(HOST_ID), want, 'a restarted door reads it back');
    assert.equal(payer.chargedNow(HOST_ID), 2n * PRICE, 'the synchronous read the allocator uses');
    assert.equal(payer.chargedNow(HOST_ID), await payer.charged(HOST_ID));
    assert.equal(t.payerFor().chargedNow('cd'.repeat(32)), 0n, 'a host with no channel has charged nothing');
  } finally {
    t.done();
  }
});

test('R11: two hosts sharing one payTo get different channels, and dropping one never touches the other\'s', async () => {
  const g = challengeGate([ASK], { settle: 'on2xx' });
  const t = await setup(g.gate);
  try {
    const payer = t.payerFor();
    const B = 'cd'.repeat(32);
    const apiA = t.apiFor({ payer });
    const apiB = httpHostApi({ ...t.offer, hostId: B }, { payer, queue: new HostQueue(), now: () => T0 });
    // The host app serves one lease at a time: B's payment pays the next tick of the same lease.
    const { leaseId } = await apiA.open(JOB);
    await apiA.tick(leaseId, 0);
    await apiB.tick(leaseId, 1);
    const sent = g.paid.map((p) => (p.payload.voucher as { channelId: string }).channelId.toLowerCase());
    assert.deepEqual(sent, [askChannelId(HOST_ID), askChannelId(B)]);
    assert.notEqual(sent[0], sent[1], 'same payTo, receiver authorizer and delay: still two channels');
    assert.equal((g.paid[1]!.payload.channelConfig as { salt: string }).salt, `0x${B}`);
    const [a] = await payer.channels(HOST_ID);
    const [b] = await payer.channels(B);
    assert.equal(a!.channelId, sent[0]);
    assert.equal(b!.channelId, sent[1]);

    // B is dropped: the reaper withdraws B's channel and never writes to A's.
    const registry = listedRegistry(mkdtempSync(join(tmpdir(), 'reg-')), [HOST_ID, B]);
    for (let i = 1; i <= 3; i++) registry.probeResult(B, false, T0 + i);
    const writes: string[] = [];
    await reapChannels({
      registry, payer,
      chain: {
        state: async () => ({ balance: 500_000n, totalClaimed: 0n, withdrawInitiatedAt: 0 }),
        initiateWithdraw: async (c) => void writes.push(c.channelId),
        finalizeWithdraw: async (c) => void writes.push(`finalize ${c.channelId}`),
      },
      capital: { locked: () => 0n, withdrawn: () => undefined },
      lastLeaseAt: () => T0, ticking: () => false, now: () => T0 + 60_000, log: () => undefined,
    });
    assert.deepEqual(writes, [sent[1]]);
  } finally {
    t.done();
  }
});

test('a deposit tick that fails leaves the deposit pending: no second deposit is signed', async () => {
  const g = challengeGate([ASK], { answer: 500 });
  const t = await setup(g.gate);
  try {
    const deposits: Array<[string, string, bigint]> = [];
    const payer = t.payerFor({ onDeposit: (...a) => void deposits.push(a) });
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.equal(api.spent(), 0n, 'nothing settled, so the record did not move');
    assert.deepEqual(deposits, [[HOST_ID, askChannelId(), 500_000n]]);
    assert.equal(g.seen.length, 2);

    // The signed deposit may be on chain: another is refused before any request.
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof DepositPendingError);
    assert.equal(g.seen.length, 2, 'no request sent');
    assert.equal(deposits.length, 1);

    // The door clears it (after a chain resync): the next tick deposits again.
    payer.clearPendingDeposit(HOST_ID);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.equal(deposits.length, 2);

    // A record that shows the deposit clears it too: the next payment is a voucher on that balance.
    const storage = new FileClientChannelStorage({ directory: join(t.channelDir, HOST_ID) });
    await storage.set(askChannelId(), { chargedCumulativeAmount: '0', balance: '500000' });
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.equal(g.paid.at(-1)!.payload.type, 'voucher');
    assert.equal(deposits.length, 2);
  } finally {
    t.done();
  }
});

/** A Base reader that answers `channels(id)` from `chain`, counting each read. */
function fakeChain(chain: Map<string, [bigint, bigint]>) {
  const reads: string[] = [];
  const readContract: ReadContract = async (args) => {
    assert.equal(args.functionName, 'channels');
    const id = String(args.args?.[0]).toLowerCase();
    reads.push(id);
    return chain.get(id) ?? [0n, 0n];
  };
  return { readContract, reads };
}

test('R5: with a chain reader, a pending deposit the chain shows is cleared and the record takes the chain balance', async () => {
  const g = challengeGate([ASK], { answer: 500 });
  const t = await setup(g.gate);
  try {
    const chain = new Map<string, [bigint, bigint]>();
    const c = fakeChain(chain);
    const clock = { t: Date.now() };
    const deposits: bigint[] = [];
    const lapsed: bigint[] = [];
    const payer = t.payerFor({
      readContract: c.readContract, now: () => clock.t, onDeposit: (_h, _c, a) => void deposits.push(a), onDepositLapsed: (_h, _c, a) => void lapsed.push(a),
    });
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.deepEqual(deposits, [500_000n]);

    // Not on chain yet: still pending, and the chain is read at most once per PENDING_CHECK_MS.
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof DepositPendingError);
    const reads = c.reads.length;
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof DepositPendingError);
    assert.equal(c.reads.length, reads, 'no second read inside the window');

    // The deposit landed although its answer was lost: the next look clears it, and the tick is a voucher.
    chain.set(askChannelId(), [500_000n, 0n]);
    clock.t += PENDING_CHECK_MS;
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.equal(g.paid.at(-1)!.payload.type, 'voucher');
    assert.deepEqual(deposits, [500_000n], 'no second deposit');
    // Long after its authorization lapsed, a deposit that landed is never released.
    clock.t += 3_600_000;
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.deepEqual(lapsed, [], 'a landed deposit stays locked');
    const storage = new FileClientChannelStorage({ directory: join(t.channelDir, HOST_ID) });
    assert.equal((await storage.get(askChannelId()))?.balance, '500000');
  } finally {
    t.done();
  }
});

test('R5/R8: a pending deposit the chain never shows is cleared once its authorization has lapsed, and its capital released', async () => {
  const g = challengeGate([ASK], { answer: 500 });
  const t = await setup(g.gate);
  try {
    const c = fakeChain(new Map());
    const clock = { t: Date.now() };
    const deposits: bigint[] = [];
    // The door's books: a cap that fits one 500000 deposit.
    const book = new CapitalBook(join(t.channelDir, 'capital.json'));
    const payer = t.payerFor({
      readContract: c.readContract, now: () => clock.t,
      depositFor: (id) => (book.locked(id) + 500_000n <= 500_000n ? 500_000n : 'over_cap'),
      onDeposit: (h, _c, a) => (deposits.push(a), book.deposited(h, a)),
      onDepositLapsed: (h, _c, a) => book.withdrawn(h, a),
    });
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    const validBefore = Number(((g.paid[0]!.payload.deposit as { authorization: { erc3009Authorization: { validBefore: string } } }).authorization.erc3009Authorization.validBefore));
    clock.t = validBefore * 1000 - 1000;
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof DepositPendingError, 'still able to land');
    assert.equal(book.locked(HOST_ID), 500_000n);
    clock.t = validBefore * 1000 + PENDING_CHECK_MS;
    await assert.rejects(api.tick(leaseId, 0), (e: unknown) => e instanceof HostError && e.status === 500);
    assert.equal(deposits.length, 2, 'the lapsed deposit was released, so the next one fits the cap and is signed');
    assert.equal(book.locked(HOST_ID), 500_000n, 'only the live deposit is counted');
  } finally {
    t.done();
  }
});

test('R5: resyncAll brings every record up to the chain; charged may jump several ticks, never back', async () => {
  const t = await setup();
  try {
    const channelId = askChannelId();
    const storage = new FileClientChannelStorage({ directory: join(t.channelDir, HOST_ID) });
    await storage.set(channelId, { chargedCumulativeAmount: '35000', balance: '500000' });
    const chain = new Map<string, [bigint, bigint]>([[channelId, [600_000n, 50_000n]]]);
    const payer = t.payerFor({ readContract: fakeChain(chain).readContract });
    await payer.resyncAll();
    assert.deepEqual(await storage.get(channelId), { chargedCumulativeAmount: '50000', balance: '600000', totalClaimed: '50000' });
    assert.equal(await payer.charged(HOST_ID), 50_000n);
    chain.set(channelId, [600_000n, 10_000n]);
    await payer.resyncAll();
    assert.equal((await storage.get(channelId))?.chargedCumulativeAmount, '50000', 'a lower claimed amount never lowers charged');
    // Without a chain reader there is nothing to resync from.
    chain.set(channelId, [900_000n, 90_000n]);
    await t.payerFor().resyncAll();
    assert.equal((await storage.get(channelId))?.balance, '600000');
  } finally {
    t.done();
  }
});

test('C2: the first deposit pins the host\'s channel config; a 402 naming another is refused while capital is at risk', async () => {
  const OTHER_AUTH = { ...ASK, extra: { ...ASK.extra, receiverAuthorizer: '0x' + '6'.repeat(40) } };
  const OTHER_DELAY = { ...ASK, extra: { ...ASK.extra, withdrawDelay: 7200 } };
  const OTHER_PAY_TO = '0x' + '7'.repeat(40) as `0x${string}`;
  let asks: PaymentRequirements[] = [ASK];
  const g = challengeGate([], { settle: 'on2xx' });
  const gate: Gate = async (req, res, next) => {
    if (!req.get('payment-signature')) {
      res.setHeader('PAYMENT-REQUIRED', encodePaymentRequiredHeader({ x402Version: 2, resource: { url: req.originalUrl }, accepts: asks }));
      return void res.status(402).json({});
    }
    return g.gate(req, res, next);
  };
  const t = await setup(gate);
  try {
    let risk = 0n;
    const deposits: string[] = [];
    const payer = t.payerFor({ atRisk: () => risk, onDeposit: (_h, c) => void deposits.push(c) });
    assert.equal(await payer.pinnedChannel(HOST_ID), undefined, 'nothing funded yet');
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    assert.equal(await payer.pinnedChannel(HOST_ID), askChannelId());
    assert.equal(await t.payerFor().pinnedChannel(HOST_ID), askChannelId(), 'kept on disk');
    risk = 495_000n;
    const signed = g.paid.length;
    for (const [why, r] of [['another receiverAuthorizer', OTHER_AUTH], ['another withdrawDelay', OTHER_DELAY]] as const) {
      asks = [r];
      await assert.rejects(api.tick(leaseId, 1), (e: unknown) => e instanceof HostError && e.status === 402 && e.error === 'unexpected_payment', why);
    }
    // A host that changed its offer's payTo: a lease on the new offer names a new channel too.
    asks = [{ ...ASK, payTo: OTHER_PAY_TO }];
    const moved = httpHostApi({ ...t.offer, payTo: OTHER_PAY_TO }, { payer, queue: new HostQueue(), now: () => T0 });
    await assert.rejects(moved.tick(leaseId, 1), (e: unknown) => e instanceof HostError && e.status === 402 && e.error === 'unexpected_payment');
    assert.equal(g.paid.length, signed, 'nothing signed for another config');
    assert.deepEqual(deposits, [askChannelId()]);
    // The pinned config itself is still paid.
    asks = [ASK];
    await api.tick(leaseId, 1);
    assert.equal(g.paid.at(-1)!.payload.type, 'voucher');
    // Nothing at risk any more: the new config is paid, and it is pinned from its first deposit.
    risk = 0n;
    asks = [OTHER_AUTH];
    await api.tick(leaseId, 2);
    assert.equal(g.paid.at(-1)!.payload.type, 'deposit');
    const newId = (g.paid.at(-1)!.payload.voucher as { channelId: string }).channelId.toLowerCase();
    assert.notEqual(newId, askChannelId());
    assert.equal(await payer.pinnedChannel(HOST_ID), newId);
  } finally {
    t.done();
  }
});

test('I4: a channel the reaper asked to withdraw is not paid through (CapitalCapError, nothing signed) until the mark is cleared', async () => {
  const g = challengeGate([ASK], { settle: 'on2xx' });
  const t = await setup(g.gate);
  try {
    const payer = t.payerFor();
    const api = t.apiFor({ payer });
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    assert.deepEqual(await payer.withdrawing(HOST_ID), []);
    await payer.markWithdrawing(HOST_ID, askChannelId());
    assert.deepEqual(await t.payerFor().withdrawing(HOST_ID), [askChannelId()], 'kept on disk');
    const signed = g.paid.length;
    await assert.rejects(api.tick(leaseId, 1), (e: unknown) => e instanceof CapitalCapError);
    assert.equal(g.paid.length, signed, 'nothing signed');
    assert.equal(api.spent(), PRICE);
    await payer.clearWithdrawing(HOST_ID, askChannelId());
    await api.tick(leaseId, 1);
    assert.equal(g.paid.length, signed + 1);
  } finally {
    t.done();
  }
});

test('output reads stop at MAX_OUTPUT_PARTS', async () => {
  const t = await setup();
  try {
    const api = t.apiFor();
    await assert.rejects(api.outputPart('a'.repeat(32), MAX_OUTPUT_PARTS), (e: unknown) => e instanceof HostError && e.status === 404);
  } finally {
    t.done();
  }
});
