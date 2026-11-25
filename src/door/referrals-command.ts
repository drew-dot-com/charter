import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAYOUTS_FILE, PayoutLog, REFERRAL_OPS_FILE } from './referral-payouts.js';
import { REFERRALS_FILE, ReferralStore } from './referrals.js';

const USAGE = [
  'usage: charter-door referrals [list]',
  '       charter-door referrals resolve <payoutId> sent <0x tx hash (64 hex)>',
  '       charter-door referrals resolve <payoutId> failed',
  '       charter-door referrals release <0x address>',
  '       charter-door referrals bind <homeId (64 hex)> <0x address>',
  '       charter-door referrals unbind <homeId (64 hex)>',
].join('\n');

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HOME_ID = /^[0-9a-f]{64}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

type Op =
  | { op: 'resolve'; id: string; as: 'sent'; tx: string }
  | { op: 'resolve'; id: string; as: 'failed' }
  | { op: 'release'; address: string }
  | { op: 'bind'; homeId: string; address: string }
  | { op: 'unbind'; homeId: string };

/** The writing form `args` names, or undefined when they are not one. */
function parseOp(args: string[]): Op | undefined {
  const [verb, a, b, c] = args.map((s) => s.trim());
  if (verb === 'resolve' && a) {
    if (args.length === 4 && b === 'sent' && c && TX.test(c)) return { op: 'resolve', id: a, as: 'sent', tx: c };
    if (args.length === 3 && b === 'failed') return { op: 'resolve', id: a, as: 'failed' };
    return undefined;
  }
  const address = (verb === 'release' ? a : b)?.toLowerCase();
  const homeId = a?.toLowerCase();
  if (verb === 'release' && args.length === 2 && address && ADDRESS.test(address)) return { op: 'release', address };
  if (verb === 'bind' && args.length === 3 && homeId && HOME_ID.test(homeId) && address && ADDRESS.test(address)) return { op: 'bind', homeId, address };
  if (verb === 'unbind' && args.length === 2 && homeId && HOME_ID.test(homeId)) return { op: 'unbind', homeId };
  return undefined;
}

/**
 * The payout log, read without writing to it: PayoutLog ends a torn last line on open, and the running door may
 * be writing that line now. Only whole lines are read, from a private copy when the last one is not whole.
 */
function readPayoutLog(file: string): PayoutLog {
  if (!existsSync(file)) return new PayoutLog(file);
  const raw = readFileSync(file, 'utf8');
  if (raw === '' || raw.endsWith('\n')) return new PayoutLog(file);
  const dir = mkdtempSync(join(tmpdir(), 'charter-referrals-'));
  try {
    const copy = join(dir, PAYOUTS_FILE);
    writeFileSync(copy, raw.slice(0, raw.lastIndexOf('\n') + 1), { mode: 0o600 });
    return new PayoutLog(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `charter-door referrals ...`: lists what referrers earned, were paid and are owed, and the open payouts; the
 * writing forms append one line to the ops file, which the running door applies within a minute. It never writes
 * the store or the payout log: the running door owns both. Exit codes: 0 ok, 1 nothing there, 2 usage.
 */
export function referralsCommand(args: string[], env: NodeJS.ProcessEnv, now: () => number, out: (m: string) => void): number {
  const list = args.length === 0 || (args.length === 1 && args[0] === 'list');
  const op = list ? undefined : parseOp(args);
  if (!list && !op) {
    out(USAGE);
    return 2;
  }
  const dataDir = env.CHARTER_DATA_DIR?.trim();
  if (!dataDir) {
    out('CHARTER_DATA_DIR is required');
    return 2;
  }
  const storeFile = join(dataDir, REFERRALS_FILE);
  const logFile = join(dataDir, PAYOUTS_FILE);

  if (list) {
    if (!existsSync(storeFile) && !existsSync(logFile)) {
      out(`no referrals in ${dataDir}: nothing to list (is CHARTER_DATA_DIR the door's data dir?)`);
      return 1;
    }
    const store = new ReferralStore(storeFile);
    for (const r of store.all().sort((x, y) => x.address.localeCompare(y.address))) {
      out(`${r.address} earned ${r.earned} paid ${r.paid} owed ${r.earned - r.paid}${r.held === undefined ? '' : ` held: ${r.held}`}`);
    }
    for (const p of readPayoutLog(logFile).open()) {
      out(`open ${p.id} ${p.amount} micro-USDC to ${p.to}, written ${new Date(p.at).toISOString()}`);
    }
    return 0;
  }

  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
    out(`no data dir at ${dataDir} (is CHARTER_DATA_DIR the door's data dir?)`);
    return 1;
  }
  let will: string;
  if (op!.op === 'resolve') {
    const p = readPayoutLog(logFile).get(op!.id);
    if (p?.state !== 'intent') {
      out(`${op!.id} is not an open payout in ${logFile}`);
      return 1;
    }
    will = op!.as === 'sent'
      ? `count payout ${p.id} (${p.amount} micro-USDC to ${p.to}) as paid in ${op!.tx}`
      : `close payout ${p.id} (${p.amount} micro-USDC to ${p.to}) as failed; it stays owed`;
  } else if (op!.op === 'release') {
    if (!existsSync(storeFile) || !new ReferralStore(storeFile).get(op!.address)) {
      out(`no referrer ${op!.address} in ${storeFile}`);
      return 1;
    }
    will = `release the hold on ${op!.address}`;
  } else if (op!.op === 'bind') {
    will = `bind home ${op!.homeId} to ${op!.address}, replacing any referrer it had`;
  } else {
    will = `unbind home ${op!.homeId}`;
  }
  appendFileSync(join(dataDir, REFERRAL_OPS_FILE), JSON.stringify({ ...op, at: now() }) + '\n', { mode: 0o600 });
  out(`written: the running door will ${will} within a minute`);
  return 0;
}
