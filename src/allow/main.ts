#!/usr/bin/env node
// The allowance biller process. `node dist/allow/main.js` runs the loop (one cycle every 60 s), holding
// loop.lock so a second loop on the same data dir refuses to run; `stop <allowanceId>`,
// `resolve-refund <allowanceId> sent|unsent|abandon` and `status` are the operator's commands, run with
// `docker exec` (docs/ops.md, Allowances). The commands never touch the key, the token, the lock or the
// network: they write stops.json and resolutions.json, which the loop re-reads at the start of every cycle,
// and status reads the files the loop wrote.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { doorClient, type DoorClient } from '../fund/door-client.js';
import { MAX_TICK_MICRO } from '../fund/paymaster.js';
import { cycle, type BillerDeps } from './biller.js';
import { baseChain, type Chain } from './chain.js';
import { LOCK_BEAT_MS, takeLock } from './lock.js';
import { emptyState, loadState, saveState, type AllowState } from './state.js';

export const CYCLE_MS = 60_000;
export const PROBLEM_MS = 3_600_000;
/** The biller's ETH below this (0.0001) is a problem: it pays gas for every pull, revoke and refund. */
export const LOW_ETH_WEI = 100_000_000_000_000n;
const ALLOWANCE_ID = /^[0-9a-f]{32}$/;
const DEFAULT_DOOR = 'https://charterhome.dev';

const secrets = new Set<string>();
/** Strings (the RPC URL, the token, the key) that must never reach health.json, logs or the door. */
export function addSecrets(...s: string[]): void {
  for (const x of s) if (x.length >= 8) secrets.add(x);
}
export function redact(text: string, list: Iterable<string> = secrets): string {
  let out = text;
  for (const s of list) if (s) out = out.split(s).join('[redacted]');
  return out;
}
const errText = (e: unknown) => redact(e instanceof Error ? e.message : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// ---- files in the data dir ----

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** stops.json: the allowance ids Drew stopped. Missing is nothing stopped; unreadable throws. */
export function readStops(dir: string): string[] {
  const file = join(dir, 'stops.json');
  if (!existsSync(file)) return [];
  try {
    const s: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(s) && Array.isArray(s.stopped) && s.stopped.every((x) => typeof x === 'string' && ALLOWANCE_ID.test(x))) return [...new Set(s.stopped as string[])];
  } catch {
    // falls through to the error below
  }
  throw new Error(`${file} is not valid ({ stopped: allowance ids })`);
}

/** `stop <allowanceId>`. Written atomically; the loop never writes this file. */
export function stopCommand(dir: string, id: string): void {
  if (!ALLOWANCE_ID.test(id)) throw new Error('an allowance id is 32 hex characters (lowercase)');
  const s = readStops(dir);
  if (!s.includes(id)) s.push(id);
  writeAtomic(join(dir, 'stops.json'), JSON.stringify({ stopped: s }));
}

/**
 * `sent`: the refund landed. `unsent`: it did not; refund again. `abandon`: it can never land (a blacklisted
 * account, the biller short of USDC): end the allowance as `operator` with no refund, for Drew to settle by hand.
 */
export type Outcome = 'sent' | 'unsent' | 'abandon';
const OUTCOMES: readonly string[] = ['sent', 'unsent', 'abandon'];

/** resolutions.json: what Drew found on chain for a refund that got no answer. Missing is none; unreadable throws. */
export function readResolutions(dir: string): Record<string, Outcome> {
  const file = join(dir, 'resolutions.json');
  if (!existsSync(file)) return {};
  try {
    const s: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(s) && Object.entries(s).every(([k, v]) => ALLOWANCE_ID.test(k) && typeof v === 'string' && OUTCOMES.includes(v))) return s as Record<string, Outcome>;
  } catch {
    // falls through to the error below
  }
  throw new Error(`${file} is not valid ({ allowanceId: "sent" | "unsent" | "abandon" })`);
}

/** `resolve-refund <allowanceId> sent|unsent|abandon`: the loop applies it once and removes it. */
export function resolveRefundCommand(dir: string, id: string, outcome: Outcome): void {
  if (!ALLOWANCE_ID.test(id)) throw new Error('an allowance id is 32 hex characters (lowercase)');
  if (!OUTCOMES.includes(outcome)) throw new Error('the outcome is sent, unsent or abandon');
  const r = readResolutions(dir);
  r[id] = outcome;
  writeAtomic(join(dir, 'resolutions.json'), JSON.stringify(r));
}

/**
 * Applies the operator's refund findings to the state, saves it, then removes what it applied from the file
 * (re-read, so a command written meanwhile survives). `sent`: the refund landed, so the credit is 0 and the
 * end can complete. `unsent`: it did not, so the next cycle refunds again. `abandon` (an allowance whose end
 * is decided, refund in flight or not): the credit is written off to `abandonedMicro` and the end becomes
 * `ended` / `operator`, which the next cycle posts with no refund. Saved before removed: a crash between the
 * two applies them again, and a second pass changes nothing.
 */
