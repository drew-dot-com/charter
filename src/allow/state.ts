// The biller's own record of the money it holds for each allowance. The door's allowance log is the public
// mirror; this file is what keeps the biller from pulling, paying or refunding twice, so a broken one stops
// the biller rather than starting it fresh.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AllowEntry {
  allowanceId: string;
  /** USDC (decimal micro) pulled from the person's account and not yet paid out as ticks or refunded. */
  creditMicro: string;
  /** The permission's spend this period when the in-flight pull was sent (decimal micro). */
  periodSpentSeen?: string;
  /**
   * A pull sent whose answer has not come: saved before the send. The next status read settles it: if the
   * period's spend grew by the amount, it landed and goes to credit. `periodEndsAt` is the period it was
   * sent in, so a pull lost across a period reset is never guessed at.
   */
  pullInFlight?: { micro: string; at: number; periodEndsAt?: number };
  /** When the biller first saw the home's lease closed (epoch ms); cleared when a lease runs again. */
  lapsedSince?: number;
  /** No pull is tried before this time (epoch ms), after the account was short. */
  nextTryAt?: number;
  /** A tick sent whose answer has not come: counted once the host's paidIntervals passes `index`. */
  tickInFlight?: { leaseId: string; index: number; micro: string };
  /**
   * A re-open sent whose answer has not come: counted when the door's newest lease for the home is no longer
   * `prevLeaseId` and that lease has a paid interval.
   */
  openInFlight?: { offerId: string; prevLeaseId: string; micro: string; at: number };
  /**
   * A refund sent whose answer has not come. It is never sent again: the chain may already hold it. The
   * allowance stays unended and a problem names it until Drew checks the chain and clears this by hand.
   */
  refundInFlight?: { to: string; micro: string; at: number };
  /** The lease is not read before this time (epoch ms): a lease read is a host call the door pays for. */
  nextReadAt?: number;
}

export interface AllowState {
  version: 1;
  entries: Record<string, AllowEntry>;
}

export function emptyState(): AllowState {
  return { version: 1, entries: {} };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isMicro = (x: unknown) => typeof x === 'string' && /^\d{1,78}$/.test(x);
const isTime = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const isCount = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const optTime = (x: unknown) => x === undefined || isTime(x);

function check(s: unknown): string | undefined {
  if (!isObj(s) || s.version !== 1) return 'version';
  if (!isObj(s.entries)) return 'entries';
  for (const [id, e] of Object.entries(s.entries)) {
    if (!isObj(e) || e.allowanceId !== id) return `entry ${id}`;
    if (!isMicro(e.creditMicro)) return `entry ${id} creditMicro`;
    if (e.periodSpentSeen !== undefined && !isMicro(e.periodSpentSeen)) return `entry ${id} periodSpentSeen`;
    if (![e.lapsedSince, e.nextTryAt, e.nextReadAt].every(optTime)) return `entry ${id} times`;
    const p = e.pullInFlight;
    if (p !== undefined && !(isObj(p) && isMicro(p.micro) && isTime(p.at) && optTime(p.periodEndsAt))) return `entry ${id} pullInFlight`;
    const t = e.tickInFlight;
    if (t !== undefined && !(isObj(t) && typeof t.leaseId === 'string' && isCount(t.index) && isMicro(t.micro))) return `entry ${id} tickInFlight`;
    const o = e.openInFlight;
    if (o !== undefined && !(isObj(o) && typeof o.offerId === 'string' && typeof o.prevLeaseId === 'string' && isMicro(o.micro) && isTime(o.at))) return `entry ${id} openInFlight`;
    const r = e.refundInFlight;
    if (r !== undefined && !(isObj(r) && typeof r.to === 'string' && isMicro(r.micro) && isTime(r.at))) return `entry ${id} refundInFlight`;
  }
  return undefined;
}

/** The biller's state, or a fresh one when the file does not exist. A file that does not read back throws. */
export function loadState(file: string): AllowState {
  if (!existsSync(file)) return emptyState();
  let s: unknown;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`allow state ${file} is not JSON; refusing to start fresh, which could pull or refund twice`);
  }
  const bad = check(s);
  if (bad) throw new Error(`allow state ${file} is not valid (${bad}); refusing to start fresh, which could pull or refund twice`);
  return s as AllowState;
}

/** Written whole to a tmp file (0600) and renamed over the old one, so a crash leaves one or the other. */
export function saveState(file: string, s: AllowState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
