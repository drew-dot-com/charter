import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostError, hostApi, type HostApi } from './host-api.js';
import { continueLease, FromMismatchError, runLease, type LeaseEvent } from './run-lease.js';
import { exitJob, HOURLY, OFFER, testHost } from './test-host.js';
import type { JobSpec } from '../types.js';

const JOB: JobSpec = { image: 'charter-job-fetch', args: { URLS: 'https://example.com' } };
const RESULT = Buffer.from(JSON.stringify({ ok: true, pages: ['a'] }));

test('happy path: the job exits after the 3rd tick, output equals the runner bytes, spent is exact', async () => {
  const events: LeaseEvent[] = [];
  const h = await testHost({
    runner: { output: async () => RESULT },
    afterTick: (host, n) => {
      if (n === 3) exitJob(host, host.store.all()[0]!.id, RESULT);
    },
  });
  try {
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, {
      maxIntervals: 10, now: () => h.clock.t, sleep: h.sleep, onEvent: (e) => events.push(e),
    });
    assert.equal(r.lease.state, 'done');
    assert.equal(r.lease.paidIntervals, 3);
    assert.deepEqual(r.output, RESULT);
    assert.equal(h.sent['charter-open'], 1);
    assert.equal(h.sent['charter-tick'], 3);
    assert.equal(r.spent, 1000n + 3n * 5000n + BigInt(h.sent['charter-status']) * 100n);
    assert.equal(h.sent['charter-status'], 6); // two reads a tick (10 s in, then the half-way read), one that sees done, one output part
    assert.ok(events.length > 0);
    // Each app is addressed under ilpBase and sealed to the host's connector: its key and its /ilp URL.
    for (const s of h.seen) {
      assert.equal(s.sealKey, OFFER.sealKey);
      assert.equal(s.sealUrl, OFFER.sealUrl);
    }
    assert.deepEqual(new Set(h.seen.map((s) => s.dest)), new Set(['g.test.charter-open', 'g.test.charter-tick', 'g.test.charter-status']));
    // After each tick it reads 10 s in, then at the half-way point (15 s before the paid time runs
    // out on a 30 s interval), where it pays again. Ticks paid early extend from paidThrough.
    assert.deepEqual(h.sleeps, [10_000, 5_000, 10_000, 20_000, 10_000]);
  } finally {
    h.close();
  }
});

test('boot failure: boot_failed, no tick paid, spent is the open price only', async () => {
  const h = await testHost({ runner: { create: async () => { throw new Error('no docker'); } } });
  try {
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 5, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(r.lease.state, 'closed');
    assert.equal(r.lease.closedReason, 'boot_failed');
    assert.equal(r.lease.paidIntervals, 0);
    assert.equal(r.output, undefined);
    assert.equal(r.spent, 1000n);
    assert.equal(h.sent['charter-tick'], 0);
    assert.equal(h.sent['charter-status'], 0);
  } finally {
    h.close();
  }
});

test('maxIntervals 2 with a job that never exits: exactly 2 ticks are paid', async () => {
  const h = await testHost();
  try {
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 2, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(h.sent['charter-tick'], 2);
    assert.equal(r.lease.paidIntervals, 2);
    assert.equal(r.lease.state, 'running');
    assert.equal(r.output, undefined);
    assert.equal(r.spent, 1000n + 2n * 5000n + BigInt(h.sent['charter-status']) * 100n);
  } finally {
    h.close();
  }
});

test('a 409 not_running on a tick reads status and returns closed, never retrying the tick', async () => {
  const h = await testHost({
    afterTick: (host, n) => {
      if (n === 1) {
        const l = host.store.all()[0]!;
        host.store.put({ ...l, state: 'closed', closedReason: 'missed_tick' });
      }
    },
  });
  try {
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 5, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(r.lease.state, 'closed');
    assert.equal(r.lease.closedReason, 'missed_tick');
    assert.equal(r.output, undefined);
    assert.equal(h.sent['charter-tick'], 1);
  } finally {
    h.close();
  }
});

test('a lease that goes done between the status read and the tick: 409 lease_done leads to the output', async () => {
  let ticks = 0;
  const h = await testHost({ runner: { output: async () => RESULT } });
  try {
    const orig = h.payer.send.bind(h.payer);
    h.payer.send = async (d, r, o) => {
      if (d.endsWith('charter-tick') && ++ticks === 2) exitJob(h, h.store.all()[0]!.id, RESULT);
      return orig(d, r, o);
    };
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 5, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(r.lease.state, 'done');
    assert.deepEqual(r.output, RESULT);
    assert.equal(ticks, 2);
    // The refused tick was still paid.
    assert.equal(r.spent, 1000n + 2n * 5000n + BigInt(h.sent['charter-status']) * 100n);
  } finally {
    h.close();
  }
});

