import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_FILE, TICK_TXS_FILE } from '../door/ledger.js';
import type { DoorLease } from '../door/ledger.js';
import type { Grant } from '../door/grants.js';
import { HOSTS_FILE } from '../door/hosts.js';
import type { HostRecord } from '../door/hosts.js';

// The door has no exported constant for this name; it is set in src/door/main.ts.
const GRANTS_FILE = 'grants.jsonl';

export interface TickTx { leaseId: string; tick: number; tx: string; at: number }

export interface Sources { leases: DoorLease[]; grants: Grant[]; hosts: HostRecord[]; tickTxs: TickTx[] }

/** The file's text, or undefined when it does not exist. Any other read error propagates. */
function read(dir: string, name: string): string | undefined {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function jsonl(text: string | undefined): unknown[] {
  const out: unknown[] = [];
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn or malformed line: skip it
    }
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Reads the door's data files, read-only. A missing ledger, or one that does not parse (a write caught
 * mid-flight), is an `{ error }`: the caller skips this tick. The other files may be absent.
 */
export function readSources(dataDir: string): Sources | { error: string } {
  try {
    const ledger = read(dataDir, LEDGER_FILE);
    if (ledger === undefined) return { error: `${LEDGER_FILE} is missing` };
    const rows = JSON.parse(ledger) as unknown;
    if (!Array.isArray(rows)) return { error: `${LEDGER_FILE} is not a list` };
    // `losses` is stored as a string; this service never reads it, so it stays as stored.
    const leases = rows.filter((r) => isObj(r) && typeof r.leaseId === 'string') as unknown as DoorLease[];

    const grantMap = new Map<string, Grant>();
    for (const g of jsonl(read(dataDir, GRANTS_FILE))) {
      if (isObj(g) && typeof g.grantId === 'string') grantMap.set(g.grantId, g as unknown as Grant);
    }

    const tickTxs = jsonl(read(dataDir, TICK_TXS_FILE)).filter(
      (t): t is TickTx => isObj(t) && typeof t.leaseId === 'string' && typeof t.tick === 'number' && typeof t.tx === 'string' && typeof t.at === 'number',
    );

    let hosts: HostRecord[] = [];
    const hostsText = read(dataDir, HOSTS_FILE);
    if (hostsText !== undefined) {
      const parsed = JSON.parse(hostsText) as { hosts?: unknown };
      if (Array.isArray(parsed.hosts)) hosts = parsed.hosts.filter((h) => isObj(h) && typeof h.hostId === 'string') as unknown as HostRecord[];
    }
    return { leases, grants: [...grantMap.values()], hosts, tickTxs };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
