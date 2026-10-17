import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lease } from '../src/types.js';
import { UNEXPECTED_PAYMENT } from './format.js';
import { applyStatus, clearHalt, MAX_RESYNCS, newTickState, RETRY_LATER_MAX, runTick, shouldTick, type TickDeps, type TickState } from './ticker.js';

const lease = (over: Partial<Lease> = {}): Lease => ({
  id: 'a'.repeat(32), offerId: 'o1', job: { image: 'charter-job-fetch', args: {} }, state: 'awaiting_first_tick', createdAt: 0, paidIntervals: 0, ...over,
});

interface Answer { status: number; body: unknown }
const ok = (paidIntervals: number, paidThrough?: number): Answer => ({ status: 200, body: { paidIntervals, ...(paidThrough === undefined ? {} : { paidThrough }), duplicate: false } });
const err = (status: number, error: string, extra: object = {}): Answer => ({ status, body: { error, ...extra } });

/** Deps scripted with the answers in order; records every post, sleep, refresh and poll request. */
function rig(answers: Array<Answer | Error>, over: Partial<TickDeps> = {}) {
  const posts: number[] = [];
  const sleeps: number[] = [];
  const log: string[] = [];
  const clock = { t: 100_000 };
  const deps: TickDeps = {
    post: async (index) => {
      posts.push(index);
      log.push(`post:${index}`);
      const a = answers.shift();
      if (!a) throw new Error('no scripted answer');
      if (a instanceof Error) throw a;
      return a;
    },
    refresh: async () => void log.push('refresh'),
    requestPoll: () => void log.push('poll'),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => clock.t,
    alive: () => true,
    ...over,
  };
  return { deps, posts, sleeps, log, clock };
}

function started(over: Partial<Lease> = {}): TickState {
  const s = newTickState();
  applyStatus(s, lease(over));
  return s;
}

test('shouldTick: an awaiting lease is due at once, a running one ten seconds before the paid time runs out', () => {
  const s = started();
  assert.equal(shouldTick(s, 100_000), true);
  const r = started({ state: 'running', paidIntervals: 1, paidThrough: 130_000 });
  assert.equal(shouldTick(r, 119_999), false);
  assert.equal(shouldTick(r, 120_000), true);
});

test('a paid tick advances the index and the paid time; the next one waits for its time', async () => {
  const s = started();
  const t = rig([ok(1, 130_000)]);
  await runTick(s, t.deps);
  assert.deepEqual(t.posts, [0]);
  assert.equal(s.nextIndex, 1);
  assert.equal(s.lease?.state, 'running');
  assert.equal(s.lease?.paidIntervals, 1);
  assert.equal(s.lease?.paidThrough, 130_000);
  assert.equal(s.ticking, false);
  assert.equal(shouldTick(s, 100_001), false);
});

test('the status is read before a tick is sent, and a lease that turned out done gets no tick', async () => {
  const s = started();
  const t = rig([ok(1, 130_000)], { refresh: async () => void applyStatus(s, lease({ state: 'done', paidIntervals: 3 })) });
  await runTick(s, t.deps);
  assert.deepEqual(t.posts, [], 'nothing sent');
  assert.equal(s.halt, undefined);
});

test('retry_later is retried with the same index, at most three times, then the page stops', async () => {
  const s = started();
  const later = err(503, 'retry_later');
  const t = rig([later, later, later, later]);
  await runTick(s, t.deps);
  assert.deepEqual(t.posts, [0, 0, 0, 0], 'the first send and three retries, all index 0');
  assert.equal(RETRY_LATER_MAX, 3);
  assert.equal(t.sleeps.length, 3);
  assert.equal(s.halt?.retry, true);
  assert.equal(s.nextIndex, 0);
  assert.equal(s.holdTicks, true, 'no tick without a fresh status');
});

test('retry_later followed by a paid answer pays the same index once', async () => {
  const s = started();
  const t = rig([err(503, 'retry_later'), err(503, 'retry_later'), ok(1, 130_000)]);
  await runTick(s, t.deps);
  assert.deepEqual(t.posts, [0, 0, 0]);
  assert.equal(s.nextIndex, 1);
  assert.equal(s.halt, undefined);
});

test('out_of_order resyncs to the door index and waits for a status; after three in a row the page stops', async () => {
  const s = started();
  const t = rig([err(409, 'out_of_order', { expected: 4 })]);
  await runTick(s, t.deps);
  assert.equal(s.nextIndex, 4);
  assert.equal(s.holdTicks, true);
  assert.equal(shouldTick(s, 1e12), false, 'held until a status is read');
  assert.ok(t.log.includes('poll'));
  applyStatus(s, lease({ state: 'running', paidIntervals: 4, paidThrough: 1_000 }));
  assert.equal(shouldTick(s, 1e12), true);

  assert.equal(MAX_RESYNCS, 3);
  const more = rig([err(409, 'out_of_order', { expected: 4 }), err(409, 'out_of_order', { expected: 4 }), err(409, 'out_of_order', { expected: 4 })]);
  for (let i = 0; i < 2; i++) {
    await runTick(s, more.deps);
    assert.equal(s.halt, undefined, `resync ${i + 2} is allowed`);
    applyStatus(s, lease({ state: 'running', paidIntervals: 4, paidThrough: 1_000 }));
  }
  await runTick(s, more.deps);
  assert.ok(s.halt, 'the fourth resync in a row halts');
  assert.equal(s.halt?.retry, false);
});

