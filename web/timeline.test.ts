import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lease } from '../src/types.js';
import { newTimeline, noteOutput, observe } from './timeline.js';

const base: Lease = { id: 'a'.repeat(32), offerId: 'x', job: { image: 'charter-job-python', args: {} }, state: 'booting', createdAt: 1_000, paidIntervals: 0 };
const texts = (s: ReturnType<typeof newTimeline>) => s.events.map((e) => e.text);

test('a lease followed from the start tells the whole story in order, one event per transition', () => {
  const s = newTimeline();
  observe(s, base, 1_000);
  observe(s, base, 2_000);
  assert.deepEqual(texts(s), ['Lease opened. The host is creating the machine.']);
  observe(s, { ...base, state: 'awaiting_first_tick', bootedAt: 3_000 }, 3_000);
  assert.deepEqual(texts(s).slice(1), ['Machine created. Waiting for the first payment.']);
  observe(s, { ...base, state: 'running', paidIntervals: 1, paidThrough: 34_000, startedAt: 4_000 }, 4_000, '5000');
  assert.deepEqual(texts(s).slice(2), ['Interval 1 paid, $0.005.', 'Machine started. The job is running.']);
  observe(s, { ...base, state: 'running', paidIntervals: 2, paidThrough: 64_000 }, 20_000, '5000');
  assert.deepEqual(texts(s).slice(4), ['Interval 2 paid, $0.005.']);
  observe(s, { ...base, state: 'done', paidIntervals: 2, outputParts: 1 }, 40_000, '5000');
  assert.deepEqual(texts(s).slice(5), ['Job finished.']);
  noteOutput(s, 41_000, 1234);
  assert.deepEqual(texts(s).slice(6), ['Output received, 1.2 KB.']);
  observe(s, { ...base, state: 'done', paidIntervals: 2, outputParts: 1, landing: { chain: 'base', tx: '0x' + 'ab'.repeat(32), shared: true } }, 50_000, '5000');
  assert.equal(s.events.length, 8);
  assert.equal(s.events[7]!.text, "The host's vouchers landed on chain, in a shared batch.");
  assert.equal(s.events[7]!.href, `https://basescan.org/tx/0x${'ab'.repeat(32)}`);
  assert.deepEqual(s.events.map((e) => e.at), [1_000, 3_000, 4_000, 4_000, 20_000, 40_000, 41_000, 50_000]);
});

test('several intervals seen at once become one event, and the price is left out when unknown', () => {
  const s = newTimeline();
  observe(s, { ...base, state: 'running', paidIntervals: 1, paidThrough: 31_000 }, 1_000);
  observe(s, { ...base, state: 'running', paidIntervals: 4, paidThrough: 121_000 }, 90_000);
  assert.deepEqual(texts(s), ['Joined the lease with 1 interval paid.', 'Intervals 2 to 4 paid.']);
});

test('joining a finished lease says so, and a closed lease names its reason once', () => {
  const s = newTimeline();
  observe(s, { ...base, state: 'closed', paidIntervals: 3, closedReason: 'missed_tick' }, 1_000);
  observe(s, { ...base, state: 'closed', paidIntervals: 3, closedReason: 'missed_tick' }, 2_000);
  assert.deepEqual(texts(s), ['Joined the lease with 3 intervals paid.', 'Lease closed: a payment was missed.']);
  const d = newTimeline();
  observe(d, { ...base, state: 'done', paidIntervals: 0 }, 1_000);
  assert.deepEqual(texts(d), ['Joined the lease with no intervals paid.', 'Job finished.']);
  const b = newTimeline();
  observe(b, { ...base, state: 'closed', closedReason: 'boot_failed' }, 1_000);
  assert.deepEqual(texts(b), ['Lease opened. The host is creating the machine.', 'Lease closed: the machine did not start. Nothing is owed.']);
});

test('a stale status never adds an event: the lease only moves forward', () => {
  const s = newTimeline();
  observe(s, { ...base, state: 'running', paidIntervals: 2, paidThrough: 61_000 }, 1_000);
  observe(s, { ...base, state: 'running', paidIntervals: 1, paidThrough: 31_000 }, 2_000);
  observe(s, { ...base, state: 'awaiting_first_tick' }, 3_000);
  assert.equal(s.events.length, 1);
});
