import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Micro, Offer } from '../types.js';

/** One line per paid exact hour: the Base transaction that settled it. Lives beside the ledger file. */
export const TICK_TXS_FILE = 'tick-txs.jsonl';

/** The whole offer as it was when a lease opened, kept in the ledger: bigint prices as decimal strings. */
export interface OfferSnapshot {
  id: string;
  hostId: string;
  url: string;
  payTo: `0x${string}`;
  cpu: number;
  memoryMiB: number;
  intervalSeconds: number;
  firstTickGraceSeconds: number;
  tickPrice: string;
  openPrice: string;
  statusPrice: string;
  images: string[];
  hiddenHost: boolean;
  hiddenEgress: boolean;
  expiresAt: number;
  home?: Offer['home'];
}

export function snapshotOffer(o: Offer): OfferSnapshot {
  return { ...o, images: [...o.images], tickPrice: o.tickPrice.toString(), openPrice: o.openPrice.toString(), statusPrice: o.statusPrice.toString() };
}

export function offerOfSnapshot(s: OfferSnapshot): Offer {
  return { ...s, images: [...s.images], tickPrice: BigInt(s.tickPrice), openPrice: BigInt(s.openPrice), statusPrice: BigInt(s.statusPrice) };
}

/** One lease the door opened for a renter. */
export interface DoorLease {
  leaseId: string;
  /** `<hostId>:<id>`, as the renter named it. */
  offerId: string;
  /** The x402 payer address, when the payment carried one. */
  payer?: string;
  /** Ticks whose x402 payment settled. */
  ticksPaidByRenter: number;
  /** Ticks the host answered 2xx. */
  ticksPaidToHost: number;
  /** Micro-USDC the door paid a host for ticks the renter's payment never settled. */
  losses: Micro;
  /** Why `losses` is above zero: the renter's payment did not settle, the host refused the tick the door paid for, or the tick timed out on a deposit. */
  lossKind?: LossKind;
  /** Epoch ms of the loss. */
  lossAt?: number;
  /**
   * Epoch ms a `deposit_timeout` loss was credited back: its deposit lapsed unlanded, so no money moved. `losses`
   * keeps what was booked. The unpaid total (and the deposit_timeout total) is reduced only when the lapse is seen
   * in the same UTC day the loss was booked: the ledger keeps no earlier day's totals.
   */
  lossReversedAt?: number;
  /** The door will not pay another tick for this lease. */
  stopped: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** The tick index the door will accept next: one past the last tick the host accepted. */
  nextIndex: number;
  /** Paid host status and output calls made for this lease's free reads. */
  hostReads: number;
  /** The offer as resolved when the lease was opened. Every host call and price for this lease comes from here, never the host's current offer. */
  offer: OfferSnapshot;
  /** The door's fee per tick at open (CHARTER_DOOR_FEE), micro-USDC as a decimal string: the renter pays the tick price plus this. Absent: 0. */
  fee?: string;
  /** A home lease: the home's id (homeIdOf its keys). */
  homeId?: string;
  /** The address named at open, lower case. */
  referral?: string;
  /** Epoch ms of the newest tick the host accepted. */
  lastTickAt?: number;
  /** How the lease went for its host, once known: told to the host registry once. */
  outcome?: LeaseOutcome;
}

/** finished: the lease ended `done` or `max_intervals`. host_failed: boot_failed, a refused or unanswered tick. */
export type LeaseOutcome = 'finished' | 'host_failed';

/**
 * settle_failed: the payer's payment failed for a reason that is theirs (no balance, a used nonce, a bad signature).
 * settle_failed_transient: it failed for any other reason (facilitator down, an authorization that expired in the queue).
 * host_refused: the host answered the tick with an error, or the send timed out.
 * deposit_timeout: a host's first tick of the UTC day that timed out while its deposit was landing on chain. The
 * wait was the door's own, so it is door spend (unpaidToday), never the host's budget, and is credited back if the
 * deposit lapses unlanded. The host's later deposit timeouts that day are booked host_refused.
 */
export type LossKind = 'settle_failed' | 'settle_failed_transient' | 'host_refused' | 'deposit_timeout';

/** The ledger file's name inside the data dir. */
export const LEDGER_FILE = 'door-ledger.json';

/** How long a payer stays blocked after a settle_failed loss. */
export const BLOCK_MS = 24 * 3_600_000;

