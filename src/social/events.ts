import type { Sources } from './sources.js';

export const MILESTONES = [24, 100, 500, 1000] as const;
export const STALE_EVENT_MS = 6 * 3_600_000;

export type SocialEvent =
  | { id: string; kind: 'renter_returned'; at: number; leaseId: string; payer: string; hoursPaid: number }
  | { id: string; kind: 'milestone'; at: number; leaseId: string; hours: 24 | 100 | 500 | 1000; payer?: string; grantId?: string }
  | { id: string; kind: 'grant_approved'; at: number; grantId: string }
  | { id: string; kind: 'host_listed'; at: number; hostId: string };

const milestoneId = (leaseId: string, hours: number): string => `milestone:${leaseId}:${hours}`;

type Lease = Sources['leases'][number];

/** Seconds of service a lease's renter has paid for: settled ticks times the lease's own interval (0 if unknown). */
export function secondsPaid(l: Lease): number {
  const iv = Number(l.offer?.intervalSeconds);
  const ticks = Number(l.ticksPaidByRenter);
  if (!Number.isFinite(iv) || iv <= 0 || !Number.isFinite(ticks) || ticks <= 0) return 0;
  return ticks * iv;
}

/** Whole hours a lease's renter has paid for. A tick is an hour only at a 3600 s interval. */
export const hoursPaid = (l: Lease): number => Math.floor(secondsPaid(l) / 3600);

/** Whole hours paid across leases (summed before rounding down). */
export const totalHoursPaid = (leases: readonly Lease[]): number => Math.floor(leases.reduce((n, l) => n + secondsPaid(l), 0) / 3600);

/** Ids of the lower milestones of the same lease: a lease that jumped past several marks them all seen. */
export function impliedSeen(e: SocialEvent): string[] {
  if (e.kind !== 'milestone') return [];
  return MILESTONES.filter((h) => h < e.hours).map((h) => milestoneId(e.leaseId, h));
}

/** Events in the door's data not yet in `seen`, oldest first. Staleness and first-run rules are the caller's. */
export function detectEvents(src: Sources, seen: ReadonlySet<string>, cfg: { firstParty: Set<string>; probes: Set<string> }): SocialEvent[] {
  const out: SocialEvent[] = [];
  const grantOfLease = new Map<string, string>();
  for (const g of src.grants) if (g.leaseId) grantOfLease.set(g.leaseId, g.grantId);

  for (const l of src.leases) {
    const at = l.lastTickAt ?? l.createdAt;
    const hours = hoursPaid(l);
    const grantId = grantOfLease.get(l.leaseId);
    const payer = l.payer?.toLowerCase();
    let outsider: string | undefined;
    // A probe wallet never produces a public post, grant lease or not.
    if (payer && cfg.probes.has(payer)) continue;
    if (grantId === undefined) {
      // Only a grant lease is exempt from the first-party exclusion.
      if (!payer || cfg.firstParty.has(payer)) continue;
      outsider = payer;
      const id = `returned:${l.leaseId}`;
      // The trigger is the second paid tick, whatever the interval; the event states whole hours paid.
      if (l.ticksPaidByRenter >= 2 && !seen.has(id)) out.push({ id, kind: 'renter_returned', at, leaseId: l.leaseId, payer, hoursPaid: hours });
    }
    // Only the highest milestone reached counts; the lower ones are implied.
    const reached = MILESTONES.filter((m) => hours >= m).pop();
    if (reached === undefined) continue;
    const id = milestoneId(l.leaseId, reached);
    if (seen.has(id)) continue;
    out.push(grantId !== undefined
      ? { id, kind: 'milestone', at, leaseId: l.leaseId, hours: reached, grantId }
      : { id, kind: 'milestone', at, leaseId: l.leaseId, hours: reached, payer: outsider });
  }

  for (const g of src.grants) {
    const id = `grant:${g.grantId}`;
    if (g.state === 'queued' || g.state === 'declined' || seen.has(id)) continue;
    out.push({ id, kind: 'grant_approved', at: g.decidedAt ?? g.updatedAt, grantId: g.grantId });
  }

  for (const h of src.hosts) {
    const id = `host:${h.hostId}`;
    if (!(h.probes?.passed > 0) || seen.has(id)) continue;
    out.push({ id, kind: 'host_listed', at: h.probes.lastAt ?? h.registeredAt, hostId: h.hostId });
  }

  return out.sort((a, b) => a.at - b.at);
}
