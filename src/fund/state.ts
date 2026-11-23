// The grant fund's own record of what it paid. The door's grant log is the public mirror; this file is
// what keeps the fund from paying twice, so a broken one stops the fund rather than starting it fresh.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GrantState } from '../door/grants.js';

/** A change the fund still has to post to the door (`POST /v1/fund/grants/:id`). */
export interface DoorPatch {
  state?: GrantState;
  leaseId?: string;
  paidHours?: number;
  renewedByGrantee?: boolean;
}

export interface FundGrant {
  grantId: string;
  leaseId?: string;
  /** Hours the fund paid on this grant, across the first lease and a re-open. Never more than 720. */
  fundTicks: number;
  reopened: boolean;
  lastPaidAt?: number;
  /** Set when the grant is over without completing (ended_early, stopped, expired). Nothing is paid after it. */
  endedAt?: number;
  /** Set at completion: the lease is read until then only to see whether the grantee renews. */
  watchUntil?: number;
  /** Hours the fund paid on the current lease, compared with the host's paidIntervals. */
  leaseTicks?: number;
  /** The keys and image the home was opened with, for a re-open. Public keys, not secrets. */
  home?: { sshKeys: string[]; image: string };
  /** No open or tick for this grant before this time (epoch ms), after a refused one. */
  backoffUntil?: number;
  /**
   * The lease is not read before this time (epoch ms). A door lease read is a host status call the door
   * pays for, so the fund reads when the next tick is due (about once an hour), not every cycle.
   */
  nextReadAt?: number;
  renewedByGrantee?: boolean;
  /**
   * An open (or the re-open) sent whose outcome is not known yet: set and saved before `POST /v1/rent`,
   * cleared on a definite answer. While it is set, any retry goes to the same offer only, so the host's
   * one-home-per-key-set check (`home_in_use`) stops a second home.
   */
  opening?: { offerId: string; at: number };
  /** The offer the current lease was opened on, for the per-host cap on live grant homes. */
  offerId?: string;
  /**
   * Set when `home_in_use` answered a retry of an unanswered open: the fund may have paid for a home it
   * cannot see. Nothing more is paid for this grant until Drew stops it.
   */
  openUnknown?: number;
  /** A tick sent whose answer never came: counted once the host's paidIntervals passes `index`. */
  inflight?: { leaseId: string; index: number; price: string };
  /**
   * A tick answered with an error the door may have given after it paid the host (a 5xx such as a host send
   * timeout, a 402 settlement failure): the host may count the hour though the fund's payment did not settle.
   * When the next read shows the host past `index`, that hour is the door's: it raises leaseTicks only (not
   * fundTicks, not the day's spend), so it is never read as the grantee paying.
   */
  hostPaid?: { leaseId: string; index: number };
  /** What the fund paid on this grant on one UTC day (`day` YYYY-MM-DD, `micro` decimal), for its day cap. */
  daySpend?: { day: string; micro: string };
  pending?: DoorPatch;
}

export interface FundState {
  grants: Record<string, FundGrant>;
  /**
   * The fund's whole spend on one UTC day (`day` YYYY-MM-DD, `micro` a decimal string): the sum of every
   * grant's `daySpend`, kept for the record. The day cap itself is per grant.
   */
  spend: { day: string; micro: string };
  stopAll: boolean;
  stopped: string[];
  /** Failed judge calls per queued grant id; a pitch is declined as unreadable after MAX_JUDGE_TRIES. */
  judgeAttempts: Record<string, number>;
}

export function emptyState(): FundState {
  return { grants: {}, spend: { day: '', micro: '0' }, stopAll: false, stopped: [], judgeAttempts: {} };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const isTime = (x: unknown) => x === undefined || (typeof x === 'number' && Number.isFinite(x));

function check(s: unknown): string | undefined {
  if (!isObj(s)) return 'not an object';
  if (!isObj(s.spend) || typeof s.spend.day !== 'string' || typeof s.spend.micro !== 'string' || !/^\d+$/.test(s.spend.micro)) return 'spend';
  if (typeof s.stopAll !== 'boolean') return 'stopAll';
  if (!Array.isArray(s.stopped) || !s.stopped.every((x) => typeof x === 'string')) return 'stopped';
  if (!isObj(s.grants)) return 'grants';
  for (const [id, g] of Object.entries(s.grants)) {
    if (!isObj(g) || g.grantId !== id) return `grant ${id}`;
    if (!isCount(g.fundTicks) || typeof g.reopened !== 'boolean') return `grant ${id} counts`;
    if (g.leaseId !== undefined && typeof g.leaseId !== 'string') return `grant ${id} leaseId`;
    if (g.leaseTicks !== undefined && !isCount(g.leaseTicks)) return `grant ${id} leaseTicks`;
    if (![g.lastPaidAt, g.endedAt, g.watchUntil, g.backoffUntil, g.nextReadAt, g.openUnknown].every(isTime)) return `grant ${id} times`;
    const o = g.opening;
    if (o !== undefined && !(isObj(o) && typeof o.offerId === 'string' && typeof o.at === 'number' && Number.isFinite(o.at))) return `grant ${id} opening`;
    if (g.offerId !== undefined && typeof g.offerId !== 'string') return `grant ${id} offerId`;
    const f = g.inflight;
    if (f !== undefined && !(isObj(f) && typeof f.leaseId === 'string' && isCount(f.index) && typeof f.price === 'string' && /^\d+$/.test(f.price))) return `grant ${id} inflight`;
    const h = g.hostPaid;
    if (h !== undefined && !(isObj(h) && typeof h.leaseId === 'string' && isCount(h.index))) return `grant ${id} hostPaid`;
    const d = g.daySpend;
    if (d !== undefined && !(isObj(d) && typeof d.day === 'string' && typeof d.micro === 'string' && /^\d+$/.test(d.micro))) return `grant ${id} daySpend`;
  }
  const j = s.judgeAttempts;
  if (j !== undefined && !(isObj(j) && Object.values(j).every(isCount))) return 'judgeAttempts';
  return undefined;
}

/** The fund's state, or a fresh one when the file does not exist. A file that does not read back throws. */
export function loadState(file: string): FundState {
  if (!existsSync(file)) return emptyState();
  let s: unknown;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`fund state ${file} is not JSON; refusing to start fresh, which could pay a grant twice`);
  }
  const bad = check(s);
  if (bad) throw new Error(`fund state ${file} is not valid (${bad}); refusing to start fresh, which could pay a grant twice`);
  // A file written before judgeAttempts (and the per-grant daySpend and hostPaid, which stay optional) existed
  // reads as no failed attempts: a deployed fund is never stranded by a newer field.
  const out = s as FundState;
  out.judgeAttempts ??= {};
  return out;
}

/** Written whole to a tmp file (0600) and renamed over the old one, so a crash leaves one or the other. */
export function saveState(file: string, s: FundState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
