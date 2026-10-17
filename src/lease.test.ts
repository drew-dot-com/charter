import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_TICK_GRACE_MS, GRACE_MS, LeaseError, due, newLease, onBootFailed, onBooted, onJobExit, onTick } from './lease.js';
import type { Offer, JobSpec } from './types.js';

const t0 = 1_000_000;
const intervalMs = 30_000;

const offer: Offer = {
  id: 'offer-1',
  hostPubkey: 'a'.repeat(64),
  ilpBase: 'g.host',
  sealKey: '0x04' + 'b'.repeat(128),
  sealUrl: 'http://host.anyone/ilp',
  cpu: 1,
  memoryMiB: 1024,
  intervalSeconds: 30,
  firstTickGraceSeconds: 90,
  tickPrice: 5000n,
  openPrice: 1000n,
  statusPrice: 100n,
  images: ['alpine:3'],
  hiddenHost: true,
  hiddenEgress: false,
  expiresAt: t0 + 30 * 60_000,
};

const job: JobSpec = { image: 'alpine:3', args: { cmd: 'echo hi' } };

function awaiting() {
  return onBooted(newLease('lease-1', offer, job, t0), t0 + 5000);
}

function running() {
  return onTick(awaiting(), 0, t0 + 6000, intervalMs).lease;
}

test('GRACE_MS is 10 seconds and FIRST_TICK_GRACE_MS is 90 seconds', () => {
  assert.equal(GRACE_MS, 10_000);
  assert.equal(FIRST_TICK_GRACE_MS, 90_000);
});

test('newLease starts booting with no paid intervals', () => {
  const l = newLease('lease-1', offer, job, t0);
  assert.equal(l.id, 'lease-1');
  assert.equal(l.offerId, 'offer-1');
  assert.deepEqual(l.job, job);
  assert.equal(l.state, 'booting');
  assert.equal(l.createdAt, t0);
  assert.equal(l.paidIntervals, 0);
});

test('onBooted moves to awaiting_first_tick and records bootedAt', () => {
  const l = awaiting();
  assert.equal(l.state, 'awaiting_first_tick');
  assert.equal(l.bootedAt, t0 + 5000);
});

test('F-C3: due waits 90 s after the container is created for the first tick, then reports missed_tick', () => {
  const l = awaiting();
  assert.equal(due(l, t0 + 5000 + 10_001), null, 'a wallet prompt takes longer than ten seconds');
  assert.equal(due(l, t0 + 5000 + 90_000), null);
  assert.equal(due(l, t0 + 5000 + 90_001), 'missed_tick');
});

test('first tick starts the lease running and pays one interval from now', () => {
  const { lease, duplicate } = onTick(awaiting(), 0, t0 + 6000, intervalMs);
  assert.equal(duplicate, false);
  assert.equal(lease.state, 'running');
  assert.equal(lease.paidIntervals, 1);
  assert.equal(lease.paidThrough, t0 + 36_000);
});

test('later ticks extend from paidThrough, not from now', () => {
  const { lease, duplicate } = onTick(running(), 1, t0 + 30_000, intervalMs);
  assert.equal(duplicate, false);
  assert.equal(lease.paidIntervals, 2);
  assert.equal(lease.paidThrough, t0 + 66_000);
});

test('a repeated tick index is a duplicate and changes nothing', () => {
  const two = onTick(running(), 1, t0 + 30_000, intervalMs).lease;
  const { lease, duplicate } = onTick(two, 0, t0 + 31_000, intervalMs);
  assert.equal(duplicate, true);
  assert.equal(lease.paidIntervals, 2);
  assert.equal(lease.paidThrough, t0 + 66_000);
});

test('a tick index ahead of the next one throws out_of_order', () => {
  assert.throws(
    () => onTick(running(), 5, t0 + 7000, intervalMs),
    (e: unknown) => e instanceof LeaseError && e.code === 'out_of_order',
  );
});

test('a running lease is due missed_tick once paidThrough plus grace has passed', () => {
  const l = running();
  const paidThrough = l.paidThrough!;
  assert.equal(due(l, paidThrough + 10_001), 'missed_tick', 'later ticks keep the 10 s grace');
  assert.equal(due(l, paidThrough + 9_999), null);
});

test('onTick on a closed lease throws not_running', () => {
  const closed = onBootFailed(newLease('lease-1', offer, job, t0));
  assert.throws(
    () => onTick(closed, 0, t0 + 1000, intervalMs),
    (e: unknown) => e instanceof LeaseError && e.code === 'not_running',
  );
});

test('onTick before boot finishes throws not_running', () => {
  assert.throws(
    () => onTick(newLease('lease-1', offer, job, t0), 0, t0 + 1000, intervalMs),
    (e: unknown) => e instanceof LeaseError && e.code === 'not_running',
  );
});

test('onBootFailed closes the lease with boot_failed and no paid intervals', () => {
  const l = onBootFailed(newLease('lease-1', offer, job, t0));
  assert.equal(l.state, 'closed');
  assert.equal(l.closedReason, 'boot_failed');
  assert.equal(l.paidIntervals, 0);
});

test('onJobExit marks a running lease done and records the output part count', () => {
  const l = onJobExit(running(), 3);
  assert.equal(l.state, 'done');
  assert.equal(l.outputParts, 3);
  assert.equal(due(l, t0 + 10_000_000), null);
});

test('transitions do not mutate their input', () => {
  const before = newLease('lease-1', offer, job, t0);
  const snapshot = structuredClone(before);
  onBooted(before, t0 + 5000);
  onBootFailed(before);
  assert.deepEqual(before, snapshot);
});
