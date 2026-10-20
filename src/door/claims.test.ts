import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryChannelStorage, type Channel } from '@x402/evm/batch-settlement/server';
import { REFUND_IDLE_MS, selectClaimable, selectRefundable, startClaims, x402Command, type ClaimManager } from './claims.js';

const NOW = 1_000_000_000;
const addr = (c: string) => `0x${c.repeat(40)}` as `0x${string}`;

function channel(over: Partial<Channel> = {}): Channel {
  return {
    channelId: '0x' + 'c1'.repeat(32),
    channelConfig: { payer: addr('a'), payerAuthorizer: addr('b'), receiver: addr('2'), receiverAuthorizer: addr('d'), token: addr('e'), withdrawDelay: 3600, salt: '0x' + '0'.repeat(64) },
    chargedCumulativeAmount: '15000',
    signedMaxClaimable: '15000',
    signature: '0xsig',
    balance: '100000',
    totalClaimed: '0',
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: NOW - REFUND_IDLE_MS,
    ...over,
  };
}

test('selectRefundable keeps an idle channel with an unspent balance', () => {
  assert.deepEqual(selectRefundable([channel()], NOW).map((c) => c.channelId), [channel().channelId]);
});

test('selectRefundable drops a channel whose balance is all charged (nothing to give back)', () => {
  assert.deepEqual(selectRefundable([channel({ balance: '15000' })], NOW), []);
});

test('selectRefundable drops a channel with a live pending request', () => {
  const live = channel({ pendingRequest: { pendingId: 'p', signedMaxClaimable: '20000', expiresAt: NOW + 1 } });
  assert.deepEqual(selectRefundable([live], NOW), []);
  const lapsed = channel({ pendingRequest: { pendingId: 'p', signedMaxClaimable: '20000', expiresAt: NOW - 1 } });
  assert.equal(selectRefundable([lapsed], NOW).length, 1);
});

test('selectRefundable drops a channel that paid a tick within the idle window (a lease may still be running)', () => {
  assert.deepEqual(selectRefundable([channel({ lastRequestTimestamp: NOW - REFUND_IDLE_MS + 1 })], NOW), []);
});

const silent: ClaimManager = {
  claim: async () => { throw new Error('not expected'); },
  refund: async () => { throw new Error('not expected'); },
  settle: async () => { throw new Error('not expected'); },
  start: () => {},
};

test('x402Command status lists one line per channel: id, balance, charged, claimed', async () => {
  const storage = new InMemoryChannelStorage();
  await storage.updateChannel(channel().channelId, () => channel({ totalClaimed: '5000' }));
  const out: string[] = [];
  assert.equal(await x402Command(['status'], silent, storage, () => NOW, (m) => out.push(m)), 0);
  assert.deepEqual(out, [`${channel().channelId} balance 100000 charged 15000 claimed 5000 idle 600 s`]);
});

test('x402Command status with no channels says so', async () => {
  const out: string[] = [];
  assert.equal(await x402Command(['status'], silent, new InMemoryChannelStorage(), () => NOW, (m) => out.push(m)), 0);
  assert.deepEqual(out, ['no channels']);
});

test('x402Command claim claims every channel now, prints each claim, then settles; a settle that fails (the claim not yet mined) still leaves the claim printed and exits 1', async () => {
  const calls: unknown[] = [];
  const m: ClaimManager = {
    ...silent,
    claim: async (opts) => { calls.push(opts); return [{ vouchers: 2, transaction: '0xclaim' }]; },
    settle: async () => ({ transaction: '0xsettle' }),
  };
  const out: string[] = [];
  assert.equal(await x402Command(['claim'], m, new InMemoryChannelStorage(), () => NOW, (msg) => out.push(msg)), 0);
  assert.deepEqual(calls, [{ idleSecs: 0 }]);
  assert.deepEqual(out, ['claimed 2 vouchers tx 0xclaim', 'settled tx 0xsettle']);
  const late: ClaimManager = { ...m, settle: async () => { throw new Error('Settle failed: invalid_batch_settlement_evm_nothing_to_settle'); } };
  const out2: string[] = [];
  assert.equal(await x402Command(['claim'], late, new InMemoryChannelStorage(), () => NOW, (msg) => out2.push(msg)), 1);
  assert.deepEqual(out2, ['claimed 2 vouchers tx 0xclaim', 'settle: Settle failed: invalid_batch_settlement_evm_nothing_to_settle (the claim may not be mined yet: run x402 settle in a minute)']);
  const nothing: ClaimManager = { ...m, claim: async () => [] };
  const out3: string[] = [];
  assert.equal(await x402Command(['claim'], nothing, new InMemoryChannelStorage(), () => NOW, (msg) => out3.push(msg)), 0);
  assert.deepEqual(out3, ['nothing to claim']);
});