test('hostApi: non-2xx answers throw HostError and are still counted in spent', async () => {
  const h = await testHost();
  try {
    const api = hostApi(h.payer, OFFER);
    await assert.rejects(api.tick('0'.repeat(32), 0), (e: unknown) => e instanceof HostError && e.status === 404 && e.error === 'not_found');
    await assert.rejects(api.status('0'.repeat(32)), (e: unknown) => e instanceof HostError && e.status === 404);
    assert.equal(api.spent(), 5100n);
  } finally {
    h.close();
  }
});

test('hostApi.output joins every 48 KiB part', async () => {
  const big = Buffer.alloc(48 * 1024 * 2 + 10, 7);
  const h = await testHost({ runner: { output: async () => big } });
  try {
    const api = hostApi(h.payer, OFFER);
    const { leaseId } = await api.open(JOB);
    await api.tick(leaseId, 0);
    exitJob(h, leaseId, big);
    const out = await api.output(leaseId);
    assert.equal(out.length, big.length);
    assert.ok(out.equals(big));
    assert.equal(h.sent['charter-status'], 3);
  } finally {
    h.close();
  }
});

test('maxIntervals reached: waits out the last paid interval, so a job that exits 5 s before its end is seen', async () => {
  const h = await testHost({ runner: { output: async () => RESULT } });
  try {
    const t0 = h.clock.t;
    const exitAt = t0 + 55_000; // the 2nd interval ends at t0 + 60_000
    let exited = false;
    const sleep = async (ms: number) => {
      const target = h.clock.t + ms;
      if (!exited && target >= exitAt) {
        exited = true;
        h.clock.t = exitAt;
        exitJob(h, h.store.all()[0]!.id, RESULT);
      }
      await h.sleep(target - h.clock.t);
    };
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 2, now: () => h.clock.t, sleep });
    assert.equal(h.sent['charter-tick'], 2);
    assert.equal(r.lease.state, 'done');
    assert.deepEqual(r.output, RESULT);
    assert.equal(h.clock.t, t0 + 55_000); // the watch past the last tick saw the exit itself, before paidThrough
    assert.equal(r.spent, 1000n + 2n * 5000n + BigInt(h.sent['charter-status']) * 100n);
  } finally {
    h.close();
  }
});

test('a host that stalls paidIntervals: at most 2 ticks are paid and runLease returns', async () => {
  const h = await testHost({
    afterTick: (host) => {
      const l = host.store.all()[0]!;
      host.store.put({ ...l, paidIntervals: 1 });
    },
  });
  try {
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 10, now: () => h.clock.t, sleep: h.sleep });
    assert.ok(h.sent['charter-tick'] <= 2, `ticks paid: ${h.sent['charter-tick']}`);
    assert.equal(r.lease.state, 'running');
  } finally {
    h.close();
  }
});

test('never more than maxIntervals ticks, whatever the host reports', async () => {
  // The host forgets every tick: status always says 0 paid intervals.
  const h = await testHost({
    afterTick: (host) => {
      const l = host.store.all()[0]!;
      host.store.put({ ...l, paidIntervals: 0 });
    },
  });
  try {
    await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 3, now: () => h.clock.t, sleep: h.sleep });
    assert.ok(h.sent['charter-tick'] <= 3, `ticks paid: ${h.sent['charter-tick']}`);
  } finally {
    h.close();
  }
});

test('a host whose tick answer leaves out paidThrough is not paid again: runLease returns without a second tick', async () => {
  const h = await testHost();
  try {
    const orig = h.payer.send.bind(h.payer);
    h.payer.send = async (d, r, o) => {
      const a = await orig(d, r, o);
      if (d.endsWith('charter-tick') && a.status === 200) {
        const { paidThrough: _p, ...rest } = a.body as Record<string, unknown>;
        return { ...a, body: rest };
      }
      return a;
    };
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 10, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(h.sent['charter-tick'], 1);
    assert.equal(r.lease.state, 'running');
    assert.equal(r.output, undefined);
  } finally {
    h.close();
  }
});

test('a host clock far in the past: ticks are still spaced by the interval (local time)', async () => {
  const h = await testHost({
    skewMs: -10 * 60_000,
    runner: { output: async () => RESULT },
    afterTick: (host, n) => {
      if (n === 4) exitJob(host, host.store.all()[0]!.id, RESULT);
    },
  });
  try {
    const r = await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 10, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(r.lease.state, 'done');
    assert.equal(h.sent['charter-tick'], 4);
    // 10 s in and then the half-way read after each tick, spaced by the tenant's own clock.
    assert.deepEqual(h.sleeps, [10_000, 5_000, 10_000, 20_000, 10_000, 20_000, 10_000]);
  } finally {
    h.close();
  }
});

