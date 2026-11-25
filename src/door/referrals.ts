import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAddress } from 'viem';

/**
 * Reads the `referral` a renter named. undefined: none named. 'bad_referral': malformed, a mixed-case address
 * failing its checksum, the zero address, or one of `refuse` (lower case). Else the address in lower case.
 */
export function parseReferral(v: unknown, refuse: ReadonlyArray<string | undefined>): string | undefined | 'bad_referral' {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !isAddress(v)) return 'bad_referral';
  const a = v.toLowerCase();
  if (a === '0x' + '0'.repeat(40)) return 'bad_referral';
  if (refuse.includes(a)) return 'bad_referral';
  return a;
}

/** floor(paid * bps / 10000); on a host that is not listed, at most `fee`. */
export function shareOf(a: { paid: bigint; fee: bigint; bps: number; hostListed: boolean }): bigint {
  const share = (a.paid * BigInt(a.bps)) / 10_000n;
  return a.hostListed || share <= a.fee ? share : a.fee;
}

/** The referral store's file, in the data dir beside the ledger. */
export const REFERRALS_FILE = 'referrals.json';

export interface ReferrerRecord {
  earned: bigint;
  paid: bigint;
  hours: number;
  /** why payouts are held */
  held?: string;
  /** epoch ms owed last rose from 0 */
  owedSince?: number;
}

interface StoredRecord {
  earned: string;
  paid: string;
  hours: number;
  held?: string;
  owedSince?: number;
}

/** Per-address earned and paid totals, and which referrer each home is bound to. bigints are decimal strings on disk. */
export class ReferralStore {
  private readonly referrers = new Map<string, ReferrerRecord>();
  private readonly homes = new Map<string, string>();

  constructor(private readonly file: string) {
    const raw = readIfThere(file);
    if (raw === undefined) return;
    const j = JSON.parse(raw) as { referrers?: Record<string, StoredRecord>; homes?: Record<string, string> };
    for (const [a, r] of Object.entries(j.referrers ?? {})) {
      const rec: ReferrerRecord = { earned: BigInt(r.earned), paid: BigInt(r.paid), hours: r.hours };
      if (r.held !== undefined) rec.held = r.held;
      if (r.owedSince !== undefined) rec.owedSince = r.owedSince;
      this.referrers.set(a, rec);
    }
    for (const [h, a] of Object.entries(j.homes ?? {})) this.homes.set(h, a);
  }

  accrue(address: string, micro: bigint, at: number): void {
    const a = address.toLowerCase();
    const r = this.referrers.get(a) ?? { earned: 0n, paid: 0n, hours: 0 };
    if (r.earned === r.paid) delete r.owedSince;
    r.hours += 1;
    r.earned += micro;
    if (r.earned > r.paid && r.owedSince === undefined) r.owedSince = at;
    this.referrers.set(a, r);
    this.save();
  }

  get(address: string): ReferrerRecord | undefined {
    const r = this.referrers.get(address.toLowerCase());
    return r && { ...r };
  }

  all(): Array<{ address: string } & ReferrerRecord> {
    return [...this.referrers].map(([address, r]) => ({ address, ...r }));
  }

  owed(address: string): bigint {
    const r = this.referrers.get(address.toLowerCase());
    return r ? r.earned - r.paid : 0n;
  }

  totalOwed(): bigint {
    let t = 0n;
    for (const r of this.referrers.values()) t += r.earned - r.paid;
    return t;
  }

  markPaid(address: string, micro: bigint): void {
    const r = this.referrers.get(address.toLowerCase());
    if (!r) return;
    r.paid += micro;
    if (r.earned - r.paid <= 0n) delete r.owedSince;
    this.save();
  }

  hold(address: string, reason: string): void {
    const r = this.referrers.get(address.toLowerCase());
    if (!r) return;
    r.held = reason;
    this.save();
  }

  release(address: string): void {
    const r = this.referrers.get(address.toLowerCase());
    if (!r) return;
    delete r.held;
    this.save();
  }

  homeReferrer(homeId: string): string | undefined {
    return this.homes.get(homeId);
  }

  /** False, and nothing changes, when the home is already bound. */
  bindHome(homeId: string, address: string): boolean {
    if (this.homes.has(homeId)) return false;
    this.homes.set(homeId, address.toLowerCase());
    this.save();
    return true;
  }

  /** Operator only: sets or replaces. */
  setHome(homeId: string, address: string | undefined): void {
    if (address === undefined) this.homes.delete(homeId);
    else this.homes.set(homeId, address.toLowerCase());
    this.save();
  }

  private save(): void {
    const referrers: Record<string, StoredRecord> = {};
    for (const [a, r] of this.referrers) {
      const s: StoredRecord = { earned: r.earned.toString(), paid: r.paid.toString(), hours: r.hours };
      if (r.held !== undefined) s.held = r.held;
      if (r.owedSince !== undefined) s.owedSince = r.owedSince;
      referrers[a] = s;
    }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ referrers, homes: Object.fromEntries(this.homes) }), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function readIfThere(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