test('a paid tick ends a run of resyncs', async () => {
  const s = started();
  await runTick(s, rig([err(409, 'out_of_order', { expected: 0 })]).deps);
  assert.equal(s.resyncs, 1);
  applyStatus(s, lease());
  await runTick(s, rig([ok(1, 130_000)]).deps);
  assert.equal(s.resyncs, 0);
});

const HALTS: Array<[number, string, boolean]> = [
  [409, 'busy', true], [409, 'lease_done', false], [409, 'not_running', false], [409, 'stopped', false],
  [403, 'payer_blocked', false], [400, 'authorization_window', true], [429, 'rate_limited', true], [402, 'settlement_failed', true],
];
for (const [status, code, retry] of HALTS) {
  test(`halt ${status} ${code}: one send, no automatic retry, and no tick until the renter retries and a status is read`, async () => {
    const s = started();
    const t = rig([err(status, code), ok(1, 130_000)]);
    await runTick(s, t.deps);
    assert.deepEqual(t.posts, [0], 'sent once');
    assert.equal(s.halt?.retry, retry);
    assert.equal(shouldTick(s, 1e12), false);
    applyStatus(s, lease());
    assert.equal(shouldTick(s, 1e12), false, 'a fresh status does not clear a halt');
    clearHalt(s);
    assert.equal(shouldTick(s, 1e12), false, 'clearing the halt still needs a fresh status');
    applyStatus(s, lease());
    assert.equal(shouldTick(s, 1e12), true);
  });
}

test('a send that throws (a refused wallet signature) halts with a retry', async () => {
  const s = started();
  const t = rig([new Error('User rejected the request.')]);
  await runTick(s, t.deps);
  assert.match(s.halt?.message ?? '', /User rejected/);
  assert.equal(s.halt?.retry, true);
  assert.equal(s.holdTicks, true);
});

test('an unexpected payment request halts with its own message and no retry', async () => {
  const s = started();
  const t = rig([new Error(`Failed to create payment payload: ${UNEXPECTED_PAYMENT}`)]);
  await runTick(s, t.deps);
  assert.match(s.halt?.message ?? '', /Unexpected payment request/);
  assert.equal(s.halt?.retry, false);
});

test('a paid answer with no paid time (the job finished) leaves nothing due, even beside a stale status', async () => {
  const s = started({ state: 'running', paidIntervals: 2, paidThrough: 110_000 });
  s.nextIndex = 2;
  const t = rig([ok(3)]);
  await runTick(s, t.deps);
  assert.equal(s.lease?.paidIntervals, 3);
  assert.equal(s.lease?.paidThrough, undefined);
  assert.equal(shouldTick(s, 1e12), false);
  // The door's cached status is up to five seconds old: it still says running at two intervals.
  applyStatus(s, lease({ state: 'running', paidIntervals: 2, paidThrough: 110_000 }));
  assert.equal(s.lease?.paidThrough, undefined);
  assert.equal(shouldTick(s, 1e12), false, 'no extra tick');
  assert.deepEqual(t.posts, [2]);
  applyStatus(s, lease({ state: 'done', paidIntervals: 3 }));
  assert.equal(s.lease?.state, 'done');
});

test('a stale status never takes back what the page has seen, but a final one is taken', () => {
  const s = started();
  s.lease = lease({ state: 'running', paidIntervals: 2, paidThrough: 150_000 });
  s.nextIndex = 2;
  applyStatus(s, lease({ state: 'running', paidIntervals: 1, paidThrough: 120_000 }));
  assert.equal(s.lease?.paidIntervals, 2);
  assert.equal(s.lease?.paidThrough, 150_000);
  assert.equal(s.nextIndex, 2);
  applyStatus(s, lease({ state: 'closed', closedReason: 'missed_tick', paidIntervals: 1 }));
  assert.equal(s.lease?.state, 'closed');
});

test('a page that has left sends nothing and changes nothing after a wait', async () => {
  const s = started();
  let alive = true;
  const t = rig([err(503, 'retry_later'), ok(1, 130_000)], { alive: () => alive, sleep: async () => void (alive = false) });
  await runTick(s, t.deps);
  assert.deepEqual(t.posts, [0]);
  assert.equal(s.nextIndex, 0);
});
