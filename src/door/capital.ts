// What the door has put into each host's channels and not taken back: the capital allocator's `locked`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The capital file's name inside the door data dir. */
export const CAPITAL_FILE = 'capital.json';

/**
 * Per host: the sum of the deposits the door signed (doorPayer's `onDeposit`) minus what it withdrew, in
 * micro-USDC. A JSON file of decimal strings, rewritten whole through a temp file and a rename, so a restart
 * keeps it.
 */
export class CapitalBook {
  private readonly hosts = new Map<string, bigint>();

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const [hostId, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) this.hosts.set(hostId, BigInt(v));
  }

  locked(hostId: string): bigint {
    return this.hosts.get(hostId) ?? 0n;
  }

  /** A deposit the door signed into this host's channel. */
  deposited(hostId: string, amount: bigint): void {
    this.hosts.set(hostId, this.locked(hostId) + amount);
    this.save();
  }

  /** Funds that came back from this host's channel. */
  withdrawn(hostId: string, amount: bigint): void {
    const left = this.locked(hostId) - amount;
    this.hosts.set(hostId, left > 0n ? left : 0n);
    this.save();
  }

  private save(): void {
    const rows = Object.fromEntries([...this.hosts].map(([k, v]) => [k, v.toString()]));
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
