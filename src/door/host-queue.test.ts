import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlinePassedError, MIN_SEND_MS } from '../errors.js';
import { HostQueue } from './host-queue.js';

/** A call that runs until released, recording when it started and ended. */
function gate(log: string[], name: string) {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const fn = async () => {
    log.push(`start ${name}`);
    await done;
    log.push(`end ${name}`);
    return name;
  };
  return { fn, release };
}

const tick = () => new Promise((r) => setImmediate(r));

test('one call at a time per host, two hosts in parallel', async () => {
  const q = new HostQueue();
  const log: string[] = [];
  const a1 = gate(log, 'a1');
  const a2 = gate(log, 'a2');
  const b1 = gate(log, 'b1');
  const r1 = q.run('a', undefined, a1.fn);
  const r2 = q.run('a', undefined, a2.fn);
  const r3 = q.run('b', undefined, b1.fn);
  await tick();
  assert.deepEqual(log, ['start a1', 'start b1'], 'a2 waits for a1; b runs beside a');
  a1.release();
  assert.equal(await r1, 'a1');
  await tick();
  assert.deepEqual(log, ['start a1', 'start b1', 'end a1', 'start a2']);
  a2.release();
  b1.release();
  assert.deepEqual(await Promise.all([r2, r3]), ['a2', 'b1']);
});

test('a call that throws frees the host for the next one', async () => {
  const q = new HostQueue();
  await assert.rejects(q.run('a', undefined, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await q.run('a', undefined, async () => 'next'), 'next');
});

test('earliest deadline runs first, undefined deadlines last', async () => {
  const q = new HostQueue();
  const now = () => 1_000_000;
  const log: string[] = [];
  const first = gate(log, 'first');
  const running = q.run('h', undefined, first.fn, now);
  await tick();
  const order: string[] = [];
  const add = (name: string, deadline: number | undefined) =>
    q.run('h', deadline, async () => void order.push(name), now);
  const waits = [
    add('none-1', undefined),
    add('late', 1_000_000 + 60_000),
    add('none-2', undefined),
    add('early', 1_000_000 + 20_000),
    add('mid-1', 1_000_000 + 40_000),
    add('mid-2', 1_000_000 + 40_000),
  ];
  first.release();
  await running;
  await Promise.all(waits);
  assert.deepEqual(order, ['early', 'mid-1', 'mid-2', 'late', 'none-1', 'none-2']);
});

test('a call whose deadline passed in the queue rejects DeadlinePassedError and never runs', async () => {
  const q = new HostQueue();
  let t = 1_000_000;
  const now = () => t;
  const log: string[] = [];
  const first = gate(log, 'first');
  const running = q.run('h', undefined, first.fn, now);
  await tick();
  let ran = false;
  const late = q.run('h', t + MIN_SEND_MS + 1_000, async () => void (ran = true), now);
  const after = q.run('h', undefined, async () => 'after', now);
  // The first call holds the host past the waiting call's deadline less MIN_SEND_MS.
  t += 1_001;
  first.release();
  await running;
  await assert.rejects(late, (e: unknown) => e instanceof DeadlinePassedError);
  assert.equal(ran, false);
  assert.equal(await after, 'after');
  // Already too close on arrival, with nothing ahead of it: refused the same way.
  await assert.rejects(q.run('h', t + MIN_SEND_MS - 1, async () => 'x', now), (e: unknown) => e instanceof DeadlinePassedError);
});
