// The door's registry of hosts anyone may register, and how much of its capital each may lock up.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import type { Offer } from '../types.js';
import type { CapitalBook } from './capital.js';
import type { ChannelChain, DoorChannel } from './channel-chain.js';
import type { DepositFor } from './host-http.js';
import { utcDay } from './ledger.js';
import { blockedAddress } from './safe-fetch.js';

/** The registry file's name inside the door data dir. */
export const HOSTS_FILE = 'hosts.json';

/** The longest host URL the door takes. */
export const MAX_HOST_URL_CHARS = 2048;

/** One host is never probed twice inside this window. */
export const PROBE_EVERY_MS = 86_400_000;

/** Probe failures in a row that drop a host. */
export const DROP_AFTER_FAILED_PROBES = 3;

/** Host-side lease failures in a row that hide a listed host until its next probe passes. */
export const HIDE_AFTER_HOST_FAILURES = 2;

/**
 * The canonical form of a host URL, or null when the door will not take it: `https:` only, no userinfo,
 * query or fragment; lowercase host without a trailing dot; no trailing slash. A host named by an IP literal
 * must be a public address (see blockedAddress); a name must have a dot and not be `localhost`. A name that
 * resolves inward is caught when fetched (safeFetch).
 */
export function normalizeHostUrl(u: string): string | null {
  if (typeof u !== 'string' || u.length > MAX_HOST_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (u.includes('?') || u.includes('#')) return null;
  const host = url.hostname.replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (blockedAddress(bare)) return null;
  } else if (!host.includes('.') || host.endsWith('.localhost')) return null;
  const port = url.port ? `:${url.port}` : '';
  return `https://${host}${port}${url.pathname.replace(/\/+$/, '')}`;
}

/** sha256 hex (64 chars) of a normalized host URL: the host's id, and the 64 hex of its `offerId`s. */
export function hostIdOf(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex');
}

/**
 * probing: registered, no probe since. listed: last probe passed. hidden: last probe failed, or two real leases
 * in a row failed on the host's side. dropped: three failed probes in a row.
 */
export type HostState = 'probing' | 'listed' | 'hidden' | 'dropped';

export interface HostRecord {
  hostId: string;
  /** Normalized. */
  url: string;
  state: HostState;
  /** Epoch ms of the first registration. */
  registeredAt: number;
  /** Epoch ms the host last answered the door well: an offer fetched or a probe passed. */
  lastSeenAt?: number;
  offer?: Offer;
  offerFetchedAt?: number;
  probes: {
    passed: number;
    failed: number;
    consecutiveFailed: number;
    /** Epoch ms of the last probe's result. */
    lastAt?: number;
    lastFailedAt?: number;
  };
  leases: { opened: number; finished: number; hostFailed: number; consecutiveHostFailed: number };
  intervalsPaid: number;
  /** A paid home lease on this host reached `running` with access published. */
  homeTested: boolean;
}

/** A host that has passed a probe, ever. */
export function isProven(r: HostRecord): boolean {
  return r.probes.passed > 0;
}

/** finished / (finished + host failures); 1 for a host with neither. */
export function successRate(r: HostRecord): number {
  const n = r.leases.finished + r.leases.hostFailed;
  return n === 0 ? 1 : r.leases.finished / n;
}

/** A host no real lease has ended on yet: it has no track record. */
export function isNewHost(r: HostRecord): boolean {
  return r.leases.finished + r.leases.hostFailed === 0;
}

/** Below this success rate a host is skipped while one at or above it fits. */
export const SUCCESS_FLOOR = 0.8;

/** A host's track record as renters see it, on each offer in `/v1/offers` and in `/v1/hosts`. */
export function publicRecord(r: HostRecord, fundingWaiting = false) {
  return {
    probesPassed: r.probes.passed,
    leasesFinished: r.leases.finished,
    successRate: successRate(r),
    new: isNewHost(r),
    ...(r.probes.lastFailedAt === undefined ? {} : { lastProbeFailedAt: r.probes.lastFailedAt }),
    ...(fundingWaiting ? { funding: 'waiting' as const } : {}),
  };
}

/**
 * Offers in the order the door picks them, for one job. Only listed hosts' offers appear, and none of a host
 * `waiting` for funding. Hosts under SUCCESS_FLOOR are dropped while one at or above it fits. Then: for a home
 * job a tested home before an untested one; a host with a record before a new one; the lower price; the lower
 * hostId; the lower offer id.
 */
