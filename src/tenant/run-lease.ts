import type { JobSpec, Lease, Micro, Offer } from '../types.js';
import { tickLeadMs } from '../lease.js';
import { HostError, type HostApi } from './host-api.js';

export type LeaseEvent =
  | { kind: 'opened'; leaseId: string }
  | { kind: 'boot_failed'; leaseId: string; error?: string }
  | { kind: 'ticked'; index: number; paidIntervals: number }
  | { kind: 'status'; state: Lease['state']; paidIntervals: number }
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
  if (!Number.isSafeInteger(opts.maxIntervals) || opts.maxIntervals < 1) throw new Error('maxIntervals must be a positive integer');
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

  const opened = await api.open(job);
  if (opened.state === 'closed') {
    emit({ kind: 'boot_failed', leaseId: opened.leaseId, ...(opened.error ? { error: opened.error } : {}) });
    // The host has nothing more to say about a lease that never booted, so none is bought.
    const lease: Lease = {
      id: opened.leaseId, offerId: o.id, job, state: 'closed', createdAt: now(), paidIntervals: 0,
      closedReason: opened.closedReason ?? 'boot_failed',
    };
    return result(lease, opened.error ? { error: opened.error } : {});
  }
  emit({ kind: 'opened', leaseId: opened.leaseId });
  const leaseId = opened.leaseId;

  /** The lease as the host reports it, with the output fetched when it is done. */
  const settle = async (): Promise<{ lease: Lease; output?: Buffer; finished: boolean }> => {
    const lease = await api.status(leaseId);
    emit({ kind: 'status', state: lease.state, paidIntervals: lease.paidIntervals });
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
   * Local (tenant clock) estimate of when the paid time runs out. Never taken from the host, and
   * counted from when a tick was SENT: the host's clock runs while the packet travels.
   */
  let paidUntil: number | undefined;
  /** Ticks sent, whatever the host reports. This, not the host's count, is the spend cap. */
  let ticksSent = 0;

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

  let p = await pay();
  for (;;) {
    if ('ended' in p) return p.ended;
    if (!p.hostPaidThrough) {
      // A host that accepts a tick but names no paid time is not paid again: look once and stop.
      const s = await settle();
      if (!s.finished) emit({ kind: 'stopped', reason: 'no_paid_through' });
      return result(s.lease, s.output ? { output: s.output } : {});
    }
    await sleep(Math.max(0, paidUntil! - leadMs - now()));
    const s = await settle();
    if (s.finished) return result(s.lease, s.output ? { output: s.output } : {});
    if (ticksSent >= opts.maxIntervals) {
      // No more ticks, but the last interval is paid for: wait it out, then look once more.
      await sleep(Math.max(0, paidUntil! - now()));
      const last = await settle();
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
