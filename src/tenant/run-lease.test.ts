import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostError, hostApi } from './host-api.js';
import { runLease, type LeaseEvent } from './run-lease.js';
import { exitJob, OFFER, testHost } from './test-host.js';
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
    assert.equal(h.sent['charter-status'], 4); // three polls plus one output part
    assert.ok(events.length > 0);
    // Each app is addressed under ilpBase and sealed to the host's connector: its key and its /ilp URL.
    for (const s of h.seen) {
      assert.equal(s.sealKey, OFFER.sealKey);
      assert.equal(s.sealUrl, OFFER.sealUrl);
    }
    assert.deepEqual(new Set(h.seen.map((s) => s.dest)), new Set(['g.test.charter-open', 'g.test.charter-tick', 'g.test.charter-status']));
    // It sleeps until halfway through the paid interval (15 s before the paid time runs out on a
    // 30 s interval). Ticks paid early extend from paidThrough, so: 30 s - 15 s, then a full 30 s each time.
    assert.deepEqual(h.sleeps, [15_000, 30_000, 30_000]);
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
    assert.equal(h.clock.t, t0 + 60_000); // it slept to paidThrough, not paidThrough minus 10 s
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
    // Halfway through the first interval (15 s before the paid time runs out), then a full interval each time.
    assert.deepEqual(h.sleeps, [15_000, 30_000, 30_000, 30_000]);
  } finally {
    h.close();
  }
});

test('a slow tick send: the paid time counts from when the tick was sent, not from when the answer came', async () => {
  // Each tick takes 12 s to come back (a hidden host over an onion hop). The paid interval still
  // started when the tick left, so the next read and tick go out 15 s before THAT end: 3 s after
  // the answer, not 15 s after it.
  const h = await testHost();
  try {
    const orig = h.payer.send.bind(h.payer);
    h.payer.send = async (d, r, o) => {
      const a = await orig(d, r, o);
      if (d.endsWith('charter-tick')) h.clock.t += 12_000;
      return a;
    };
    await runLease(hostApi(h.payer, OFFER), OFFER, JOB, { maxIntervals: 3, now: () => h.clock.t, sleep: h.sleep });
    assert.deepEqual(h.sleeps.slice(0, 2), [3_000, 18_000]);
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
