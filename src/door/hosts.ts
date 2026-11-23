// The door's registry of hosts anyone may register, and how much of its capital each may lock up.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import type { Offer } from '../types.js';
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

/** Host-side lease failures in a row that make a host due for a probe. */
export const PROBE_AFTER_HOST_FAILURES = 2;

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

/** probing: registered, no probe since. listed: last probe passed. hidden: last probe failed. dropped: three failed in a row. */
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
    /** Epoch ms the host became due for a probe outside its daily round (host failures in a row). */
    dueAt?: number;
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

  /** Adds a host, or answers the one already there; a dropped host comes back as `probing` with its record kept. */
  register(url: string, now: number): { hostId: string; state: HostState } | 'bad_url' {
    const n = normalizeHostUrl(url);
    if (n === null) return 'bad_url';
    const hostId = hostIdOf(n);
    const r = this.hosts.get(hostId);
    if (r) {
      if (r.state === 'dropped') {
        r.state = 'probing';
        // A fresh run of three: one more failure must not drop it again at once.
        r.probes.consecutiveFailed = 0;
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

  /** A pass lists the host; a fail hides it, and the third in a row drops it. */
  probeResult(hostId: string, passed: boolean, now: number): void {
    this.update(hostId, (r) => {
      const p = r.probes;
      p.lastAt = now;
      delete p.dueAt;
      if (passed) {
        p.passed++;
        p.consecutiveFailed = 0;
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

  /** A lease failed on the host's side; the second in a row makes the host due for a probe. */
  leaseHostFailed(hostId: string, now: number): void {
    this.update(hostId, (r) => {
      r.leases.hostFailed++;
      r.leases.consecutiveHostFailed++;
      if (r.leases.consecutiveHostFailed >= PROBE_AFTER_HOST_FAILURES && r.probes.dueAt === undefined) r.probes.dueAt = now;
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
   * come due daily; one with host failures in a row (`dueAt`) goes first, then the longest unprobed. First
   * probes (`probing`) follow, oldest registration first, at most `perDay` a UTC day: the rest wait.
   */
  dueProbes(now: number, firstProbesToday: number, perDay: number): string[] {
    const ready = (r: HostRecord): boolean => r.probes.lastAt === undefined || now - r.probes.lastAt >= PROBE_EVERY_MS;
    const hosts = [...this.hosts.values()].filter(ready);
    const again = hosts
      .filter((r) => r.state === 'listed' || r.state === 'hidden')
      .sort((a, b) => (a.probes.dueAt ?? Infinity) - (b.probes.dueAt ?? Infinity) || (a.probes.lastAt ?? 0) - (b.probes.lastAt ?? 0) || cmp(a.hostId, b.hostId));
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