test('x402Command refund refunds only the refundable channels and prints each', async () => {
  const storage = new InMemoryChannelStorage();
  await storage.updateChannel(channel().channelId, () => channel());
  await storage.updateChannel('0x' + 'c2'.repeat(32), () => channel({ channelId: '0x' + 'c2'.repeat(32), balance: '15000' }));
  const ids: string[][] = [];
  const m: ClaimManager = { claimAndSettle: silent.claimAndSettle, refund: async (x) => { ids.push(x); return x.map((channel) => ({ channel, transaction: '0xrefund' })); } };
  const out: string[] = [];
  assert.equal(await x402Command(['refund'], m, storage, () => NOW, (msg) => out.push(msg)), 0);
  assert.deepEqual(ids, [[channel().channelId]]);
  assert.deepEqual(out, [`refunded ${channel().channelId} tx 0xrefund`]);
});

test('x402Command: anything else prints the usage and returns 2', async () => {
  const out: string[] = [];
  assert.equal(await x402Command(['bogus'], silent, new InMemoryChannelStorage(), () => NOW, (m) => out.push(m)), 2);
  assert.match(out[0]!, /usage: charter-door x402 status \| claim \| settle \| refund/);
});

test('selectClaimable: a channel with vouchers past what is claimed is claimed once idle, or at once when its payer asked to withdraw', () => {
  const idle = channel();
  const busy = channel({ lastRequestTimestamp: NOW - 1000 });
  const withdrawing = channel({ lastRequestTimestamp: NOW - 1000, withdrawRequestedAt: NOW - 5000 });
  const nothing = channel({ totalClaimed: '15000', withdrawRequestedAt: NOW - 5000 });
  assert.deepEqual(selectClaimable([idle, busy, withdrawing, nothing], NOW), [idle, withdrawing]);
});

test('x402Command settle moves claimed funds to payTo and prints the transaction', async () => {
  let settles = 0;
  const m: ClaimManager = { ...silent, settle: async () => { settles++; return { transaction: '0xsettle' }; } };
  const out: string[] = [];
  assert.equal(await x402Command(['settle'], m, new InMemoryChannelStorage(), () => NOW, (msg) => out.push(msg)), 0);
  assert.equal(settles, 1);
  assert.deepEqual(out, ['settled tx 0xsettle']);
});

test('startClaims: a refund claims as it goes, so a settle follows every refund round; a settle failure is logged, not thrown', async () => {
  let config: Parameters<ClaimManager['start']>[0] | undefined;
  let settles = 0;
  const m: ClaimManager = { ...silent, start: (c) => { config = c; }, settle: async () => { settles++; if (settles === 2) throw new Error('nothing to settle'); return { transaction: '0xs' }; } };
  const timers: Array<() => void> = [];
  const log: string[] = [];
  startClaims(m, (msg) => log.push(msg), (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; });
  assert.ok(config);
  config.onRefund!({ channel: '0xc1', transaction: '0xr1' });
  config.onRefund!({ channel: '0xc2', transaction: '0xr2' });
  assert.equal(timers.length, 1, 'one settle per refund round, not per channel');
  timers[0]!();
  await new Promise((r) => setImmediate(r));
  assert.equal(settles, 1);
  assert.ok(log.some((l) => l === 'x402 settled tx 0xs'), log.join('|'));
  config.onRefund!({ channel: '0xc3', transaction: '0xr3' });
  timers[1]!();
  await new Promise((r) => setImmediate(r));
  assert.equal(settles, 2);
  assert.ok(log.some((l) => l.startsWith('x402 settle after refund: nothing to settle')), log.join('|'));
});
