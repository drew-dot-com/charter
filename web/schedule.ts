import type { Lease } from '../src/types.js';

/** How long before the paid time runs out the next tick is paid, in ms. */
export const TICK_LEAD_MS = 10_000;

/**
 * Epoch ms at which the renter should pay the lease's next tick, or null when
 * no tick is due: the lease is over, or not ready to be paid yet.
 * Pure: no clock, no wallet, no DOM.
 */
export function nextTickAt(lease: Lease, now: number): number | null {
  switch (lease.state) {
    case 'awaiting_first_tick':
      return now;
    case 'running':
      return lease.paidThrough === undefined ? null : lease.paidThrough - TICK_LEAD_MS;
    default:
      return null;
  }
}
