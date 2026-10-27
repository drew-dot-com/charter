import type { Lease } from '../src/types.js';
import { formatUsdc, landingLink } from './format.js';

/**
 * What the lease page saw happen, as a list the renter can read. Pure: it is fed each status the
 * page reads (`observe`) and the output it loads (`noteOutput`), with the clock passed in. A status
 * that is behind what was already seen (the door caches for a few seconds) adds nothing.
 */

export interface TimelineEvent {
  /** Epoch ms the page saw it. */
  at: number;
  text: string;
  /** A block explorer link, for a landing. */
  href?: string;
}

export interface Timeline {
  events: TimelineEvent[];
  /** The furthest the lease has been seen. */
  seen: Lease | undefined;
}

export const newTimeline = (): Timeline => ({ events: [], seen: undefined });

const RANK: Record<Lease['state'], number> = { booting: 0, awaiting_first_tick: 1, running: 2, done: 3, closed: 3 };

const CLOSED: Record<string, string> = {
  boot_failed: 'the machine did not start. Nothing is owed.',
  missed_tick: 'a payment was missed.',
  max_intervals: 'the lease reached its maximum length.',
  host_restart: 'the host restarted.',
  busy: 'the machine was busy with another lease. Nothing is owed.',
};

const plural = (n: number, one: string): string => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

function add(t: Timeline, at: number, text: string, href?: string): void {
  t.events.push({ at, text, ...(href ? { href } : {}) });
}

/** Feeds one status read. `tickPrice` (micro-USDC, decimal string) prices the intervals when known. */
export function observe(t: Timeline, lease: Lease, now: number, tickPrice?: string): void {
  const prev = t.seen;
  // Behind what was seen: nothing new.
  if (prev && (RANK[lease.state] < RANK[prev.state] || lease.paidIntervals < prev.paidIntervals)) return;

  if (!prev) {
    if (lease.paidIntervals > 0 || lease.state === 'done') {
      const n = lease.paidIntervals;
      add(t, now, `Joined the lease with ${n === 0 ? 'no intervals' : plural(n, 'interval')} paid.`);
    } else {
      add(t, now, 'Lease opened. The host is creating the machine.');
      if (lease.state === 'awaiting_first_tick') add(t, now, 'Machine created. Waiting for the first payment.');
    }
  } else {
    if (prev.state === 'booting' && lease.state === 'awaiting_first_tick') add(t, now, 'Machine created. Waiting for the first payment.');
    const from = prev.paidIntervals;
    const to = lease.paidIntervals;
    if (to > from) {
      const price = tickPrice !== undefined && /^\d+$/.test(tickPrice) ? `, ${formatUsdc(BigInt(tickPrice) * BigInt(to - from))}` : '';
      add(t, now, to - from === 1 ? `Interval ${to} paid${price}.` : `Intervals ${from + 1} to ${to} paid${price}.`);
    }
    if (RANK[prev.state] < RANK.running && lease.state === 'running') add(t, now, 'Machine started. The job is running.');
  }

  const wasFinal = prev !== undefined && RANK[prev.state] === 3;
  if (!wasFinal && lease.state === 'done') add(t, now, 'Job finished.');
  if (!wasFinal && lease.state === 'closed') {
    const why = lease.closedReason ? CLOSED[lease.closedReason] : undefined;
    add(t, now, why ? `Lease closed: ${why}` : 'Lease closed.');
  }
  if (lease.landing && !prev?.landing) {
    const link = landingLink(lease.landing);
    add(t, now, `The host's vouchers landed on chain${lease.landing.shared ? ', in a shared batch' : ''}.`, link?.href);
  }
  t.seen = lease;
}

/** The output was loaded. */
export function noteOutput(t: Timeline, now: number, bytes: number): void {
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  add(t, now, `Output received, ${size}.`);
}
