import { tickLeadMs } from '../src/lease.js';
import type { Lease } from '../src/types.js';

/** How long before the paid time runs out the next tick is paid while the offer's interval is not known yet, in ms. */
export const TICK_LEAD_MS = 10_000;

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