export function rankOffers(list: Offer[], registry: HostRegistry, o: { home?: boolean; waiting?: (hostId: string) => boolean } = {}): Offer[] {
  const recs = new Map(registry.listed().map((r) => [r.hostId, r]));
  const fits = list.filter((x) => recs.has(x.hostId) && !o.waiting?.(x.hostId));
  const rec = (x: Offer): HostRecord => recs.get(x.hostId)!;
  const floorMet = fits.some((x) => successRate(rec(x)) >= SUCCESS_FLOOR);
  const kept = floorMet ? fits.filter((x) => successRate(rec(x)) >= SUCCESS_FLOOR) : fits;
  const flag = (b: boolean): number => (b ? 0 : 1);
  return kept.sort(
    (x, y) =>
      (o.home ? flag(rec(x).homeTested) - flag(rec(y).homeTested) : 0) ||
      flag(!isNewHost(rec(x))) - flag(!isNewHost(rec(y))) ||
      (x.tickPrice < y.tickPrice ? -1 : x.tickPrice > y.tickPrice ? 1 : 0) ||
      cmp(x.hostId, y.hostId) ||
      cmp(x.id, y.id),
  );
}

interface Stored {
  hosts: HostRecord[];
  homes: Record<string, string>;
  firstProbes: { day: string; count: number };
}

/** JSON with bigints (offer prices) kept as `{ "$bigint": "<decimal>" }`. */
const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $bigint: x.toString() } : x), 2);
const fromJson = (s: string): unknown =>
  JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$bigint === 'string' && Object.keys(x).length === 1 ? BigInt(x.$bigint) : x));

