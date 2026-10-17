import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelCommand, type ChannelPayer } from './channel.js';
import type { ChannelExit, ChannelSummary } from '../payer.js';

function fake(o: { channels?: ChannelSummary[]; headroom?: bigint; close?: ChannelExit[]; settle?: ChannelExit[] } = {}) {
  const calls: string[] = [];
  let headroom = o.headroom;
  const p: ChannelPayer = {
    channels: () => o.channels ?? [],
    headroom: async () => headroom,
    warm: async () => {
      calls.push('warm');
      headroom = 2_000_000n;
    },
    closeChannels: async () => (calls.push('close'), o.close ?? []),
    settleChannels: async () => (calls.push('settle'), o.settle ?? []),
  };
  return { p, calls };
}

test('channel status lists each channel and the headroom', async () => {
  const out: string[] = [];
  const { p } = fake({
    channels: [
      { channel: { channelId: 'A' }, depositTotal: 2_000_000n, signed: 1_990_000n },
      { channel: { channelId: 'B' }, depositTotal: 2_000_000n, signed: 5n, closedAt: 1n, settleableAt: 99n },
    ],
    headroom: 10_000n,
  });
  assert.equal(await channelCommand(['status'], p, (m) => out.push(m)), 0);
  assert.deepEqual(out, ['A deposit 2000000 signed 1990000 open', 'B deposit 2000000 signed 5 closing, settleable at 99', 'headroom 10000']);
});

test('channel rotate closes, then opens a fresh channel; a failed close opens nothing', async () => {
  const open = [{ channel: { channelId: 'A' }, depositTotal: 2_000_000n, signed: 1_990_000n }];
  const ok = fake({ channels: open, headroom: 10_000n, close: [{ channelId: 'A', transaction: 'tx1', settleableAt: 5n }] });
  const out: string[] = [];
  assert.equal(await channelCommand(['rotate'], ok.p, (m) => out.push(m)), 0);
  assert.deepEqual(ok.calls, ['close', 'warm']);
  assert.deepEqual(out, ['A tx tx1 settleable at 5', 'fresh channel open, headroom 2000000']);

  const bad = fake({ channels: open, close: [{ channelId: 'A', error: 'no SOL' }] });
  assert.equal(await channelCommand(['rotate'], bad.p, () => undefined), 1);
  assert.deepEqual(bad.calls, ['close']);
});

test('channel settle reports each exit and fails when one did; anything else is usage', async () => {
  const f = fake({ settle: [{ channelId: 'A', transaction: 't' }, { channelId: 'B', error: 'window open' }] });
  const out: string[] = [];
  assert.equal(await channelCommand(['settle'], f.p, (m) => out.push(m)), 1);
  assert.deepEqual(out, ['A tx t', 'B error window open']);
  for (const args of [[], ['close'], ['status', 'x']]) assert.equal(await channelCommand(args, fake().p, () => undefined), 2);
});

test('channel rotate with no open channel (a rerun after a failed open) skips the close and only opens', async () => {
  const f = fake({ channels: [{ channel: { channelId: 'A' }, depositTotal: 2_000_000n, signed: 9n, closedAt: 1n }] });
  const out: string[] = [];
  assert.equal(await channelCommand(['rotate'], f.p, (m) => out.push(m)), 0);
  assert.deepEqual(f.calls, ['warm']);
  assert.deepEqual(out, ['no open channel to close', 'fresh channel open, headroom 2000000']);
});
