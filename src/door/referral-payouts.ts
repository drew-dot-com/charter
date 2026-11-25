// Referral payouts: an append-only log of every send, and the run that pays what referrers are owed.
// The rule it keeps: never pay the same money twice, and never resend when a send's outcome is unknown.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { BASE_USDC } from '../x402/seller.js';
import type { ReferralConfig } from './config.js';
import { utcDay } from './ledger.js';
import { errorReason } from './redact.js';
import type { ReferralStore } from './referrals.js';

/** The payout log's file, in the data dir beside the referral store. */
export const PAYOUTS_FILE = 'referral-payouts.jsonl';
/** The file the operator command appends to and the running door rereads. */
export const REFERRAL_OPS_FILE = 'referral-ops.jsonl';

/** `at` is when the intent was written. */
export interface Payout {
  id: string;
  to: string;
  amount: bigint;
  at: number;
  state: 'intent' | 'sent' | 'failed';
  tx?: string;
  reason?: string;
}

type Line =
  | { state: 'intent'; id: string; to: string; amount: string; at: number }
  | { state: 'sent'; id: string; tx: string; at: number }
  | { state: 'failed'; id: string; reason: string; at: number };

/** One JSON line per state change. A payout moves from 'intent' to 'sent' or 'failed' once and never back. */
export class PayoutLog {
  private readonly payouts = new Map<string, Payout>();

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const text of raw.split('\n')) {
      let l: unknown;
      try {
        l = JSON.parse(text);
      } catch {
        continue;
      }
      this.apply(l);
    }
    // A line cut short by a crash must not swallow the next one: end it before anything is appended.
    if (raw !== '' && !raw.endsWith('\n')) this.append('\n');
  }

  /** Appends an intent line and fsyncs it before returning. id: 16 random bytes, hex. */
  intent(to: string, amount: bigint, at: number): string {
    const id = randomBytes(16).toString('hex');
    this.write({ state: 'intent', id, to: to.toLowerCase(), amount: amount.toString(), at });
    return id;
  }

  sent(id: string, tx: string, at: number): void {
    this.mustBeOpen(id);
    this.write({ state: 'sent', id, tx, at });
  }

  failed(id: string, reason: string, at: number): void {
    this.mustBeOpen(id);
    this.write({ state: 'failed', id, reason, at });
  }

  get(id: string): Payout | undefined {
    const p = this.payouts.get(id);
    return p && { ...p };
  }

  /** Payouts in state 'intent', oldest first. */
  open(): Payout[] {
    return [...this.payouts.values()].filter((p) => p.state === 'intent').map((p) => ({ ...p }));
  }

  /** Newest first. */
  sentTo(address: string, limit: number): Payout[] {
    const a = address.toLowerCase();
    return [...this.payouts.values()]
      .filter((p) => p.state === 'sent' && p.to === a)
      .sort((x, y) => y.at - x.at)
      .slice(0, limit)
      .map((p) => ({ ...p }));
  }

  /** Sum of every intent written on that UTC day, whatever became of it. */
  intendedOn(day: string): bigint {
    let t = 0n;
    for (const p of this.payouts.values()) if (utcDay(p.at) === day) t += p.amount;
    return t;
  }

  private mustBeOpen(id: string): void {
    if (this.payouts.get(id)?.state !== 'intent') throw new Error(`payout ${id} is not open`);
  }

  /** Appends and fsyncs the line, then applies it in memory. */
  private write(l: Line): void {
    this.append(JSON.stringify(l) + '\n');
    this.apply(l);
  }

  private append(text: string): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const fd = openSync(this.file, 'a', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Applies a line read back or just written. A line that does not make sense is skipped. */
  private apply(l: unknown): void {
    if (typeof l !== 'object' || l === null) return;
    const o = l as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.at !== 'number') return;
    if (o.state === 'intent') {
      if (typeof o.to !== 'string' || typeof o.amount !== 'string' || !/^\d+$/.test(o.amount)) return;
      if (this.payouts.has(o.id)) return;
      this.payouts.set(o.id, { id: o.id, to: o.to.toLowerCase(), amount: BigInt(o.amount), at: o.at, state: 'intent' });
      return;
    }
    const p = this.payouts.get(o.id);
    if (p?.state !== 'intent') return;
    if (o.state === 'sent' && typeof o.tx === 'string') {
      p.state = 'sent';
      p.tx = o.tx;
    } else if (o.state === 'failed' && typeof o.reason === 'string') {
      p.state = 'failed';
      p.reason = o.reason;
    }
  }
}

export type SendResult =
  | { status: 'sent'; tx: `0x${string}` }
  | { status: 'reverted' }
  | { status: 'not_sent'; reason: string }
  | { status: 'unknown'; reason: string };