/** Payment-header hashes kept, newest last. */
export const MAX_PAYMENTS = 100_000;

interface Stored extends Omit<DoorLease, 'losses'> {
  losses: string;
}

/** The UTC day of an epoch ms, as YYYY-MM-DD. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The door's books: a JSON file, rewritten whole through a temp file and a rename. */
export class DoorLedger {
  private readonly leases = new Map<string, DoorLease>();
  /** Payers whose payment failed for their own reason, and when (epoch ms, the latest). */
  private readonly lossPayers = new Map<string, number>();
  /** `charter-door unblock`: payer to the epoch ms it was cleared. A separate file, so another process can write it. */
  private unblocked = new Map<string, number>();
  private unblocksSeen = '';
  /** sha256 hex of every payment header that reached the gate, oldest first. A Set keeps insertion order. */
  private readonly payments = new Set<string>();
  private readonly paymentsFile: string;
  private readonly unblocksFile: string;
  private readonly unpaidFile: string;
  private readonly hostLossFile: string;
  private readonly depositTimeoutsFile: string;
  private paymentLines = 0;
  /** Door spend no renter paid for (opens, free reads, losses the host is not to blame for) in one UTC day. */
  private unpaid: { day: string; micro: Micro } = { day: '', micro: 0n };
  /** host_refused losses per hostId in one UTC day: each host's own budget, apart from `unpaid`. */
  private hostLoss: { day: string; hosts: Map<string, Micro> } = { day: '', hosts: new Map() };
  /**
   * Deposit timeouts per hostId in one UTC day (the first is door spend, later ones count against the host), and
   * the door-wide `deposit_timeout` spend that day (held under the door's sub-cap).
   */
  private depositTimeouts: { day: string; hosts: Map<string, number>; micro: Micro } = { day: '', hosts: new Map(), micro: 0n };
  /**
   * Per host, the `deposit_timeout` loss whose deposit is still pending: a lapse of that host's pending deposit
   * credits it back. Cleared by the next deposit signed for the host. In memory, like the payer's pending deposits.
   */
  private readonly awaitingLapse = new Map<string, { leaseId: string; amount: Micro; at: number }>();

  constructor(
    private readonly file: string,
    private readonly maxPayments: number = MAX_PAYMENTS,
  ) {
    this.paymentsFile = `${file}.payments`;
    this.unblocksFile = `${file}.unblocks`;
    this.unpaidFile = `${file}.unpaid`;
    this.hostLossFile = `${file}.hostloss`;
    this.depositTimeoutsFile = `${file}.deposittimeouts`;
    const timeouts = readIfThere(this.depositTimeoutsFile);
    if (timeouts !== undefined) {
      const t = JSON.parse(timeouts) as { day?: unknown; hosts?: Record<string, unknown>; micro?: unknown };
      if (typeof t.day === 'string' && t.hosts && typeof t.hosts === 'object') {
        const hosts = new Map<string, number>();
        for (const [id, v] of Object.entries(t.hosts)) if (Number.isSafeInteger(v) && (v as number) > 0) hosts.set(id, v as number);
        const micro = typeof t.micro === 'string' && /^\d+$/.test(t.micro) ? BigInt(t.micro) : 0n;
        this.depositTimeouts = { day: t.day, hosts, micro };
      }
    }
    const hostLoss = readIfThere(this.hostLossFile);
    if (hostLoss !== undefined) {
      const h = JSON.parse(hostLoss) as { day?: unknown; hosts?: Record<string, unknown> };
      if (typeof h.day === 'string' && h.hosts && typeof h.hosts === 'object') {
        const hosts = new Map<string, Micro>();
        for (const [id, v] of Object.entries(h.hosts)) if (typeof v === 'string' && /^\d+$/.test(v)) hosts.set(id, BigInt(v));
        this.hostLoss = { day: h.day, hosts };
      }
    }
    const unpaid = readIfThere(this.unpaidFile);
    if (unpaid !== undefined) {
      const u = JSON.parse(unpaid) as { day?: unknown; micro?: unknown };
      if (typeof u.day === 'string' && typeof u.micro === 'string' && /^\d+$/.test(u.micro)) this.unpaid = { day: u.day, micro: BigInt(u.micro) };
    }
    const raw = readIfThere(file);
    if (raw !== undefined) {
      for (const s of JSON.parse(raw) as Array<Stored & Partial<Pick<DoorLease, 'nextIndex' | 'hostReads'>>>) {
        this.leases.set(s.leaseId, {
          ...s,
          losses: BigInt(s.losses),
          nextIndex: s.nextIndex ?? s.ticksPaidToHost,
          hostReads: s.hostReads ?? 0,
        });
        if (s.lossKind === 'settle_failed' && s.payer) this.lossPayers.set(s.payer, Math.max(this.lossPayers.get(s.payer) ?? 0, s.lossAt ?? 0));
      }
    }
    const lines = readIfThere(this.paymentsFile)?.split('\n').filter((l) => /^[0-9a-f]{64}$/.test(l)) ?? [];
    for (const h of lines.slice(-maxPayments)) this.payments.add(h);
    this.paymentLines = lines.length;
  }

