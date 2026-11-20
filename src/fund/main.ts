#!/usr/bin/env node
// The grant fund process. `node dist/fund/main.js` runs the loop (one cycle every 60 s);
// `stop <grantId>`, `stop-all` and `status` are the operator's commands, run with `docker exec`.
// The commands never touch the key, the token or the network: stops go into stops.json, which the loop
// re-reads at the start of every cycle, and status reads the files the loop wrote.
import { GoogleGenAI } from '@google/genai';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { doorClient, usdcBalance, type DoorClient } from './door-client.js';
import { judge, JUDGE_API_VERSION, JUDGE_TIMEOUT_MS, uncountedJudgeError } from './judge.js';
import { cycle, GRANT_HOURS, makeJudgeOne, MAX_TICK_MICRO, type CycleDeps } from './paymaster.js';
import { emptyState, loadState, saveState, type FundState } from './state.js';

export const CYCLE_MS = 60_000;
export const PROBLEM_MS = 3_600_000;
const GRANT_ID = /^[0-9a-f]{32}$/;
const DEFAULT_DOOR = 'https://charter.mainnet.toonprotocol.dev';

const secrets = new Set<string>();
/** Strings (the RPC URL, the tokens, the keys) that must never reach health.json, logs or the door. */
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

export interface Stops { stopAll: boolean; stopped: string[] }

/** stops.json: what the operator stopped. Missing is nothing stopped; unreadable throws. */
export function readStops(dir: string): Stops {
  const file = join(dir, 'stops.json');
  if (!existsSync(file)) return { stopAll: false, stopped: [] };
  try {
    const s: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isObj(s) && typeof s.stopAll === 'boolean' && Array.isArray(s.stopped) && s.stopped.every((x) => typeof x === 'string' && GRANT_ID.test(x))) {
      return { stopAll: s.stopAll, stopped: [...new Set(s.stopped as string[])] };
    }
  } catch {
    // falls through to the error below
  }
  throw new Error(`${file} is not valid ({ stopAll: boolean, stopped: grant ids })`);
}

/** `stop <grantId>` or, with `all`, stop-all. Written atomically; the loop never writes this file. */
export function stopCommand(dir: string, what: string): void {
  if (what !== 'all' && !GRANT_ID.test(what)) throw new Error('a grant id is 32 hex characters (lowercase)');
  const s = readStops(dir);
  if (what === 'all') s.stopAll = true;
  else if (!s.stopped.includes(what)) s.stopped.push(what);
  writeAtomic(join(dir, 'stops.json'), JSON.stringify(s));
}

export interface Problem { key: string; msg: string; at: number }

/**
 * Merges this cycle's problems into health.json: a problem is replaced when its key reports again and is
 * dropped an hour after it was last reported. `at` is when this cycle ran.
 */
export function updateHealth(dir: string, fresh: { key: string; msg: string }[], now: number): void {
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
  writeAtomic(file, JSON.stringify({ at: now, problems: [...byKey.values()] }));
}

// ---- the numbers ----

/** floor(balance / (720 x tick x 1.1)) minus the grants still live, never below 0. */
export function grantsLeft(balance: bigint, tick: bigint, live: number): number {
  if (tick <= 0n || balance <= 0n) return 0;
  const n = (balance * 10n) / (BigInt(GRANT_HOURS) * tick * 11n) - BigInt(live);
  return n > 0n ? Number(n) : 0;
}

/** A grant is live until it ended early or completed (a completed one is only watched). */
function liveCount(s: FundState): number {
  return Object.values(s.grants).filter((g) => g.endedAt === undefined && g.watchUntil === undefined).length;
}

/** The offers' summed home slots and the highest tick price, or undefined when the door gave none. */
async function readOffers(door: DoorClient): Promise<{ slots: number; tick: bigint } | undefined> {
  const a = await door.get('/v1/offers');
  const list = Array.isArray(a.body) ? a.body : isObj(a.body) && Array.isArray(a.body.offers) ? a.body.offers : undefined;
  if (a.status !== 200 || !list) throw new Error(`GET /v1/offers answered ${a.status}`);
  let slots = 0;
  let tick = 0n;
  for (const o of list) {
    if (!isObj(o)) continue;
    if (isObj(o.home) && Number.isSafeInteger(o.home.slots) && (o.home.slots as number) > 0) slots += o.home.slots as number;
    if (typeof o.tickPrice === 'string' && /^\d{1,12}$/.test(o.tickPrice) && BigInt(o.tickPrice) > tick) tick = BigInt(o.tickPrice);
  }
  return tick > 0n ? { slots, tick } : undefined;
}

