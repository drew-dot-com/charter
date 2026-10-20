import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryChannelStorage, type Channel } from '@x402/evm/batch-settlement/server';
import { REFUND_IDLE_MS, selectRefundable, x402Command, type ClaimManager } from './claims.js';

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
  claimAndSettle: async () => { throw new Error('not expected'); },
  refund: async () => { throw new Error('not expected'); },
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

test('x402Command claim claims every channel now and settles; the transactions are printed', async () => {
  const calls: unknown[] = [];
  const m: ClaimManager = {
    claimAndSettle: async (opts) => { calls.push(opts); return { claims: [{ vouchers: 2, transaction: '0xclaim' }], settle: { transaction: '0xsettle' } }; },
    refund: silent.refund,
  };
  const out: string[] = [];
  assert.equal(await x402Command(['claim'], m, new InMemoryChannelStorage(), () => NOW, (msg) => out.push(msg)), 0);
  assert.deepEqual(calls, [{ idleSecs: 0 }]);
  assert.deepEqual(out, ['claimed 2 vouchers tx 0xclaim', 'settled tx 0xsettle']);
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
  assert.equal(await x402Command(['settle'], silent, new InMemoryChannelStorage(), () => NOW, (m) => out.push(m)), 2);
  assert.match(out[0]!, /usage: charter-door x402 status \| claim \| refund/);
});