function applyResolutions(dir: string, state: AllowState, problem: (key: string, msg: string) => void, log: (msg: string) => void): void {
  const res = readResolutions(dir);
  const ids = Object.keys(res);
  if (ids.length === 0) return;
  for (const id of ids) {
    const e = state.entries[id];
    if (res[id] === 'abandon') {
      if (!e || !e.ending) {
        problem('resolve', `resolve-refund abandon for ${id.slice(0, 8)} ignored: that allowance has no end decided (use stop <allowanceId> first)`);
        continue;
      }
      if (e.ending.state === 'ended' && e.ending.endReason === 'operator' && e.creditMicro === '0' && !e.refundInFlight) continue; // applied already
      const credit = BigInt(e.creditMicro);
      e.abandonedMicro = (BigInt(e.abandonedMicro ?? '0') + credit).toString();
      e.creditMicro = '0';
      delete e.refundInFlight;
      e.ending = { state: 'ended', endReason: 'operator' };
      log(`operator: resolve-refund abandon for allowance ${id}: ${credit} micro-USDC not refunded (abandonedMicro ${e.abandonedMicro}), the allowance ends as operator; settle it by hand`);
      continue;
    }
    if (!e || !e.refundInFlight) {
      problem('resolve', `resolve-refund ${res[id]} for ${id.slice(0, 8)} ignored: that allowance has no refund in flight`);
      continue;
    }
    delete e.refundInFlight;
    if (res[id] === 'sent') e.creditMicro = '0';
  }
  saveState(join(dir, 'state.json'), state);
  const left = readResolutions(dir);
  for (const id of ids) if (left[id] === res[id]) delete left[id];
  writeAtomic(join(dir, 'resolutions.json'), JSON.stringify(left));
}

export interface Problem { key: string; msg: string; at: number }
/**
 * Merges this cycle's problems into health.json: a problem is replaced when its key reports again and is
 * dropped an hour after it was last reported. `at` is when this cycle ran.
 */
export function updateHealth(dir: string, fresh: { key: string; msg: string }[], now: number, balances: { ethWei?: bigint; usdcMicro?: bigint }): void {
  const file = join(dir, 'health.json');
  const byKey = new Map<string, Problem>();
  try {
    const old: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(old) && Array.isArray(old.problems)) {
      for (const p of old.problems) {
        if (isObj(p) && typeof p.key === 'string' && typeof p.msg === 'string' && typeof p.at === 'number' && now - p.at <= PROBLEM_MS) byKey.set(p.key, { key: p.key, msg: p.msg, at: p.at });
      }
    }
  } catch {
    // no health yet, or one that does not read: start from this cycle's
  }
  for (const p of fresh) byKey.set(p.key, { key: p.key, msg: p.msg, at: now });
  writeAtomic(file, JSON.stringify({
    at: now,
    problems: [...byKey.values()],
    ethWei: balances.ethWei?.toString() ?? null,
    usdcMicro: balances.usdcMicro?.toString() ?? null,
  }));
}

/** The state file, or a fresh state when there is none. A file that does not read back throws (never starts fresh). */
export function bootState(dir: string): AllowState {
  const file = join(dir, 'state.json');
  return existsSync(file) ? loadState(file) : emptyState();
}

// ---- one iteration ----

export interface OnceDeps {
  dir: string;
  state: AllowState;
  door: DoorClient;
  chain: Pick<Chain, 'usdc' | 'eth'> & Partial<Chain>;
  address: string;
  now: () => number;
  runCycle?: (d: BillerDeps) => Promise<void>;
  /** Operator actions that are not problems (an abandoned refund). Default: console.log. */
  log?: (msg: string) => void;
}

/**
 * Apply the operator's files, run one cycle, read the biller's balances, write health.json.
 * Never throws: whatever fails is a problem in health.json.
 */
export async function runOnce(d: OnceDeps): Promise<void> {
  const t = d.now();
  const problems: { key: string; msg: string }[] = [];
  const problem = (key: string, msg: string) => void problems.push({ key, msg: redact(msg) });
  const balances: { ethWei?: bigint; usdcMicro?: bigint } = {};
  try {
    let stops: Set<string> | undefined;
    try {
      stops = new Set(readStops(d.dir));
      applyResolutions(d.dir, d.state, problem, d.log ?? ((m) => console.log(redact(m))));
    } catch (e) {
      // Without knowing what Drew stopped or resolved, nothing is paid this cycle.
      stops = undefined;
      problem('stops', errText(e));
    }
    if (stops) {
      try {
        await (d.runCycle ?? cycle)({ door: d.door, chain: d.chain as Chain, state: d.state, save: () => saveState(join(d.dir, 'state.json'), d.state), now: d.now, problem, stops });
      } catch (e) {
        problem('cycle', errText(e));
      }
    }
    try {
      balances.ethWei = await d.chain.eth(d.address);
      if (balances.ethWei < LOW_ETH_WEI) problem('low_eth', `the biller holds ${balances.ethWei} wei of ETH, under ${LOW_ETH_WEI}; it pays gas for every pull, revoke and refund. Send ETH on Base to ${d.address}.`);
    } catch (e) {
      problem('balance', `eth: ${errText(e)}`);
    }
    try {
      balances.usdcMicro = await d.chain.usdc(d.address);
    } catch (e) {
      problem('balance', `usdc: ${errText(e)}`);
    }
  } catch (e) {
    problem('cycle', errText(e));
  }
  try {
    updateHealth(d.dir, problems, t, balances);
  } catch (e) {
    console.error(`health.json not written: ${errText(e)}`);
  }
}

