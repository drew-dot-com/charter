import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_FILE, TICK_TXS_FILE } from '../door/ledger.js';
import { OPTIN_CODES_FILE, type OptinKind } from '../door/optin-codes.js';
import type { DoorLease } from '../door/ledger.js';
import type { Grant } from '../door/grants.js';
import { HOSTS_FILE } from '../door/hosts.js';
import type { HostRecord } from '../door/hosts.js';

// The door has no exported constant for this name; it is set in src/door/main.ts.
const GRANTS_FILE = 'grants.jsonl';
// Likewise set in src/door/main.ts.
const ALLOWANCES_FILE = 'allowances.jsonl';

export interface TickTx { leaseId: string; tick: number; tx: string; at: number }

/** The hash of an opt-in code the door served, and the lease or grant it belongs to. Never the code. */
export interface OptinCodeRow { kind: OptinKind; id: string; hash: string }

export interface Sources { leases: DoorLease[]; grants: Grant[]; hosts: HostRecord[]; tickTxs: TickTx[]; optinCodes: OptinCodeRow[] }

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

interface AllowanceLite { homeId: string; account: string; createdAt: number }

/**
 * The door's biller pays every hour of an allowance home, so the ledger's `payer` is the same wallet for every
 * such lease. This puts the account that approved the allowance there instead: the newest allowance for the
 * lease's home made before the lease was last paid. A biller lease with no such account loses its payer, so it is
 * never taken for an outside wallet.
 */
function payerBehindBiller(leases: DoorLease[], allowancesText: string | undefined, biller: string): DoorLease[] {
  const byId = new Map<string, AllowanceLite>();
  for (const a of jsonl(allowancesText)) {
    if (!isObj(a) || typeof a.allowanceId !== 'string' || typeof a.homeId !== 'string' || typeof a.createdAt !== 'number') continue;
    // The file is a log: the last line of an allowance is its state now.
    if (typeof a.account === 'string' && a.account) byId.set(a.allowanceId, { homeId: a.homeId, account: a.account.toLowerCase(), createdAt: a.createdAt });
    else byId.delete(a.allowanceId);
  }
  const allowances = [...byId.values()].sort((x, y) => y.createdAt - x.createdAt);
  return leases.map((l) => {
    if (l.payer?.toLowerCase() !== biller) return l;
    const at = l.lastTickAt ?? l.createdAt;
    const hit = l.homeId ? allowances.find((a) => a.homeId === l.homeId && a.createdAt <= at) : undefined;
    const { payer: _biller, ...rest } = l;
    return hit ? { ...rest, payer: hit.account } : rest;
  });
}

/**
 * Reads the door's data files, read-only. A missing ledger, or one that does not parse (a write caught
 * mid-flight), is an `{ error }`: the caller skips this tick. The other files may be absent. With `allowAddress`
 * (the door's allowance biller) a lease that wallet paid carries the payer behind its allowance.
 */
export function readSources(dataDir: string, opts: { allowAddress?: string } = {}): Sources | { error: string } {
  try {
    const ledger = read(dataDir, LEDGER_FILE);
    if (ledger === undefined) return { error: `${LEDGER_FILE} is missing` };
    const rows = JSON.parse(ledger) as unknown;
    if (!Array.isArray(rows)) return { error: `${LEDGER_FILE} is not a list` };
    // `losses` is stored as a string; this service never reads it, so it stays as stored.
    let leases = rows.filter((r) => isObj(r) && typeof r.leaseId === 'string') as unknown as DoorLease[];
    const biller = opts.allowAddress?.toLowerCase();
    if (biller) leases = payerBehindBiller(leases, read(dataDir, ALLOWANCES_FILE), biller);

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
    const optinCodes = jsonl(read(dataDir, OPTIN_CODES_FILE)).filter(
      (c): c is OptinCodeRow => isObj(c) && (c.kind === 'lease' || c.kind === 'grant') && typeof c.id === 'string' && typeof c.hash === 'string',
    );
    return { leases, grants: [...grantMap.values()], hosts, tickTxs, optinCodes };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