export type ReferralSend = (to: `0x${string}`, amount: bigint) => Promise<SendResult>;

export interface PayoutDeps {
  store: ReferralStore;
  log: PayoutLog;
  opsFile: string;
  cfg: Pick<ReferralConfig, 'minPayout' | 'dailyCap' | 'keep'>;
  balance: () => Promise<bigint>;
  send: ReferralSend;
  now: () => number;
  info: (s: string) => void;
  alert: (s: string) => Promise<void>;
}

const unresolved = (id: string) => `unresolved payout ${id}`;

/** Holds every address with an open intent (reason 'unresolved payout <id>') and alerts once per newly held address. */
export async function holdOpenIntents(d: Pick<PayoutDeps, 'store' | 'log' | 'alert'>): Promise<void> {
  const byAddress = new Map<string, Payout[]>();
  for (const p of d.log.open()) byAddress.set(p.to, [...(byAddress.get(p.to) ?? []), p]);
  for (const [address, open] of byAddress) {
    const held = d.store.get(address)?.held;
    if (open.some((p) => held === unresolved(p.id))) continue;
    d.store.hold(address, unresolved(open[0].id));
    await quietly(d.alert, `referral payout unresolved: ${open[0].id}, ${open[0].amount} micro-USDC to ${address}; address held`);
  }
}

/** Applies ops-file lines not yet applied (the count applied is kept in `<opsFile>.applied`). Returns how many it applied. */
export function applyReferralOps(d: Pick<PayoutDeps, 'store' | 'log' | 'opsFile' | 'now'>): number {
  let raw: string;
  try {
    raw = readFileSync(d.opsFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  // Only whole lines: the last one may still be being written.
  const done = raw.split('\n').slice(0, -1);
  const countFile = `${d.opsFile}.applied`;
  let applied = 0;
  try {
    applied = Number(readFileSync(countFile, 'utf8').trim()) || 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let n = 0;
  for (let i = applied; i < done.length; i++) {
    applyOp(d, done[i]);
    writeFileSync(`${countFile}.tmp`, String(i + 1), { mode: 0o600 });
    renameSync(`${countFile}.tmp`, countFile);
    n++;
  }
  return n;
}

function applyOp(d: Pick<PayoutDeps, 'store' | 'log' | 'now'>, text: string): void {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof o !== 'object' || o === null) return;
  const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
  if (o.op === 'release' && str(o.address)) d.store.release(o.address);
  else if (o.op === 'bind' && str(o.homeId) && str(o.address)) d.store.setHome(o.homeId, o.address);
  else if (o.op === 'unbind' && str(o.homeId)) d.store.setHome(o.homeId, undefined);
  else if (o.op === 'resolve' && str(o.id)) {
    const p = d.log.get(o.id);
    if (p?.state !== 'intent') return;
    if (o.as === 'sent' && typeof o.tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.tx)) {
      // Paid before the log closes the intent: a crash between the two leaves an open intent (held); markPaid counts an id once.
      d.store.markPaid(p.to, p.amount, p.id);
      d.log.sent(p.id, o.tx, d.now());
    } else if (o.as === 'failed') d.log.failed(p.id, 'operator', d.now());
  }
}

/**
 * Keeps the operator's ops out of a payout run: `tick` applies them only while no run is in flight. A run awaits
 * its sends (minutes, with the receipt wait), and an op applied mid-send could close an intent the send then
 * leaves unknown. `run` is what the sweep's `before` calls; it clears `busy` however the run ends.
 */
export function guardedPayouts(runOnce: () => Promise<void>, applyOps: () => void): { run: () => Promise<void>; tick: () => boolean; busy: () => boolean } {
  let inFlight = false;
  return {
    /** Returns at once, starting nothing, when a run is already in flight. */
    run: async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await runOnce();
      } finally {
        inFlight = false;
      }
    },
    /** True when the ops were applied, false when skipped because a run is in flight. */
    tick: () => {
      if (inFlight) return false;
      applyOps();
      return true;
    },
    busy: () => inFlight,
  };
}

/**
 * One payout run. Never throws. The balance is re-read before each send and the smaller of it and the run's own
 * running balance is used; the run ends at an unreadable balance or at the first unknown outcome.
 */