export async function runLoop(o: {
  once: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  signal: { stopped: boolean };
}): Promise<void> {
  while (!o.signal.stopped) {
    try {
      await o.once();
    } catch (e) {
      console.error(`cycle failed: ${errText(e)}`);
    }
    if (o.signal.stopped) break;
    await o.sleep(CYCLE_MS);
  }
}

// ---- the commands ----

export type Args =
  | { cmd: 'run' }
  | { cmd: 'stop'; id: string }
  | { cmd: 'resolve-refund'; id: string; outcome: Outcome }
  | { cmd: 'status' };

export function parseArgs(argv: string[]): Args {
  const usage = new Error('usage: main.js [stop <allowanceId> | resolve-refund <allowanceId> sent|unsent|abandon | status]');
  if (argv.length === 0) return { cmd: 'run' };
  if (argv[0] === 'stop' && argv.length === 2) return { cmd: 'stop', id: argv[1] };
  if (argv[0] === 'resolve-refund' && argv.length === 3) return { cmd: 'resolve-refund', id: argv[1], outcome: argv[2] as Outcome };
  if (argv[0] === 'status' && argv.length === 1) return { cmd: 'status' };
  throw usage;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** What the operator sees: every allowance the biller holds money for, the stops, resolutions and standing problems. */
export function statusReport(dir: string): Record<string, unknown> {
  const health = readJson(join(dir, 'health.json'));
  const state = loadState(join(dir, 'state.json'));
  const h = isObj(health) ? health : {};
  return {
    healthAt: h.at ?? null,
    ethWei: h.ethWei ?? null,
    usdcMicro: h.usdcMicro ?? null,
    stopped: readStops(dir),
    resolutions: readResolutions(dir),
    entries: Object.values(state.entries),
    problems: Array.isArray(h.problems) ? h.problems : [],
  };
}

// ---- boot ----

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = need(env, name);
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`${name} names ${file}, which cannot be read`);
  }
  if (!text) throw new Error(`${name} names ${file}, which is empty`);
  return text;
}
export function parseAllowKey(text: string): `0x${string}` {
  const k = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('CHARTER_ALLOW_KEY_FILE does not hold a key: 0x and 64 hex characters expected');
  return k as `0x${string}`;
}

async function run(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = need(env, 'CHARTER_ALLOW_DATA_DIR');
  const key = parseAllowKey(readSecret(env, 'CHARTER_ALLOW_KEY_FILE'));
  const allowToken = readSecret(env, 'CHARTER_ALLOW_TOKEN_FILE');
  const rpcUrl = readSecret(env, 'CHARTER_ALLOW_RPC_URL_FILE');
  const address = privateKeyToAccount(key).address;
  addSecrets(rpcUrl, allowToken, key, key.slice(2));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One loop per data dir: a second one (a `docker compose run`, a stray `node dist/allow/main.js`) stops here.
  const lock = takeLock(dir, undefined, (m) => console.log(m));
  process.on('exit', () => lock.release());
  const beat = setInterval(() => {
    try {
      lock.beat();
    } catch (e) {
      console.error(`loop lock not refreshed: ${errText(e)}`);
    }
  }, LOCK_BEAT_MS);
  beat.unref();
  // A state file that does not read back stops the process here: starting fresh could pull or refund twice.
  const state = bootState(dir);
  const door = await doorClient({ doorUrl: env.CHARTER_ALLOW_DOOR_URL?.trim() || DEFAULT_DOOR, key, fundToken: allowToken, maxTickMicro: MAX_TICK_MICRO });
  const chain = baseChain({ key, rpcUrl });
  const signal = { stopped: false };
  let wake: (() => void) | undefined;
  const stop = () => {
    signal.stopped = true;
    wake?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`charter-allow up: address ${address}, data ${dir}`);
  await runLoop({
    signal,
    once: async () => {
      // A lock taken over by another loop (only after this one stopped beating): this one stops at once.
      if (!lock.mine()) {
        console.error(`the loop lock in ${dir} is no longer this process's; stopping so two loops never run`);
        signal.stopped = true;
        return;
      }
      await runOnce({ dir, state, door, chain, address, now: Date.now });
    },
    sleep: (ms) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    }),
  });
  clearInterval(beat);
  lock.release();
  console.log('charter-allow stopped');
}

async function main(): Promise<void> {
  const env = process.env;
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === 'run') return run(env);
  const dir = need(env, 'CHARTER_ALLOW_DATA_DIR');
  if (a.cmd === 'stop') stopCommand(dir, a.id);
  else if (a.cmd === 'resolve-refund') resolveRefundCommand(dir, a.id, a.outcome);
  else return void console.log(JSON.stringify(statusReport(dir), null, 2));
  console.log('written; the loop reads it at the start of its next cycle');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(errText(e));
    process.exit(1);
  });
}
