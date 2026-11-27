import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isLive, leaseTickPrice } from '../lease.js';
import type { Lease, Micro } from '../types.js';

/**
 * Leases keyed by id. With a file path every read goes back to disk, so the
 * `charter-host land` process and the running host see each other's writes; a
 * write replaces the file whole (temp file, then rename) so a reader never
 * sees half a file. With no path the store is memory only (tests).
 */
export class LeaseStore {
  private mem = new Map<string, Lease>();

  constructor(private readonly file?: string) {}

  private load(): Map<string, Lease> {
    if (!this.file) return this.mem;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw e;
    }
    const list = JSON.parse(raw) as Lease[];
    return new Map(list.map((l) => [l.id, l]));
  }

  get(id: string): Lease | undefined {
    return this.load().get(id);
  }

  all(): Lease[] {
    return [...this.load().values()];
  }

  put(l: Lease): void {
    const map = this.load();
    map.set(l.id, l);
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...map.values()]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * Fixes the price of every live lease that has none (opened before prices were fixed per lease) at `current`,
 * the price this host runs at now. Run at start, before the first tick is gated, so a host that raises its
 * price after this build keeps those leases at the old one. Deploy this build before raising a price.
 */
export function fixTickPrices(store: LeaseStore, current: Micro): void {
  for (const l of store.all()) if (isLive(l) && l.tickPrice === undefined) store.put({ ...l, tickPrice: current.toString() });
}

/** What a tick on lease `id` costs: its fixed price (`leaseTickPrice`), or `current()` for a lease the store does not hold. */
export function leasePrices(store: LeaseStore, current: () => Micro): (id: string) => Micro {
  return (id) => {
    const l = store.get(id);
    return l ? leaseTickPrice(l, current()) : current();
  };
}
