import type { JobSpec, Lease, Micro, Offer } from '../types.js';
import { GRACE_MS } from '../lease.js';
import { HostError, type HostApi } from './host-api.js';

export type LeaseEvent =
  | { kind: 'opened'; leaseId: string }
  | { kind: 'boot_failed'; leaseId: string; error?: string }
  | { kind: 'ticked'; index: number; paidIntervals: number }
  | { kind: 'status'; state: Lease['state']; paidIntervals: number }
  | { kind: 'output'; bytes: number }
  | { kind: 'stopped'; reason: 'max_intervals' | 'closed' | 'done' };

export interface RunLeaseOpts {
  /** The most ticks to pay. After the last one, polling continues only to report where the lease stands. */
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

/** Ten seconds early: the host closes a lease 10 s past its paid time. */
const EARLY_MS = GRACE_MS;

/**
 * Open a lease, pay tick 0 at once, then keep paying one tick per interval
 * until the job finishes, the lease closes, or `maxIntervals` ticks are paid.
 */
export async function runLease(api: HostApi, o: Offer, job: JobSpec, opts: RunLeaseOpts): Promise<RunLeaseResult> {
  if (!Number.isSafeInteger(opts.maxIntervals) || opts.maxIntervals < 1) throw new Error('maxIntervals must be a positive integer');
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emit = opts.onEvent ?? (() => undefined);
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

  /** Pay tick `index`. A 409 means the lease is no longer running: read it, never retry the tick. */
  const pay = async (index: number): Promise<{ paidThrough?: number } | { ended: RunLeaseResult }> => {
    try {
      const t = await api.tick(leaseId, index);
      emit({ kind: 'ticked', index, paidIntervals: t.paidIntervals });
      return t.paidThrough === undefined ? {} : { paidThrough: t.paidThrough };
    } catch (e) {
      if (e instanceof HostError && e.status === 409 && (e.error === 'lease_done' || e.error === 'not_running')) {
        const s = await settle();
        return { ended: result(s.lease, s.output ? { output: s.output } : {}) };
      }
      throw e;
    }
  };

  let paid = await pay(0);
  for (;;) {
    if ('ended' in paid) return paid.ended;
    if (paid.paidThrough !== undefined) await sleep(Math.max(0, paid.paidThrough - EARLY_MS - now()));
    const s = await settle();
    if (s.finished) return result(s.lease, s.output ? { output: s.output } : {});
    if (s.lease.paidIntervals >= opts.maxIntervals) {
      emit({ kind: 'stopped', reason: 'max_intervals' });
      return result(s.lease);
    }
    paid = await pay(s.lease.paidIntervals);
  }
}