// ---- one iteration ----

export interface OnceDeps {
  dir: string;
  state: FundState;
  door: DoorClient;
  address: string;
  balance: () => Promise<bigint>;
  now: () => number;
  judgeOne: () => Promise<void>;
  runCycle?: (d: CycleDeps) => Promise<void>;
}

/**
 * Re-read stops.json into the state, run one cycle, report the pot to the door, write health.json.
 * Never throws: whatever fails is a problem in health.json.
 */
export async function runOnce(d: OnceDeps): Promise<void> {
  const t = d.now();
  const problems: { key: string; msg: string }[] = [];
  const problem = (key: string, msg: string) => void problems.push({ key, msg: redact(msg) });
  try {
    let stops: Stops | undefined;
    try {
      stops = readStops(d.dir);
    } catch (e) {
      // Without knowing what Drew stopped, nothing is paid this cycle.
      problem('stops', errText(e));
    }
    if (stops) {
      d.state.stopAll = stops.stopAll;
      d.state.stopped = stops.stopped;
      try {
        await (d.runCycle ?? cycle)({
          door: d.door, address: d.address, balance: d.balance, now: d.now, state: d.state,
          save: () => saveState(join(d.dir, 'state.json'), d.state), problem, judgeOne: d.judgeOne,
          lastBalanceMicro: () => lastBalance(d.dir),
        });
      } catch (e) {
        problem('cycle', errText(e));
      }
    }
    try {
      await report(d, stops?.stopAll ?? true);
    } catch (e) {
      problem('public', errText(e));
    }
  } catch (e) {
    problem('cycle', errText(e));
  }
  try {
    updateHealth(d.dir, problems, t);
  } catch (e) {
    console.error(`health.json not written: ${errText(e)}`);
  }
}

/** The balance in the last report this fund wrote (public.json), if it reads. */
function lastBalance(dir: string): string | undefined {
  const p = readJson(join(dir, 'public.json'));
  return isObj(p) && typeof p.balanceMicro === 'string' && /^\d+$/.test(p.balanceMicro) ? p.balanceMicro : undefined;
}

/**
 * Reports the pot to the door. Grants left is 0 whenever the fund is not open. A stopped fund reports
 * closed even when the balance read fails (with the last known balance, or 0), so intake always closes.
 */