  get(leaseId: string): DoorLease | undefined {
    const l = this.leases.get(leaseId);
    return l && { ...l };
  }

  all(): DoorLease[] {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }

  open(o: { leaseId: string; offerId: string; createdAt: number; offer: OfferSnapshot; fee?: string; homeId?: string; referral?: string }): void {
    const { referral, ...rest } = o;
    this.leases.set(o.leaseId, {
      ...rest,
      ...(referral !== undefined ? { referral: referral.toLowerCase() } : {}),
      ticksPaidByRenter: 0,
      ticksPaidToHost: 0,
      losses: 0n,
      stopped: false,
      nextIndex: 0,
      hostReads: 0,
    });
    this.save();
  }

  /** True when any lease of this home has ticksPaidByRenter > 0. */
  homeHasPaidHour(homeId: string): boolean {
    for (const l of this.leases.values()) if (l.homeId === homeId && l.ticksPaidByRenter > 0) return true;
    return false;
  }

  /** The host answered a tick 2xx, at `at` (epoch ms). */
  hostTick(leaseId: string, at?: number): void {
    this.update(leaseId, (l) => {
      l.ticksPaidToHost++;
      l.nextIndex++;
      if (at !== undefined) l.lastTickAt = at;
    });
  }

  /** Records how the lease went for its host. True only the first time: a lease has one outcome. */
  outcome(leaseId: string, kind: LeaseOutcome): boolean {
    if (this.leases.get(leaseId)?.outcome !== undefined) return false;
    this.update(leaseId, (l) => void (l.outcome = kind));
    return true;
  }

  /** The renter's payment for a tick settled. */
  renterTick(leaseId: string, payer?: string): void {
    this.update(leaseId, (l) => {
      l.ticksPaidByRenter++;
      if (payer) l.payer = payer.toLowerCase();
    });
  }

  /**
   * The settle transaction of the hour just paid, appended beside the ledger: one JSON line per paid exact hour,
   * `tick` being the 1-based hour number. A receipt never fails a payment, so a write that fails is dropped.
   */
  tickTx(leaseId: string, tx: string, at: number): void {
    try {
      const tick = this.leases.get(leaseId)?.ticksPaidByRenter ?? 0;
      appendFileSync(join(dirname(this.file), TICK_TXS_FILE), JSON.stringify({ leaseId, tick, tx, at }) + '\n');
    } catch {
      // Dropped on purpose.
    }
  }

  /**
   * Money the door paid (or may have paid) a host that the renter did not cover, at `at` (epoch ms). Only a
   * payment that failed for the payer's own reason blocks them from new ticks, and only for BLOCK_MS. A
   * `host_refused` loss counts against that host's daily budget (hostLossToday), not the door-wide unpaid spend:
   * one host cannot stop every renter's ticks. Every other kind is door-wide unpaid spend; a `deposit_timeout` is
   * credited back out of it if its deposit lapses unlanded (depositLapsed).
   */
  loss(leaseId: string, amount: Micro, kind: LossKind, at: number, payer?: string): void {
    const hostId = this.leases.get(leaseId)?.offer.hostId;
    if (kind === 'host_refused' && hostId) this.addHostLoss(hostId, amount, at);
    else this.addUnpaid(amount, at);
    if (kind === 'deposit_timeout' && amount > 0n) {
      this.addDepositTimeoutSpend(amount, at);
      if (hostId) this.awaitingLapse.set(hostId, { leaseId, amount, at });
    }
    this.update(leaseId, (l) => {
      l.losses += amount;
      l.lossKind = kind;
      l.lossAt = at;
      const who = payer?.toLowerCase() ?? l.payer;
      if (who) {
        l.payer = who;
        if (kind === 'settle_failed') this.lossPayers.set(who, at);
      }
    });
  }

