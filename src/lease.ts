import type { CloseReason, JobSpec, Lease, Offer } from './types.js';

/** How long past the paid time (or past boot, before the first tick) a tick may be late. */
export const GRACE_MS = 10_000;

export class LeaseError extends Error {
  constructor(public readonly code: 'out_of_order' | 'not_running') {
    super(code);
    this.name = 'LeaseError';
  }
}

export function newLease(id: string, offer: Offer, job: JobSpec, now: number): Lease {
  return { id, offerId: offer.id, job, state: 'booting', createdAt: now, paidIntervals: 0 };
}

/** Only a booting lease can finish booting; anything else is returned unchanged. */
export function onBooted(l: Lease, now: number): Lease {
  if (l.state !== 'booting') return l;
  return { ...l, state: 'awaiting_first_tick', bootedAt: now };
}

/** Only a booting lease can fail to boot; anything else is returned unchanged. */
export function onBootFailed(l: Lease): Lease {
  if (l.state !== 'booting') return l;
  return { ...l, state: 'closed', closedReason: 'boot_failed' };
}

/**
 * Apply tick `index` (0-based). A tick already applied is a duplicate and changes
 * nothing. A tick ahead of the next expected one is out of order. Each new tick
 * extends the paid time by one interval, from the current paidThrough (or from
 * `now` for the first tick), so early payment never loses time.
 */
export function onTick(
  l: Lease,
  index: number,
  now: number,
  intervalMs: number,
): { lease: Lease; duplicate: boolean } {
  if (l.state !== 'awaiting_first_tick' && l.state !== 'running') {
    throw new LeaseError('not_running');
  }
  if (index < l.paidIntervals) return { lease: l, duplicate: true };
  if (index > l.paidIntervals) throw new LeaseError('out_of_order');
  const from = l.paidThrough ?? now;
  return {
    lease: { ...l, state: 'running', paidIntervals: l.paidIntervals + 1, paidThrough: from + intervalMs },
    duplicate: false,
  };
}

/** The job finished by itself. A lease that is already done or closed is returned unchanged. */
export function onJobExit(l: Lease, outputParts: number): Lease {
  if (l.state === 'done' || l.state === 'closed') return l;
  return { ...l, state: 'done', outputParts };
}

/** Whether the lease must be closed now, and why. */
export function due(l: Lease, now: number, graceMs: number): CloseReason | null {
  if (l.state === 'awaiting_first_tick' && l.bootedAt !== undefined && now > l.bootedAt + graceMs) {
    return 'missed_tick';
  }
  if (l.state === 'running' && l.paidThrough !== undefined && now > l.paidThrough + graceMs) {
    return 'missed_tick';
  }
  return null;
}
