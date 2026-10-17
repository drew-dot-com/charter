import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Micro } from '../types.js';

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
  /** The door will not pay another tick for this lease. */
  stopped: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** The tick index the door will accept next: one past the last tick the host accepted. */
  nextIndex: number;
  /** Paid host status and output calls made for this lease's free reads. */
  hostReads: number;
}

export type LossKind = 'settle_failed' | 'host_refused';

/** Payment-header hashes kept, newest last. */
export const MAX_PAYMENTS = 100_000;

interface Stored extends Omit<DoorLease, 'losses'> {
  losses: string;
}

/** The door's books: a JSON file, rewritten whole through a temp file and a rename. */
export class DoorLedger {
  private readonly leases = new Map<string, DoorLease>();
  /** Payers the door has paid a host for and never been paid back by. */
  private readonly lossPayers = new Set<string>();
  /** sha256 hex of every payment header that reached the gate, oldest first. A Set keeps insertion order. */
  private readonly payments = new Set<string>();
  private readonly paymentsFile: string;
  private paymentLines = 0;

  constructor(
    private readonly file: string,
    private readonly maxPayments: number = MAX_PAYMENTS,
  ) {
    this.paymentsFile = `${file}.payments`;
    const raw = readIfThere(file);
    if (raw !== undefined) {
      for (const s of JSON.parse(raw) as Array<Stored & Partial<Pick<DoorLease, 'nextIndex' | 'hostReads'>>>) {
        this.leases.set(s.leaseId, {
          ...s,
          losses: BigInt(s.losses),
          nextIndex: s.nextIndex ?? s.ticksPaidToHost,
          hostReads: s.hostReads ?? 0,
        });
        if (s.lossKind === 'settle_failed' && s.payer) this.lossPayers.add(s.payer);
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

  open(o: { leaseId: string; offerId: string; createdAt: number }): void {
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
   * Money the door paid a host that the renter did not cover. Only a payment that failed to settle
   * blocks the payer from new ticks; a host that refused the tick is not the payer's doing.
   */
  loss(leaseId: string, amount: Micro, kind: LossKind, payer?: string): void {
    this.update(leaseId, (l) => {
      l.losses += amount;
      l.lossKind = kind;
      const who = payer?.toLowerCase() ?? l.payer;
      if (who) {
        l.payer = who;
        if (kind === 'settle_failed') this.lossPayers.add(who);
      }
    });
  }

  payerHasLoss(payer: string): boolean {
    return this.lossPayers.has(payer.toLowerCase());
  }

  /** One paid host status or output call for a free read. */
  read(leaseId: string): void {
    this.update(leaseId, (l) => void l.hostReads++);
  }

  /** Records a payment header's hash. True when it was already recorded: the payment is being reused. */
  seenPayment(hash: string): boolean {
    if (this.payments.has(hash)) return true;
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
    return false;
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