  /** True while the payer has a settle_failed loss under BLOCK_MS old that no unblock has cleared. */
  payerHasLoss(payer: string, now: number): boolean {
    const who = payer.toLowerCase();
    const at = this.lossPayers.get(who);
    if (at === undefined || now - at >= BLOCK_MS) return false;
    this.refreshUnblocks();
    return at > (this.unblocked.get(who) ?? -1);
  }

  /** Clears a payer's block as of `at`. Safe from another process while the door runs. */
  unblock(payer: string, at: number): void {
    if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) throw new Error('unblock needs a 0x address of 40 hex digits');
    mkdirSync(dirname(this.unblocksFile), { recursive: true, mode: 0o700 });
    appendFileSync(this.unblocksFile, `${payer.toLowerCase()} ${at}\n`, { mode: 0o600 });
    this.refreshUnblocks();
  }

  /** Re-reads the unblock file when it has changed. */
  private refreshUnblocks(): void {
    let stamp: string;
    try {
      const st = statSync(this.unblocksFile);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return;
    }
    if (stamp === this.unblocksSeen) return;
    this.unblocksSeen = stamp;
    const m = new Map<string, number>();
    for (const line of (readIfThere(this.unblocksFile) ?? '').split('\n')) {
      const [who, at] = line.split(' ');
      if (who && /^\d+$/.test(at ?? '')) m.set(who, Math.max(m.get(who) ?? 0, Number(at)));
    }
    this.unblocked = m;
  }

  /** Micro-USDC the door spent that no renter paid for, in the UTC day of `at` (epoch ms). */
  unpaidToday(at: number): Micro {
    return this.unpaid.day === utcDay(at) ? this.unpaid.micro : 0n;
  }

  /** Adds door spend no renter paid for (an open, a free read, a loss) to the UTC day of `at`. Kept across a restart. */
  addUnpaid(amount: Micro, at: number): void {
    if (amount <= 0n) return;
    const day = utcDay(at);
    this.writeUnpaid({ day, micro: (this.unpaid.day === day ? this.unpaid.micro : 0n) + amount });
  }

  private writeUnpaid(u: { day: string; micro: Micro }): void {
    this.unpaid = u;
    mkdirSync(dirname(this.unpaidFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.unpaidFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ day: u.day, micro: u.micro.toString() }), { mode: 0o600 });
    renameSync(tmp, this.unpaidFile);
  }

  /** A deposit was signed for this host: the one before it has landed or lapsed, so no later lapse is a timed-out tick's. */
  depositSigned(hostId: string): void {
    this.awaitingLapse.delete(hostId);
  }

  /**
   * This host's pending deposit lapsed unlanded at `at`: no money moved. When a `deposit_timeout` loss waits on
   * it, that amount comes back out of the unpaid spend of the UTC day it was booked in (if that is still the day
   * counted), and the lease is marked `lossReversedAt`. Once per loss.
   */
  depositLapsed(hostId: string, at: number): void {
    const w = this.awaitingLapse.get(hostId);
    this.awaitingLapse.delete(hostId);
    if (!w) return;
    const l = this.leases.get(w.leaseId);
    if (!l || l.lossKind !== 'deposit_timeout' || l.lossReversedAt !== undefined) return;
    const day = utcDay(w.at);
    if (this.unpaid.day === day) {
      const micro = this.unpaid.micro > w.amount ? this.unpaid.micro - w.amount : 0n;
      this.writeUnpaid({ day, micro });
    }
    if (this.depositTimeouts.day === day) this.addDepositTimeoutSpend(-w.amount, w.at);
    this.update(w.leaseId, (r) => void (r.lossReversedAt = at));
  }

  /** Deposit timeouts of this host in the UTC day of `at` (epoch ms). */
  depositTimeoutsToday(hostId: string, at: number): number {
    return this.depositTimeouts.day === utcDay(at) ? (this.depositTimeouts.hosts.get(hostId) ?? 0) : 0;
  }

  /** Counts a deposit timeout of this host in the UTC day of `at` and returns that day's count. Kept across a restart. */
  countDepositTimeout(hostId: string, at: number): number {
    this.depositTimeoutDay(at);
    const n = (this.depositTimeouts.hosts.get(hostId) ?? 0) + 1;
    this.depositTimeouts.hosts.set(hostId, n);
    this.saveDepositTimeouts();
    return n;
  }

  /** Door-wide `deposit_timeout` spend in the UTC day of `at` (epoch ms), net of lapses credited back that day. */
  depositTimeoutSpendToday(at: number): Micro {
    return this.depositTimeouts.day === utcDay(at) ? this.depositTimeouts.micro : 0n;
  }

  private addDepositTimeoutSpend(amount: Micro, at: number): void {
    this.depositTimeoutDay(at);
    const micro = this.depositTimeouts.micro + amount;
    this.depositTimeouts.micro = micro > 0n ? micro : 0n;
    this.saveDepositTimeouts();
  }

  /** Starts the deposit-timeout counts afresh when `at` is in a new UTC day. */
  private depositTimeoutDay(at: number): void {
    const day = utcDay(at);
    if (this.depositTimeouts.day !== day) this.depositTimeouts = { day, hosts: new Map(), micro: 0n };
  }

  private saveDepositTimeouts(): void {
    const t = this.depositTimeouts;
    mkdirSync(dirname(this.depositTimeoutsFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.depositTimeoutsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ day: t.day, hosts: Object.fromEntries(t.hosts), micro: t.micro.toString() }), { mode: 0o600 });
    renameSync(tmp, this.depositTimeoutsFile);
  }

  /** What this host's refused ticks cost the door in the UTC day of `at` (epoch ms). */
  hostLossToday(hostId: string, at: number): Micro {
    return this.hostLoss.day === utcDay(at) ? (this.hostLoss.hosts.get(hostId) ?? 0n) : 0n;
  }

  /** Adds a host_refused loss to that host's UTC day of `at`. Kept across a restart. */
  private addHostLoss(hostId: string, amount: Micro, at: number): void {
    if (amount <= 0n) return;
    const day = utcDay(at);
    if (this.hostLoss.day !== day) this.hostLoss = { day, hosts: new Map() };
    this.hostLoss.hosts.set(hostId, (this.hostLoss.hosts.get(hostId) ?? 0n) + amount);
    const rows = Object.fromEntries([...this.hostLoss.hosts].map(([k, v]) => [k, v.toString()]));
    mkdirSync(dirname(this.hostLossFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.hostLossFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ day, hosts: rows }), { mode: 0o600 });
    renameSync(tmp, this.hostLossFile);
  }

  /** One paid host status or output call for a free read. */
  read(leaseId: string): void {
    this.update(leaseId, (l) => void l.hostReads++);
  }

  /** True when a payment with this key has verified before. */
  hasPayment(hash: string): boolean {
    return this.payments.has(hash);
  }

  /** Records the key of a payment that verified. Bounded: the oldest are forgotten past MAX_PAYMENTS. */
  addPayment(hash: string): void {
    if (this.payments.has(hash)) return;
    this.payments.add(hash);
    mkdirSync(dirname(this.paymentsFile), { recursive: true, mode: 0o700 });
    appendFileSync(this.paymentsFile, `${hash}\n`, { mode: 0o600 });
    this.paymentLines++;
    if (this.payments.size > this.maxPayments) this.payments.delete(this.payments.values().next().value!);
    if (this.paymentLines > this.maxPayments * 2) {
      const tmp = `${this.paymentsFile}.tmp`;
      writeFileSync(tmp, [...this.payments].join('\n') + '\n', { mode: 0o600 });
      renameSync(tmp, this.paymentsFile);
      this.paymentLines = this.payments.size;
    }
  }

  stop(leaseId: string): void {
    this.update(leaseId, (l) => void (l.stopped = true));
  }

  private update(leaseId: string, fn: (l: DoorLease) => void): void {
    const l = this.leases.get(leaseId);
    if (!l) throw new Error(`no door lease ${leaseId}`);
    fn(l);
    this.save();
  }

  private save(): void {
    const rows: Stored[] = [...this.leases.values()].map((l) => ({ ...l, losses: l.losses.toString() }));
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
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