test('a slow tick send: the paid time counts from when the tick was sent, not from when the answer came', async () => {
  // Each tick takes 12 s to come back (a hidden host over an onion hop). The paid interval still
  // started when the tick left, so the first read goes out 15 s before THAT end: 3 s after the
  // answer, not 10 s after it; the read after the next slow tick comes 10 s in.
  const h = await testHost();
  try {
    const orig = h.payer.send.bind(h.payer);
    h.payer.send = async (d, r, o) => {
      const a = await orig(d, r, o);
      if (d.endsWith('charter-tick')) h.clock.t += 12_000;
      return a;
    };
    await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 3, now: () => h.clock.t, sleep: h.sleep });
    assert.deepEqual(h.sleeps.slice(0, 2), [3_000, 10_000]);
  } finally {
    h.close();
  }
});

test('the lead before the paid time ends is half the interval, and never under the 10 s grace', async () => {
  const h = await testHost();
  try {
    // A 16 s interval: half is 8 s, under the grace, so the lead is 10 s and the first sleep 6 s.
    const short = { ...OFFER, intervalSeconds: 16 };
    await runLease(hostApi(h.payer, short), short, JOB, { maxIntervals: 1, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(h.sleeps[0], 6_000);
  } finally {
    h.close();
  }
});

// ---------- the hourly offer: a short job must not wait for the half-hour ----------

/** A sleep that lets the job exit at `exitAt` on the tenant's clock, mid-sleep if need be. */
function sleepWithExit(h: Awaited<ReturnType<typeof testHost>>, exitAt: number) {
  let exited = false;
  return async (ms: number) => {
    const target = h.clock.t + ms;
    if (!exited && target >= exitAt) {
      exited = true;
      h.clock.t = exitAt;
      exitJob(h, h.store.all()[0]!.id, RESULT);
    }
    await h.sleep(target - h.clock.t);
  };
}

test('hourly offer: a job that exits 5 s after tick 0 is seen within 10 s, not at the half-hour', async () => {
  const h = await testHost({ offer: HOURLY, runner: { output: async () => RESULT } });
  try {
    const t0 = h.clock.t;
    const r = await runLease(hostApi(h.payer, HOURLY), HOURLY, JOB, {
      maxIntervals: 3, now: () => h.clock.t, sleep: sleepWithExit(h, t0 + 5_000),
    });
    assert.equal(r.lease.state, 'done');
    assert.deepEqual(r.output, RESULT);
    assert.equal(h.sent['charter-tick'], 1);
    assert.ok(h.clock.t - t0 <= 10_000, `returned after ${(h.clock.t - t0) / 1000} s`);
    assert.equal(r.spent, 1000n + 7000n + BigInt(h.sent['charter-status']) * 100n);
  } finally {
    h.close();
  }
});

test('hourly offer: a job that never exits is read with doubling gaps from 10 s, so an hour costs a handful of reads', async () => {
  const h = await testHost({ offer: HOURLY, runner: { output: async () => RESULT } });
  try {
    const t0 = h.clock.t;
    const r = await runLease(hostApi(h.payer, HOURLY), HOURLY, JOB, { maxIntervals: 2, now: () => h.clock.t, sleep: h.sleep });
    assert.equal(h.sent['charter-tick'], 2);
    assert.equal(r.lease.state, 'running');
    // Reads after a tick: 10 s, then 20, 40, 80, 160, 320, 640 s, then the half-hour read that pays.
    assert.deepEqual(h.sleeps.slice(0, 7), [10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000]);
    assert.equal(h.clock.t, t0 + 7_200_000); // the last paid hour was waited out, to its end
    // At most nine reads a watched hour (about 0.0009 USDC): two hours of ticks and the wait-out of the second.
    assert.ok(h.sent['charter-status'] <= 27, `${h.sent['charter-status']} status reads for three watched hours`);
  } finally {
    h.close();
  }
});

test('continueLease pays from the given index and stops at max-intervals without opening', async () => {
  let t = 1_000_000;
  const ticks: number[] = [];
  let paidThrough = t + 20_000;
  let paidIntervals = 2;
  const api: HostApi = {
    open: async () => { throw new Error('open must not be called'); },
    tick: async (_id, index) => {
      ticks.push(index);
      paidIntervals++;
      paidThrough += 30_000;
      return { paidIntervals, paidThrough, duplicate: false };
    },
    status: async (id) => ({ id, offerId: OFFER.id, job: JOB, state: 'running', createdAt: 0, paidIntervals, paidThrough }),
    output: async () => Buffer.alloc(0),
    outputPart: async () => { throw new Error('no output'); },
    spent: () => 0n,
  };
  const r = await continueLease(api, OFFER, 'a'.repeat(32), {
    from: 2, maxIntervals: 2, now: () => t, sleep: async (ms) => void (t += ms),
  });
  assert.deepEqual(ticks, [2, 3]);
  assert.equal(r.lease.state, 'running');
  assert.equal(r.lease.paidIntervals, 4);
  // The paid time is seeded from the host's paidThrough: the last read is at its end, 20 s + 2 intervals out.
  assert.equal(t, 1_000_000 + 20_000 + 2 * 30_000);
});

/** A host fake that orders ticks like onTick: a duplicate below its count, a 409 out_of_order above it. */
function orderedHost(paid: number, clock: { t: number }) {
  const ticks: number[] = [];
  let paidIntervals = paid;
  let paidThrough = clock.t + 20_000;
  const api: HostApi = {
    open: async () => { throw new Error('open must not be called'); },
    tick: async (_id, index) => {
      ticks.push(index);
      if (index < paidIntervals) return { paidIntervals, paidThrough, duplicate: true };
      if (index > paidIntervals) throw new HostError(409, 'out_of_order');
      paidIntervals++;
      paidThrough = Math.max(paidThrough, clock.t) + 30_000;
      return { paidIntervals, paidThrough, duplicate: false };
    },
    status: async (id) => ({ id, offerId: OFFER.id, job: JOB, state: 'running', createdAt: 0, paidIntervals, paidThrough }),
    output: async () => Buffer.alloc(0),
    outputPart: async () => { throw new Error('no output'); },
    spent: () => 0n,
  };
  return { api, ticks };
}

test('continueLease reads the host count first: no from pays from it, a wrong from pays no tick', async () => {
  const clock = { t: 1_000_000 };
  const opts = { maxIntervals: 2, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
  const a = orderedHost(5, clock);
  const r = await continueLease(a.api, OFFER, 'a'.repeat(32), opts);
  assert.deepEqual(a.ticks, [5, 6]);
  assert.equal(r.lease.paidIntervals, 7);
  for (const from of [0, 4, 6]) {
    const b = orderedHost(5, clock);
    await assert.rejects(continueLease(b.api, OFFER, 'a'.repeat(32), { ...opts, from }), (e: unknown) => e instanceof FromMismatchError && e.hostPaidIntervals === 5 && e.from === from);
    assert.deepEqual(b.ticks, []);
  }
});

test('continueLease waits until a tick is due: paid two intervals out, the first tick goes at paidThrough - lead', async () => {
  const t0 = 1_000_000;
  let t = t0;
  const tickedAt: number[] = [];
  let paidIntervals = 3;
  let paidThrough = t0 + 2 * 30_000;
  const api: HostApi = {
    open: async () => { throw new Error('open must not be called'); },
    tick: async () => {
      tickedAt.push(t);
      paidIntervals++;
      paidThrough += 30_000;
      return { paidIntervals, paidThrough, duplicate: false };
    },
    status: async (id) => ({ id, offerId: OFFER.id, job: JOB, state: 'running', createdAt: 0, paidIntervals, paidThrough }),
    output: async () => Buffer.alloc(0),
    outputPart: async () => { throw new Error('no output'); },
    spent: () => 0n,
  };
  const r = await continueLease(api, OFFER, 'a'.repeat(32), { maxIntervals: 1, now: () => t, sleep: async (ms) => void (t += ms) });
  // OFFER is 30 s, so the lead is 15 s: due at 60 s - 15 s = 45 s after attaching, not before.
  assert.deepEqual(tickedAt, [t0 + 45_000]);
  assert.equal(r.lease.paidIntervals, 4);
});

test('continueLease that sees the lease close while waiting for the tick to be due pays nothing', async () => {
  let t = 1_000_000;
  let ticks = 0;
  let reads = 0;
  const paidThrough = t + 2 * 30_000;
  const api: HostApi = {
    open: async () => { throw new Error('open must not be called'); },
    tick: async () => { ticks++; return { paidIntervals: 4, paidThrough, duplicate: false }; },
    status: async (id) => ({
      id, offerId: OFFER.id, job: JOB, createdAt: 0, paidIntervals: 3, paidThrough,
      ...(++reads > 1 ? { state: 'closed' as const, closedReason: 'missed_tick' as const } : { state: 'running' as const }),
    }),
    output: async () => Buffer.alloc(0),
    outputPart: async () => { throw new Error('no output'); },
    spent: () => 0n,
  };
  const r = await continueLease(api, OFFER, 'a'.repeat(32), { maxIntervals: 3, now: () => t, sleep: async (ms) => void (t += ms) });
  assert.equal(ticks, 0);
  assert.equal(r.lease.state, 'closed');
});
