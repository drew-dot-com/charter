import type { HomeAccess, JobSpec, Lease, Micro, Offer } from '../types.js';
import { GRACE_MS, tickLeadMs } from '../lease.js';
import { HostError, type HostApi } from './host-api.js';

export type LeaseEvent =
  | { kind: 'opened'; leaseId: string }
  | { kind: 'boot_failed'; leaseId: string; error?: string }
  | { kind: 'ticked'; index: number; paidIntervals: number }
  | { kind: 'status'; state: Lease['state']; paidIntervals: number; access?: HomeAccess | null }
  | { kind: 'output'; bytes: number }
  | { kind: 'stopped'; reason: 'max_intervals' | 'closed' | 'done' | 'stalled' | 'no_paid_through' };

export interface RunLeaseOpts {
  /** The most ticks to pay. After the last one it waits out the paid time, reads the lease once more and returns. */
  maxIntervals: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (e: LeaseEvent) => void;
}

export interface RunLeaseResult {
  lease: Lease;
  output?: Buffer;
  spent: Micro;
  /** Why the host refused to boot the job, when it did. */
  error?: string;
}

/**
 * Open a lease, pay tick 0 at once (the host creates the container at open and starts it only when
 * tick 0 is paid), then keep paying one tick per interval until the job finishes, the lease closes,
 * or `maxIntervals` ticks are paid.
 */
export async function runLease(api: HostApi, o: Offer, job: JobSpec, opts: RunLeaseOpts): Promise<RunLeaseResult> {
  checkMaxIntervals(opts.maxIntervals);
  const now = opts.now ?? Date.now;
  const emit = opts.onEvent ?? (() => undefined);
  const spent0 = api.spent();

  const opened = await api.open(job);
  if (opened.state === 'closed') {
    emit({ kind: 'boot_failed', leaseId: opened.leaseId, ...(opened.error ? { error: opened.error } : {}) });
    // The host has nothing more to say about a lease that never booted, so none is bought.
    const lease: Lease = {
      id: opened.leaseId, offerId: o.id, job, state: 'closed', createdAt: now(), paidIntervals: 0,
      closedReason: opened.closedReason ?? 'boot_failed',
    };
    return { lease, spent: api.spent() - spent0, ...(opened.error ? { error: opened.error } : {}) };
  }
  emit({ kind: 'opened', leaseId: opened.leaseId });
  // This tenant just opened the lease, so tick 0 is next and no read is needed first.
  const r = await payLease(api, o, opened.leaseId, opts, false);
  return { ...r, spent: api.spent() - spent0 };
}

function checkMaxIntervals(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('maxIntervals must be a positive integer');
}

/** The tick index a caller expected is not the host's count of paid ticks. No tick was paid. */
export class FromMismatchError extends Error {
  constructor(
    readonly from: number,
    readonly hostPaidIntervals: number,
  ) {
    super(`--from ${from} does not match the host's paid intervals ${hostPaidIntervals}; no tick was paid`);
    this.name = 'FromMismatchError';
  }
}

/**
 * Pay an open lease someone may have paid before, with the loop runLease runs after its open: up to
 * `maxIntervals` more ticks, until the job finishes or the lease closes. The lease is read first and the
 * next tick index is the host's `paidIntervals`: a guessed index would buy duplicates (too low) or a paid
 * 409 (too high). A `from` that differs from the host's count throws FromMismatchError before any tick.
 */
export async function continueLease(api: HostApi, o: Offer, leaseId: string, opts: RunLeaseOpts & { from?: number }): Promise<RunLeaseResult> {
  return payLease(api, o, leaseId, opts, true);
}