/** Every host the door knows, by hostId: a JSON file rewritten whole through a temp file and a rename. */
export class HostRegistry {
  private readonly hosts = new Map<string, HostRecord>();
  /** homeId to the hostId that holds its disk. */
  private readonly homes = new Map<string, string>();
  private firstProbes = { day: '', count: 0 };

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    const s = fromJson(raw) as Stored;
    for (const r of s.hosts) this.hosts.set(r.hostId, r);
    for (const [home, host] of Object.entries(s.homes)) this.homes.set(home, host);
    this.firstProbes = s.firstProbes;
  }

  /**
   * Adds a host, or answers the one already there. A dropped host comes back as `probing` with every counter
   * kept, its run of failed probes included: one more failed probe drops it again.
   */
  register(url: string, now: number): { hostId: string; state: HostState } | 'bad_url' {
    const n = normalizeHostUrl(url);
    if (n === null) return 'bad_url';
    const hostId = hostIdOf(n);
    const r = this.hosts.get(hostId);
    if (r) {
      if (r.state === 'dropped') {
        r.state = 'probing';
        this.save();
      }
      return { hostId, state: r.state };
    }
    this.hosts.set(hostId, {
      hostId, url: n, state: 'probing', registeredAt: now,
      probes: { passed: 0, failed: 0, consecutiveFailed: 0 },
      leases: { opened: 0, finished: 0, hostFailed: 0, consecutiveHostFailed: 0 },
      intervalsPaid: 0, homeTested: false,
    });
    this.save();
    return { hostId, state: 'probing' };
  }

  get(hostId: string): HostRecord | undefined {
    const r = this.hosts.get(hostId);
    return r && structuredClone(r);
  }

  all(): HostRecord[] {
    return [...this.hosts.values()].map((r) => structuredClone(r));
  }

  listed(): HostRecord[] {
    return this.all().filter((r) => r.state === 'listed');
  }

  setOffer(hostId: string, offer: Offer, now: number): void {
    this.update(hostId, (r) => {
      r.offer = offer;
      r.offerFetchedAt = now;
      r.lastSeenAt = now;
    });
  }

  /** A pass lists the host and clears its run of host failures; a fail hides it, and the third in a row drops it. */
  probeResult(hostId: string, passed: boolean, now: number): void {
    this.update(hostId, (r) => {
      const p = r.probes;
      p.lastAt = now;
      if (passed) {
        p.passed++;
        p.consecutiveFailed = 0;
        r.leases.consecutiveHostFailed = 0;
        r.state = 'listed';
        r.lastSeenAt = now;
      } else {
        p.failed++;
        p.consecutiveFailed++;
        p.lastFailedAt = now;
        r.state = p.consecutiveFailed >= DROP_AFTER_FAILED_PROBES ? 'dropped' : 'hidden';
      }
    });
  }

  leaseOpened(hostId: string): void {
    this.update(hostId, (r) => void r.leases.opened++);
  }

  /** A lease ended `done` or `max_intervals`, after `intervals` paid ticks. */
  leaseFinished(hostId: string, intervals: number): void {
    this.update(hostId, (r) => {
      r.leases.finished++;
      r.leases.consecutiveHostFailed = 0;
      r.intervalsPaid += intervals;
    });
  }

  /**
   * A lease failed on the host's side. The second in a row hides a listed host: it is listed again only when
   * its next probe, under the usual 24 h rule, passes.
   */
  leaseHostFailed(hostId: string, _now: number): void {
    this.update(hostId, (r) => {
      r.leases.hostFailed++;
      r.leases.consecutiveHostFailed++;
      if (r.leases.consecutiveHostFailed >= HIDE_AFTER_HOST_FAILURES && r.state === 'listed') r.state = 'hidden';
    });
  }

  markHomeTested(hostId: string): void {
    this.update(hostId, (r) => void (r.homeTested = true));
  }

  homeHost(homeId: string): string | undefined {
    return this.homes.get(homeId);
  }

  setHomeHost(homeId: string, hostId: string): void {
    this.homes.set(homeId, hostId);
    this.save();
  }

  /** First probes (of a host in `probing`) started in the UTC day of `now`. */
  firstProbesToday(now: number): number {
    return this.firstProbes.day === utcDay(now) ? this.firstProbes.count : 0;
  }

  /** Counts a first probe started at `now`. Kept across a restart. */
  countFirstProbe(now: number): void {
    this.firstProbes = { day: utcDay(now), count: this.firstProbesToday(now) + 1 };
    this.save();
  }

  /**
   * Host ids to probe now, in order. No host is probed twice inside PROBE_EVERY_MS. Listed and hidden hosts
   * come due daily, the longest unprobed first. First probes (`probing`) follow, oldest registration first,
   * at most `perDay` a UTC day: the rest wait.
   */
  dueProbes(now: number, firstProbesToday: number, perDay: number): string[] {
    const ready = (r: HostRecord): boolean => r.probes.lastAt === undefined || now - r.probes.lastAt >= PROBE_EVERY_MS;
    const hosts = [...this.hosts.values()].filter(ready);
    const again = hosts
      .filter((r) => r.state === 'listed' || r.state === 'hidden')
      .sort((a, b) => (a.probes.lastAt ?? 0) - (b.probes.lastAt ?? 0) || cmp(a.hostId, b.hostId));
    const first = hosts
      .filter((r) => r.state === 'probing')
      .sort((a, b) => a.registeredAt - b.registeredAt || cmp(a.hostId, b.hostId))
      .slice(0, Math.max(0, perDay - firstProbesToday));
    return [...again, ...first].map((r) => r.hostId);
  }

  private update(hostId: string, fn: (r: HostRecord) => void): void {
    const r = this.hosts.get(hostId);
    if (!r) throw new Error(`no host ${hostId}`);
    fn(r);
    this.save();
  }

  private save(): void {
    const s: Stored = { hosts: [...this.hosts.values()], homes: Object.fromEntries(this.homes), firstProbes: this.firstProbes };
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, toJson(s), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * How much the door deposits into a host's channel. Unproven hosts get `probeDeposit` while the sum locked
 * in all unproven hosts' channels, this deposit included, stays at or under `probeCap`; proven hosts get
 * `hostDeposit` within `hostCap` the same way. Past a cap, or for an unknown or dropped host: 'over_cap'.
 * `locked(hostId)` is what the door has put into that host's channels and not withdrawn. No side effects.
 */
export function capitalAllocator(o: {
  registry: HostRegistry;
  locked: (hostId: string) => bigint;
  probeDeposit: bigint;
  hostDeposit: bigint;
  probeCap: bigint;
  hostCap: bigint;
}): DepositFor {
  return (hostId) => {
    const r = o.registry.get(hostId);
    if (!r || r.state === 'dropped') return 'over_cap';
    const proven = isProven(r);
    let tier = 0n;
    for (const h of o.registry.all()) if (isProven(h) === proven) tier += o.locked(h.hostId);
    const [deposit, cap] = proven ? [o.hostDeposit, o.hostCap] : [o.probeDeposit, o.probeCap];
    return tier + deposit <= cap ? deposit : 'over_cap';
  };
}

/**
 * A proven host the door cannot fund now: nothing locked in its channels, and the allocator has no deposit for
 * it. It stays listed with `funding: 'waiting'` and is not picked. A host whose channel already holds funds needs
 * no deposit, so a full tier never freezes the hosts already funded.
 */
export function hostFundingWaiting(o: { registry: HostRegistry; locked: (hostId: string) => bigint; depositFor: DepositFor }): (hostId: string) => boolean {
  return (hostId) => {
    const r = o.registry.get(hostId);
    return r !== undefined && isProven(r) && o.locked(hostId) === 0n && o.depositFor(hostId) === 'over_cap';
  };
}

/** A channel with no lease or probe on its host for this long is withdrawn. */
export const IDLE_WITHDRAW_MS = 7 * 86_400_000;
/** How often the reaper looks. */
export const REAP_EVERY_MS = 3_600_000;

export interface ReaperDeps {
  registry: HostRegistry;
  payer: { channels(hostId: string): Promise<DoorChannel[]>; resync(hostId: string, channelId: string): Promise<void> };
  chain: ChannelChain;
  capital: Pick<CapitalBook, 'locked' | 'withdrawn'>;
  /** Epoch ms of the host's newest lease or probe; undefined when it never had one. */
  lastLeaseAt: (hostId: string) => number | undefined;
  /** An unstopped lease on the host had a host tick within its last interval: a dropped host is not withdrawn under it. */
  ticking: (hostId: string) => boolean;
  now: () => number;
  log: (msg: string) => void;
}

const bigMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * One round of the channel reaper. A host is due when it is dropped with no lease still ticking on it, or its last
 * lease is IDLE_WITHDRAW_MS old. Every channel: a withdrawal past its delay is finalized, whatever the host's
 * state. A due host's channel with funds the door does not owe the host (balance less the larger of claimed and
 * the door's own charged amount) and no withdrawal pending gets one asked for those funds. Once every channel of a
 * due host holds nothing of the door's (withdrawn, or refunded by the host itself), what `capital.locked` counts
 * for it is released. The door's record of a channel follows the chain after its balance moved. A channel id kept
 * under more than one host is never touched: whose it is cannot be told.
 */
export async function reapChannels(d: ReaperDeps): Promise<void> {
  const hosts = d.registry.all();
  const byHost = new Map<string, DoorChannel[]>();
  const owners = new Map<string, number>();
  for (const r of hosts) {
    const channels = await d.payer.channels(r.hostId);
    byHost.set(r.hostId, channels);
    for (const c of channels) owners.set(c.channelId, (owners.get(c.channelId) ?? 0) + 1);
  }
  for (const r of hosts) {
    const channels = byHost.get(r.hostId)!;
    if (channels.length === 0) continue;
    const last = d.lastLeaseAt(r.hostId);
    const idle = last === undefined || d.now() - last >= IDLE_WITHDRAW_MS;
    const due = (r.state === 'dropped' && !d.ticking(r.hostId)) || idle;
    let empty = true;
    for (const c of channels) {
      if (owners.get(c.channelId)! > 1) {
        empty = false;
        d.log(`channel ${c.channelId} is kept under more than one host; left alone`);
        continue;
      }
      try {
        let s = await d.chain.state(c.channelId);
        let finalized = false;
        if (s.withdrawInitiatedAt > 0 && d.now() / 1000 >= s.withdrawInitiatedAt + c.config.withdrawDelay) {
          await d.chain.finalizeWithdraw(c);
          const after = await d.chain.state(c.channelId);
          d.log(`channel ${c.channelId} of host ${r.url}: withdrawal finalized, ${s.balance - after.balance} micro-USDC back`);
          s = after;
          finalized = true;
        }
        // Only on a quiet channel: a busy one's record may be ahead of the chain by a deposit still landing.
        if (s.balance !== c.balance && (due || finalized)) await d.payer.resync(r.hostId, c.channelId);
        // What the door's vouchers already owe the host stays in the channel for it to claim.
        const free = s.balance - bigMax(s.totalClaimed, c.charged);
        if (free <= 0n && s.withdrawInitiatedAt === 0) continue;
        empty = false;
        if (due && s.withdrawInitiatedAt === 0) {
          await d.chain.initiateWithdraw(c, free);
          d.log(`channel ${c.channelId} of host ${r.url}: withdrawal of ${free} micro-USDC asked (${idle ? 'idle' : 'dropped'})`);
        }
      } catch (e) {
        empty = false;
        d.log(`channel ${c.channelId} of host ${r.url}: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
      }
    }
    const locked = d.capital.locked(r.hostId);
    if (due && empty && locked > 0n) {
      d.capital.withdrawn(r.hostId, locked);
      d.log(`host ${r.url}: channels empty, ${locked} micro-USDC of door capital released`);
    }
  }
}

/** Runs reapChannels now and every REAP_EVERY_MS, never two rounds at once. Returns a stop function. */
export function startChannelReaper(d: ReaperDeps): () => void {
  let busy = false;
  const round = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await reapChannels(d);
    } catch (e) {
      d.log(`channel reaper: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void round(), REAP_EVERY_MS);
  timer.unref();
  void round();
  return () => clearInterval(timer);
}
