import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, BASE_USDC, onlyDoorExact, renewLoop } from './x402-rent.mjs';

const LEASE = 'a'.repeat(32);
const HOUR = 3_600_000;
const PAYEE = '0xbD87000000000000000000000000000000000001';

/** A door with one running lease, and a clock that only `sleep` moves. */
function world({ paidIntervals = 1, state = 'running', minutesLeft = 60, payAnswers = [] } = {}) {
  const w = { t: 1_000_000_000_000, lease: { state, paidIntervals, paidThrough: 0 }, ticks: [], logs: [], slept: [], reads: 0 };
  w.lease.paidThrough = w.t + minutesLeft * 60_000;
  w.deps = {
    now: () => w.t,
    sleep: async (ms) => {
      w.slept.push(ms);
      w.t += ms;
    },
    log: (l) => w.logs.push(l),
    get: async () => {
      w.reads++;
      return { status: 200, body: { lease: { ...w.lease }, stopped: false, offer: { intervalSeconds: 3600 } } };
    },
    pay: async (path, json) => {
      const scripted = payAnswers.shift();
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      w.ticks.push({ path, index: json.index, at: w.t });
      w.lease.state = 'running';
      w.lease.paidIntervals = json.index + 1;
      w.lease.paidThrough = Math.max(w.lease.paidThrough, w.t) + HOUR;
      return { status: 200, body: { paidIntervals: w.lease.paidIntervals, paidThrough: w.lease.paidThrough }, tx: '0xabc' };
    },
  };
  return w;
}

test('renew waits for half an interval before the paid time ends, then pays the next index each hour', async () => {
  const w = world({ paidIntervals: 1, minutesLeft: 60 });
  const start = w.t;
  const why = await renewLoop({ leaseId: LEASE, maxIntervals: 3 }, w.deps);
  assert.equal(why, 'max');
  assert.deepEqual(w.ticks.map((x) => x.index), [1, 2, 3]);
  assert.equal(w.ticks[0].path, `/v1/leases/${LEASE}/ticks`);
  // 30 minutes before the first hour ends, then an hour apart.
  assert.deepEqual(w.ticks.map((x) => (x.at - start) / 60_000), [30, 90, 150]);
  // Never one sleep longer than ten minutes: the paid time is read again in between.
  assert.ok(w.slept.every((ms) => ms <= 10 * 60_000));
});

test('renew pays at once when the tick is already due, and --once stops after one', async () => {
  const w = world({ paidIntervals: 4, minutesLeft: 12 });
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [4]);
  assert.deepEqual(w.slept, []);
});

test('renew pays index 0 on a lease still waiting for its first tick', async () => {
  const w = world({ paidIntervals: 0, state: 'awaiting_first_tick', minutesLeft: 0 });
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [0]);
});

test('renew trusts the box clock file when it is ahead of the door: a tick paid elsewhere is not paid twice', async () => {
  const w = world({ paidIntervals: 2, minutesLeft: 10 });
  // The host counted a tick the door's cached read has not shown yet.
  const ahead = w.t + 70 * 60_000;
  w.deps.paidThroughFile = () => ahead;
  const sleep = w.deps.sleep;
  w.deps.sleep = async (ms) => {
    await sleep(ms);
    w.lease.paidIntervals = 3;
    w.lease.paidThrough = ahead;
  };
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [3]);
  assert.ok(w.slept.length > 0, 'it waited instead of paying index 2 again');
});

test('renew stops when the lease is over, the door does not know it, or the wallet is blocked', async () => {
  const closed = world({ state: 'closed' });
  closed.lease.closedReason = 'missed_tick';
  assert.equal(await renewLoop({ leaseId: LEASE }, closed.deps), 'over');
  assert.match(closed.logs.join('\n'), /missed_tick/);

  const unknown = world();
  unknown.deps.get = async () => ({ status: 404, body: { error: 'not_found' } });
  assert.equal(await renewLoop({ leaseId: LEASE }, unknown.deps), 'unknown');

  const blocked = world({ minutesLeft: 5, payAnswers: [{ status: 403, body: { error: 'payer_blocked' } }] });
  assert.equal(await renewLoop({ leaseId: LEASE }, blocked.deps), 'blocked');

  const done = world({ minutesLeft: 5, payAnswers: [{ status: 409, body: { error: 'not_running' } }] });
  assert.equal(await renewLoop({ leaseId: LEASE }, done.deps), 'over');
});

test('renew retries a refused or failed tick with a growing wait, says how much paid time is left, and pays when it can', async () => {
  const w = world({
    paidIntervals: 1,
    minutesLeft: 20,
    payAnswers: [{ status: 402, body: {}, reason: 'insufficient_funds' }, new Error('no payment requirements left'), { status: 503, body: { error: 'retry_later' } }],
  });
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [1]);
  assert.deepEqual(w.slept, [60_000, 120_000, 240_000]);
  const text = w.logs.join('\n');
  assert.match(text, /payment refused \(insufficient_funds\): does the wallet hold USDC on Base\?; 20 min of paid time left/);
  assert.match(text, /retry_later/);
});

test('the payment policy signs only exact USDC on Base to the door payee, at or under the cap', () => {
  const ok = { scheme: 'exact', network: BASE, asset: BASE_USDC, payTo: PAYEE, amount: '7000' };
  const policy = onlyDoorExact(PAYEE.toLowerCase(), 10000n);
  const kept = policy(2, [
    { ...ok, scheme: 'batch-settlement' },
    ok,
    { ...ok, amount: '10001' },
    { ...ok, payTo: '0x0000000000000000000000000000000000000bad' },
    { ...ok, network: 'eip155:1' },
    { ...ok, asset: '0x0000000000000000000000000000000000000001' },
    { ...ok, amount: '7e3' },
  ]);
  assert.deepEqual(kept, [ok]);
});