async function payLease(api: HostApi, o: Offer, leaseId: string, opts: RunLeaseOpts & { from?: number }, attach: boolean): Promise<RunLeaseResult> {
  checkMaxIntervals(opts.maxIntervals);
  if (opts.from !== undefined && (!Number.isSafeInteger(opts.from) || opts.from < 0)) throw new Error('from must be a non-negative integer');
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emit = opts.onEvent ?? (() => undefined);
  const intervalMs = o.intervalSeconds * 1000;
  /** The read and the next tick go out this long before the paid time ends (see tickLeadMs). */
  const leadMs = tickLeadMs(o.intervalSeconds);
  const spent0 = api.spent();
  const result = (lease: Lease, extra: { output?: Buffer; error?: string } = {}): RunLeaseResult => ({
    lease,
    spent: api.spent() - spent0,
    ...extra,
  });

  /** The lease as the host reports it, with the output fetched when it is done. */
  const settle = async (): Promise<{ lease: Lease; output?: Buffer; finished: boolean }> => {
    const lease = await api.status(leaseId);
    emit({ kind: 'status', state: lease.state, paidIntervals: lease.paidIntervals, ...(lease.access !== undefined ? { access: lease.access } : {}) });
    if (lease.state === 'done') {
      const output = lease.outputParts ? await api.output(leaseId) : Buffer.alloc(0);
      emit({ kind: 'output', bytes: output.length });
      emit({ kind: 'stopped', reason: 'done' });
      return { lease, output, finished: true };
    }
    if (lease.state === 'closed') {
      emit({ kind: 'stopped', reason: 'closed' });
      return { lease, finished: true };
    }
    return { lease, finished: false };
  };

  /**
   * Local (tenant clock) estimate of when the paid time runs out, counted from when a tick was SENT:
   * the host's clock runs while the packet travels. Taken from the host only when attaching to a lease
   * this tenant did not pay before, as it has no send time of its own for those ticks.
   */
  let paidUntil: number | undefined;
  /** The next tick index. Ticks sent since `start`, whatever the host reports, are the spend cap. */
  let ticksSent = 0;
  if (attach) {
    const s = await settle();
    if (s.finished) return result(s.lease, s.output ? { output: s.output } : {});
    if (opts.from !== undefined && opts.from !== s.lease.paidIntervals) throw new FromMismatchError(opts.from, s.lease.paidIntervals);
    ticksSent = s.lease.paidIntervals;
    paidUntil = s.lease.paidThrough;
  }
  let start = ticksSent;

  /** Pay the next tick. A 409 means the lease is no longer running: read it, never retry the tick. */
  const pay = async (): Promise<{ ended: RunLeaseResult } | { hostPaidThrough: boolean }> => {
    const index = ticksSent++;
    const sentAt = now();
    try {
      const t = await api.tick(leaseId, index);
      emit({ kind: 'ticked', index, paidIntervals: t.paidIntervals });
      // The host extends the paid time by one interval from its current end, so the local estimate
      // does the same, starting from when the first tick was sent.
      if (!t.duplicate || paidUntil === undefined) paidUntil = (paidUntil ?? sentAt) + intervalMs;
      return { hostPaidThrough: t.paidThrough !== undefined };
    } catch (e) {
      if (e instanceof HostError && e.status === 409 && (e.error === 'lease_done' || e.error === 'not_running')) {
        const s = await settle();
        return { ended: result(s.lease, s.output ? { output: s.output } : {}) };
      }
      throw e;
    }
  };

  /**
   * Read the lease until `until` (tenant clock): first GRACE_MS after the tick, then at doubling
   * gaps, then once at `until`. A job that exits in seconds is seen in seconds whatever the
   * interval, and an hour of waiting costs at most nine status reads. Returns the last read.
   */
  const watchUntil = async (until: number) => {
    let gap = GRACE_MS;
    for (;;) {
      const at = Math.min(now() + gap, until);
      await sleep(Math.max(0, at - now()));
      const s = await settle();
      if (s.finished || now() >= until) return s;
      gap *= 2;
    }
  };

  while (attach && paidUntil !== undefined && paidUntil - leadMs > now()) {
    // Paid ahead (a restarted boot.sh, say): pay only when the tick is due, so a re-run costs no extra
    // tick. The wait reads the lease, so a close meanwhile ends it with nothing paid.
    const w = await watchUntil(paidUntil - leadMs);
    if (w.finished) return result(w.lease, w.output ? { output: w.output } : {});
    // Someone else may have paid meanwhile: take the host's count again, so no tick is a duplicate.
    if (w.lease.paidIntervals === ticksSent) break;
    ticksSent = start = w.lease.paidIntervals;
    paidUntil = w.lease.paidThrough;
  }

  let p = await pay();
  for (;;) {
    if ('ended' in p) return p.ended;
    if (!p.hostPaidThrough) {
      // A host that accepts a tick but names no paid time is not paid again: look once and stop.
      const s = await settle();
      if (!s.finished) emit({ kind: 'stopped', reason: 'no_paid_through' });
      return result(s.lease, s.output ? { output: s.output } : {});
    }
    const s = await watchUntil(paidUntil! - leadMs);
    if (s.finished) return result(s.lease, s.output ? { output: s.output } : {});
    if (ticksSent - start >= opts.maxIntervals) {
      // No more ticks, but the last interval is paid for: watch it out, to its end.
      const last = await watchUntil(paidUntil!);
      if (!last.finished) emit({ kind: 'stopped', reason: 'max_intervals' });
      return result(last.lease, last.output ? { output: last.output } : {});
    }
    if (s.lease.paidIntervals < ticksSent) {
      // The host did not count the tick just paid. Paying again would buy nothing.
      emit({ kind: 'stopped', reason: 'stalled' });
      return result(s.lease);
    }
    p = await pay();
  }
}
