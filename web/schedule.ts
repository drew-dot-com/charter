import { tickLeadMs } from '../src/lease.js';
import type { Lease } from '../src/types.js';

/** How long before the paid time runs out the next tick is paid while the offer's interval is not known yet, in ms. */
export const TICK_LEAD_MS = 10_000;

/** How often the lease page reads a running lease, at most, in ms. */
export const POLL_MS = 5_000;

/**
 * The lease page's poll period for a running lease: every POLL_MS on a short or unknown interval, a
 * sixtieth of the interval past five minutes (a minute on an hourly lease), so a long lease's free reads
 * (one a paid minute) last the whole interval instead of the first four minutes.
 */
export function pollMs(intervalSeconds?: number): number {
  return Math.max(POLL_MS, ((intervalSeconds ?? 0) * 1000) / 60);
}

/**
 * Epoch ms at which the renter should pay the lease's next tick, or null when
 * no tick is due: the lease is over, or not ready to be paid yet. With the offer's
 * `intervalSeconds` the tick is due halfway through the paid interval (see tickLeadMs);
 * without it, TICK_LEAD_MS before the end.
 * Pure: no clock, no wallet, no DOM.
 */
export function nextTickAt(lease: Lease, now: number, intervalSeconds?: number): number | null {
  const lead = intervalSeconds === undefined ? TICK_LEAD_MS : tickLeadMs(intervalSeconds);
  switch (lease.state) {
    case 'awaiting_first_tick':
      return now;
    case 'running':
      return lease.paidThrough === undefined ? null : lease.paidThrough - lead;
    default:
      return null;
  }
}
