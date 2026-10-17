import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Micro, Offer } from '../types.js';

/** The whole offer as it was when a lease opened, kept in the ledger: bigint prices as decimal strings. */
export interface OfferSnapshot {
  id: string;
  hostPubkey: string;
  ilpBase: string;
  sealKey: string;
  sealUrl: string;
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
  /** `<pubkey>:<id>`, as the renter named it. */
  offerId: string;
  /** The x402 payer address, when the payment carried one. */
  payer?: string;
  /** Ticks whose x402 payment settled. */
  ticksPaidByRenter: number;
  /** Ticks the host answered 2xx. */
  ticksPaidToHost: number;
  /** Micro-USDC the door paid a host for ticks the renter's payment never settled. */
  losses: Micro;
  /** Why `losses` is above zero: the renter's payment did not settle, or the host refused the tick the door paid for. */
  lossKind?: LossKind;
  /** Epoch ms of the loss. */
  lossAt?: number;
  /** The door will not pay another tick for this lease. */
  stopped: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** The tick index the door will accept next: one past the last tick the host accepted. */
  nextIndex: number;
  /** Paid host status and output calls made for this lease's free reads. */
  hostReads: number;
  /** The offer as resolved when the lease was opened. Every host call and price for this lease comes from here, never the relay. */
  offer: OfferSnapshot;
}

/**
 * settle_failed: the payer's payment failed for a reason that is theirs (no balance, a used nonce, a bad signature).
 * settle_failed_transient: it failed for any other reason (facilitator down, an authorization that expired in the queue).
 * host_refused: the host answered the tick with an error, or the send timed out.
 */
export type LossKind = 'settle_failed' | 'settle_failed_transient' | 'host_refused';

/** The ledger file's name inside the data dir. */
export const LEDGER_FILE = 'door-ledger.json';

/** How long a payer stays blocked after a settle_failed loss. */
export const BLOCK_MS = 24 * 3_600_000;

/** Payment-header hashes kept, newest last. */
export const MAX_PAYMENTS = 100_000;

interface Stored extends Omit<DoorLease, 'losses'> {
  losses: string;
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
  private paymentLines = 0;

  constructor(
    private readonly file: string,
    private readonly maxPayments: number = MAX_PAYMENTS,
  ) {
    this.paymentsFile = `${file}.payments`;
    this.unblocksFile = `${file}.unblocks`;
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

  open(o: { leaseId: string; offerId: string; createdAt: number; offer: OfferSnapshot }): void {
    this.leases.set(o.leaseId, { ...o, ticksPaidByRenter: 0, ticksPaidToHost: 0, losses: 0n, stopped: false, nextIndex: 0, hostReads: 0 });
    this.save();
  }

  /** The host answered a tick 2xx. */
  hostTick(leaseId: string): void {
    this.update(leaseId, (l) => {
      l.ticksPaidToHost++;
      l.nextIndex++;
    });
  }

  /** The renter's payment for a tick settled. */
  renterTick(leaseId: string, payer?: string): void {
    this.update(leaseId, (l) => {
      l.ticksPaidByRenter++;
      if (payer) l.payer = payer.toLowerCase();
    });
  }

  /**
   * Money the door paid a host that the renter did not cover, at `at` (epoch ms). Only a payment that
   * failed for the payer's own reason blocks them from new ticks, and only for BLOCK_MS.
   */
  loss(leaseId: string, amount: Micro, kind: LossKind, at: number, payer?: string): void {
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