export async function payoutOnce(d: PayoutDeps): Promise<void> {
  try {
    applyReferralOps(d);
    await holdOpenIntents(d);
    let balance: bigint;
    try {
      balance = await d.balance();
    } catch {
      await quietly(d.alert, 'referral payout skipped: balance unreadable');
      return;
    }
    const due = d.store
      .all()
      .filter((r) => r.held === undefined && r.earned - r.paid > 0n && r.earned - r.paid >= d.cfg.minPayout)
      .sort((x, y) => (x.owedSince ?? Infinity) - (y.owedSince ?? Infinity));
    for (const r of due) {
      const to = r.address as `0x${string}`;
      const at = d.now();
      // Part of what is owed when the day's cap has less room: the rest stays owed and keeps its owedSince.
      const left = d.cfg.dailyCap - d.log.intendedOn(utcDay(at));
      const owed = r.earned - r.paid;
      const amount = owed < left ? owed : left;
      if (amount < d.cfg.minPayout || amount <= 0n) continue;
      // Re-read before each send: host channel deposits leave the same wallet while a run is in flight.
      let fresh: bigint;
      try {
        fresh = await d.balance();
      } catch {
        await quietly(d.alert, 'referral payout skipped: balance unreadable');
        return;
      }
      if (fresh < balance) balance = fresh;
      if (balance - amount < d.cfg.keep) {
        await quietly(d.alert, `referral payout skipped: wallet short for ${to}`);
        continue;
      }
      const id = d.log.intent(to, amount, at);
      let res: SendResult;
      try {
        res = await d.send(to, amount);
      } catch (e) {
        res = { status: 'unknown', reason: errorReason(e) };
      }
      if (res.status === 'sent') {
        // Paid before the log closes the intent: a crash between the two leaves an open intent (held), never a resend,
        // and the operator's later `resolve sent` does not count it again (markPaid counts an id once).
        d.store.markPaid(to, amount, id);
        d.log.sent(id, res.tx, d.now());
        balance -= amount;
        try {
          d.info(`referral payout: ${amount} micro-USDC to ${to}, tx ${res.tx}`);
        } catch {
          // a log line must not stop the run
        }
      } else if (res.status === 'reverted') {
        // Held before the log closes the intent: if the hold cannot be written, the open intent holds it next run.
        d.store.hold(to, 'transfer reverted');
        d.log.failed(id, 'reverted', d.now());
        await quietly(d.alert, `referral payout reverted: ${amount} micro-USDC to ${to}; address held`);
      } else if (res.status === 'not_sent') {
        d.log.failed(id, res.reason, d.now());
        await quietly(d.alert, `referral payout not sent: ${amount} micro-USDC to ${to}: ${res.reason}; retried next run`);
      } else {
        // The money may have moved. End the run: a stuck or unbroadcast transaction makes every later send from
        // the key fail the same way, each needing a manual resolve. Later addresses wait for the next run.
        d.store.hold(to, unresolved(id));
        await quietly(d.alert, `referral payout unresolved: ${id}, ${amount} micro-USDC to ${to}: ${res.reason}; address held`);
        return;
      }
    }
  } catch (e) {
    await quietly(d.alert, `referral payout run failed: ${errorReason(e)}`);
  }
}

async function quietly(alert: (s: string) => Promise<void>, m: string): Promise<void> {
  try {
    await alert(m);
  } catch {
    // an alert that cannot be raised must not stop the run
  }
}

/**
 * What a receipt says of the send of `hash`. viem resolves the receipt wait with the REPLACEMENT's receipt when
 * the transaction was replaced at the same nonce: that is unknown, never a payout of this intent.
 */
export function resultOfReceipt(hash: `0x${string}`, receipt: { transactionHash: `0x${string}`; status: 'success' | 'reverted' }): SendResult {
  if (receipt.transactionHash !== hash) return { status: 'unknown', reason: `${hash} replaced by ${receipt.transactionHash}` };
  return receipt.status === 'success' ? { status: 'sent', tx: hash } : { status: 'reverted' };
}

/** Waits, in `step` ms sleeps, while `busy()` is true, for at most `maxMs`. True when it cleared, false on timeout. */
export async function waitWhile(busy: () => boolean, maxMs: number, sleep: (ms: number) => Promise<void>, step = 250): Promise<boolean> {
  for (let waited = 0; busy(); waited += step) {
    if (waited >= maxMs) return false;
    await sleep(step);
  }
  return true;
}

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

/** One USDC transfer on Base from the door payer key, telling "reverted" apart from "could not find out". */
export function baseReferralSend(rpcUrl: string, key: `0x${string}`): ReferralSend {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: base, transport });
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ chain: base, transport, account });
  return async (to, amount) => {
    let request;
    try {
      ({ request } = await pub.simulateContract({ account, address: BASE_USDC, abi: ERC20, functionName: 'transfer', args: [to, amount] }));
    } catch (e) {
      const reverted = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
      return reverted ? { status: 'reverted' } : { status: 'not_sent', reason: errorReason(e) };
    }
    let hash: `0x${string}`;
    try {
      hash = await wallet.writeContract(request);
    } catch (e) {
      return { status: 'unknown', reason: errorReason(e) };
    }
    try {
      return resultOfReceipt(hash, await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }));
    } catch (e) {
      return { status: 'unknown', reason: `${hash}: ${errorReason(e)}` };
    }
  };
}