async function report(d: OnceDeps, stopAll: boolean): Promise<void> {
  let balance: bigint | undefined;
  let balanceErr: Error | undefined;
  try {
    balance = await d.balance();
  } catch (e) {
    balanceErr = new Error(`balance: ${errText(e)}`);
  }
  if (balance === undefined && !stopAll) throw balanceErr;
  let offers: Awaited<ReturnType<typeof readOffers>>;
  let offersErr: unknown;
  if (balance !== undefined && !stopAll) {
    try {
      offers = await readOffers(d.door);
    } catch (e) {
      offersErr = e;
    }
  }
  const left = balance !== undefined && offers ? grantsLeft(balance, offers.tick, liveCount(d.state)) : 0;
  const open = !stopAll && left > 0;
  const balanceMicro = balance !== undefined ? balance.toString() : lastBalance(d.dir) ?? '0';
  const body = { address: d.address, balanceMicro, grantsLeft: open ? left : 0, open };
  writeAtomic(join(d.dir, 'public.json'), JSON.stringify(body));
  const r = await d.door.fund('PUT', '/v1/fund/public', body);
  if (r.status !== 200) throw new Error(`PUT /v1/fund/public answered ${r.status}`);
  if (balanceErr) throw balanceErr;
  if (offersErr) throw offersErr;
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

export type Args = { cmd: 'run' } | { cmd: 'stop'; id: string } | { cmd: 'stop-all' } | { cmd: 'status' };

export function parseArgs(argv: string[]): Args {
  const usage = new Error('usage: main.js [stop <grantId> | stop-all | status]');
  if (argv.length === 0) return { cmd: 'run' };
  if (argv[0] === 'stop' && argv.length === 2) return { cmd: 'stop', id: argv[1] };
  if (argv[0] === 'stop-all' && argv.length === 1) return { cmd: 'stop-all' };
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

/** What the operator sees: the last report to the door, every grant, the stops and the standing problems. */
export function statusReport(dir: string): Record<string, unknown> {
  const pub = readJson(join(dir, 'public.json'));
  const health = readJson(join(dir, 'health.json'));
  const state = loadState(join(dir, 'state.json'));
  const stops = readStops(dir);
  const p = isObj(pub) ? pub : {};
  return {
    address: p.address ?? null,
    balanceMicro: p.balanceMicro ?? null,
    grantsLeft: p.grantsLeft ?? null,
    open: p.open ?? null,
    stopAll: stops.stopAll,
    stopped: stops.stopped,
    healthAt: isObj(health) ? health.at ?? null : null,
    grants: Object.values(state.grants).map((g) => ({
      id: g.grantId,
      state: g.endedAt !== undefined ? 'ended' : g.watchUntil !== undefined ? 'completed' : g.leaseId ? 'active' : 'waiting',
      fundTicks: g.fundTicks,
      reopened: g.reopened,
      opening: g.opening ?? null,
      openUnknown: g.openUnknown ?? null,
      leaseId: g.leaseId ? `${g.leaseId.slice(0, 8)}` : null,
    })),
    problems: isObj(health) && Array.isArray(health.problems) ? health.problems : [],
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

export function parseFundKey(text: string): `0x${string}` {
  const k = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('CHARTER_FUND_KEY_FILE does not hold a key: 0x and 64 hex characters expected');
  return k as `0x${string}`;
}

async function run(env: NodeJS.ProcessEnv): Promise<void> {
  const dir = need(env, 'CHARTER_FUND_DATA_DIR');
  const key = parseFundKey(readSecret(env, 'CHARTER_FUND_KEY_FILE'));
  const fundToken = readSecret(env, 'CHARTER_FUND_TOKEN_FILE');
  const judgeKey = readSecret(env, 'CHARTER_JUDGE_KEY_FILE');
  const rpcUrl = readSecret(env, 'CHARTER_FUND_RPC_URL_FILE');
  const address = privateKeyToAccount(key).address;
  addSecrets(rpcUrl, fundToken, judgeKey, key, key.slice(2));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = existsSync(join(dir, 'state.json')) ? loadState(join(dir, 'state.json')) : emptyState();

  const door = await doorClient({ doorUrl: env.CHARTER_FUND_DOOR_URL?.trim() || DEFAULT_DOOR, key, fundToken, maxTickMicro: MAX_TICK_MICRO });
  // No SDK retries: a failed call is retried by the next cycle, so one call never outlasts its timeout.
  const gemini = new GoogleGenAI({ apiKey: judgeKey, apiVersion: JUDGE_API_VERSION, httpOptions: { timeout: JUDGE_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
  const judgeOne = makeJudgeOne({
    door,
    judge: (p, ctx) => judge(gemini, p, ctx),
    slots: async () => (await readOffers(door).catch(() => undefined))?.slots ?? 0,
    state,
    save: () => saveState(join(dir, 'state.json'), state),
    transient: uncountedJudgeError,
  });
  const signal = { stopped: false };
  let wake: (() => void) | undefined;
  const stop = () => {
    signal.stopped = true;
    wake?.();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`charter-fund up: address ${address}, data ${dir}`);
  await runLoop({
    signal,
    once: () => runOnce({ dir, state, door, address, balance: () => usdcBalance(address, rpcUrl), now: Date.now, judgeOne }),
    sleep: (ms) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    }),
  });
  console.log('charter-fund stopped');
}

async function main(): Promise<void> {
  const env = process.env;
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === 'run') return run(env);
  const dir = need(env, 'CHARTER_FUND_DATA_DIR');
  if (a.cmd === 'stop') stopCommand(dir, a.id);
  else if (a.cmd === 'stop-all') stopCommand(dir, 'all');
  else return void console.log(JSON.stringify(statusReport(dir), null, 2));
  console.log('stopped; the loop reads it at the start of its next cycle');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(errText(e));
    process.exit(1);
  });
}
