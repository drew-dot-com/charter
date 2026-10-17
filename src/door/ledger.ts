import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /** The door will not pay another tick for this lease. */
  stopped: boolean;
  /** Epoch ms. */
  createdAt: number;
}

interface Stored extends Omit<DoorLease, 'losses'> {
  losses: string;
}

/** The door's books: a JSON file, rewritten whole through a temp file and a rename. */
export class DoorLedger {
  private readonly leases = new Map<string, DoorLease>();

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const s of JSON.parse(raw) as Stored[]) this.leases.set(s.leaseId, { ...s, losses: BigInt(s.losses) });
  }

  get(leaseId: string): DoorLease | undefined {
    const l = this.leases.get(leaseId);
    return l && { ...l };
  }

  all(): DoorLease[] {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }

  open(o: { leaseId: string; offerId: string; createdAt: number }): void {
    this.leases.set(o.leaseId, { ...o, ticksPaidByRenter: 0, ticksPaidToHost: 0, losses: 0n, stopped: false });
    this.save();
  }

  /** The host answered a tick 2xx. */
  hostTick(leaseId: string): void {
    this.update(leaseId, (l) => void l.ticksPaidToHost++);
  }

  /** The renter's payment for a tick settled. */
  renterTick(leaseId: string, payer?: string): void {
    this.update(leaseId, (l) => {
      l.ticksPaidByRenter++;
      if (payer) l.payer = payer;
    });
  }

  loss(leaseId: string, amount: Micro): void {
    this.update(leaseId, (l) => void (l.losses += amount));
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
