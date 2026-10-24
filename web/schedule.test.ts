import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lease } from '../src/types.js';
import { nextTickAt } from './schedule.js';

function lease(over: Partial<Lease>): Lease {
  return {
    id: 'a'.repeat(32),
    offerId: 'offer-1',
    job: { image: 'charter-job-fetch', args: { URLS: 'https://example.com/' } },
    state: 'running',
    createdAt: 1_000,
    paidIntervals: 0,
    ...over,
  };
}

test('awaiting_first_tick is due now', () => {
  assert.equal(nextTickAt(lease({ state: 'awaiting_first_tick' }), 123_456), 123_456);
});

test('running is due halfway through the paid interval: 15 s before the paid time runs out on a 30 s interval', () => {
  assert.equal(nextTickAt(lease({ state: 'running', paidIntervals: 2, paidThrough: 90_000 }), 50_000, 30), 75_000);
});

test('the lead is never under ten seconds, and ten seconds when the interval is not known yet', () => {
  assert.equal(nextTickAt(lease({ state: 'running', paidIntervals: 2, paidThrough: 90_000 }), 50_000, 16), 80_000);
  assert.equal(nextTickAt(lease({ state: 'running', paidIntervals: 2, paidThrough: 90_000 }), 50_000), 80_000);
});

test('running is already overdue when now is past that point', () => {
  assert.equal(nextTickAt(lease({ state: 'running', paidIntervals: 2, paidThrough: 90_000 }), 85_000, 30), 75_000);
});

test('done and closed leases are never due', () => {
  assert.equal(nextTickAt(lease({ state: 'done', paidIntervals: 3, paidThrough: 90_000 }), 50_000), null);
  assert.equal(nextTickAt(lease({ state: 'closed', closedReason: 'missed_tick', paidIntervals: 3 }), 50_000), null);
});

test('a lease that is still booting, or running without a paid time, is not due yet', () => {
  assert.equal(nextTickAt(lease({ state: 'booting' }), 50_000), null);
  assert.equal(nextTickAt(lease({ state: 'running' }), 50_000), null);
});
