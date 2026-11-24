#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { doorClient, type DoorClient } from './fund/door-client.js';
import { MAX_SCRIPT_BYTES, fetchJob, homeJob, HOME_IMAGES, isHomeImage, isScript, normalizeSshKeys, pythonJob } from './jobs.js';
import type { HomeAccess, JobSpec, Lease, Micro } from './types.js';
import { DoorOfferMovedError, doorHostApi, leaseOfferOf, type DoorOffer } from './tenant/door-host-api.js';
import { FromMismatchError, continueLease, runLease, type LeaseEvent, type RunLeaseOpts, type RunLeaseResult } from './tenant/run-lease.js';

/** The door the CLI talks to unless --door or CHARTER_DOOR_URL names another. */
export const DEFAULT_DOOR = 'https://charterhome.dev';
/** The most one tick may cost unless CHARTER_MAX_TICK says otherwise: 0.01 USDC. */
const DEFAULT_MAX_TICK: Micro = 10_000n;

const USAGE = `usage:
  charter offers [--door <url>]
  charter rent [--offer <hostId>:<id>] (--urls <a,b> | --python <file.py> | --home <keys file> [--image <home image>]) --max-intervals <n> [--door <url>] [--json]
  charter renew --lease <id> [--from <index>] --max-intervals <n> [--door <url>] [--json]
  charter status <leaseId> [--door <url>] [--json]
  charter address
the door is --door, else CHARTER_DOOR_URL, else ${DEFAULT_DOOR}
rent and renew pay the door over x402 (exact USDC on Base) from the hex key in the file CHARTER_KEY_FILE, at most
  CHARTER_MAX_TICK micro-USDC a tick (default ${DEFAULT_MAX_TICK} = 0.01 USDC); address prints that key's address
rent without --offer takes the first offer in the door's ranking that runs the job; a home always opens on the host that holds it
--home takes one SSH public key per line, --image picks the home image (charter-home by default, or charter-hermes)
renew pays an open lease from the host's paid count on (--from, when given, must equal that count, or nothing is paid)`;

/** What the TOON payer took, refused by name so an old script stops at once instead of paying another way. */
const GONE_ENV = ['CHARTER_PAYER', 'CHARTER_OFFER_JSON'];

export interface CliDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Builds the door client (no key: it only reads). A seam for tests. */
  client: (o: { doorUrl: string; key?: `0x${string}`; maxTickMicro: Micro }) => Promise<DoorClient>;
}

const defaultDeps: CliDeps = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  client: (o) => doorClient(o),
};

class UsageError extends Error {}

/** 1000000n -> "1", 5000n -> "0.005". */
export function formatUsdc(n: Micro): string {
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function positiveInt(v: string | undefined, flag: string): number {
  if (v === undefined || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new UsageError(`${flag} is required and must be a positive integer`);
  }
  return Number(v);
}

function nonNegativeInt(v: string | undefined, flag: string): number {
  if (v === undefined || !/^(0|[1-9]\d*)$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new UsageError(`${flag} must be a non-negative integer`);
  }
  return Number(v);
}

function required(v: string | undefined, flag: string): string {
  if (!v) throw new UsageError(`${flag} is required`);
  return v;
}

type Env = Record<string, string | undefined>;

function doorUrl(flag: string | undefined, env: Env): string {
  return flag ?? (env.CHARTER_DOOR_URL?.trim() || DEFAULT_DOOR);
}

function maxTick(env: Env): Micro {
  const raw = env.CHARTER_MAX_TICK?.trim();
  if (raw === undefined || raw === '') return DEFAULT_MAX_TICK;
  if (!/^\d{1,18}$/.test(raw)) throw new UsageError('CHARTER_MAX_TICK must be micro-USDC, such as 10000');
  return BigInt(raw);
}

/** The hex private key in CHARTER_KEY_FILE (64 hex, 0x optional). The file's contents are never printed. */
function keyFrom(env: Env): `0x${string}` {
  const file = env.CHARTER_KEY_FILE?.trim();
  if (!file) throw new UsageError('CHARTER_KEY_FILE is not set: rent and renew pay from the hex Base key in that file');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`CHARTER_KEY_FILE ${file} could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  const m = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(text.trim());
  if (!m) throw new Error(`CHARTER_KEY_FILE ${file} must hold one hex private key (64 hex, 0x optional)`);
  return `0x${m[1]!.toLowerCase()}`;
}

const ONION = /^[a-z2-7]{56}\.anyone$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * How a tenant reaches its home: plain ssh to a public host, or through Anyone for an onion host (the port is
 * the tenant's own SOCKS port). The line is meant to be pasted into a shell and is built from what the host
 * sent, so it is given only for a valid shape (the same rules as web/keys.ts); anything else is undefined.
 */
export function sshLine(a: HomeAccess): string | undefined {
  const { host, port, user } = (a?.ssh ?? {}) as Partial<HomeAccess['ssh']>;
  if (typeof host !== 'string' || user !== 'tenant') return undefined;
  if (ONION.test(host)) {
    if (port !== 22) return undefined;
    return `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${host}`;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (host.toLowerCase().endsWith('.anyone') || host.startsWith('-') || !(IPV4.test(host) || HOSTNAME.test(host))) return undefined;
  return `ssh -p ${port} tenant@${host}`;
}

/** Progress to stderr (none with --json), and the ssh line once, the first time a read shows it. */
function leaseProgress(d: CliDeps, json: boolean | undefined): (e: LeaseEvent) => void {
  let shown = false;
  return (e) => {
    if (e.kind === 'opened' && !json) d.err(`opened lease ${e.leaseId}`);
    else if (e.kind === 'ticked' && !json) d.err(`paid tick ${e.index}`);
    else if (e.kind === 'status' && e.access && !shown) {
      shown = true;
      const line = sshLine(e.access);
      if (line) d.err(line);
      else d.err('the host sent an address that is not a valid ssh login; not printing it');
    }
  };
}

function printResult(d: CliDeps, r: RunLeaseResult, json: boolean | undefined): number {
  const output = r.output ? decodeOutput(r.output) : undefined;
  if (json) {
    d.out(
      JSON.stringify({
        leaseId: r.lease.id,
        state: r.lease.state,
        paidIntervals: r.lease.paidIntervals,
        spent: r.spent.toString(),
        ...(output !== undefined ? { output } : {}),
      }),
    );
  } else {
    for (const line of leaseLines(r.lease)) d.out(line);
    d.out(`spent ${formatUsdc(r.spent)} USDC`);
    if (r.error) d.out(`boot error ${r.error}`);
    if (output !== undefined) d.out(`output\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`);
  }
  return r.lease.state === 'closed' ? 1 : 0;
}

function leaseLines(l: Lease): string[] {
  const lines = [`lease ${l.id}`, `state ${l.state}${l.closedReason ? ` (${l.closedReason})` : ''}`, `paid intervals ${l.paidIntervals}`];
  if (l.paidThrough !== undefined) lines.push(`paid through ${new Date(l.paidThrough).toISOString()}`);
  return lines;
}

function decodeOutput(b: Buffer): unknown {
  const text = b.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The body of a 2xx answer to a free read, or an error naming the door's answer. */
async function read(c: DoorClient, path: string): Promise<any> {
  const a = await c.get(path);
  if (a.status < 200 || a.status >= 300) throw new Error(`the door answered ${a.status} ${String(a.body?.error ?? '')}`.trimEnd());
  return a.body;
}

const leasePath = (leaseId: string) => `/v1/leases/${encodeURIComponent(leaseId)}`;

/** Refuses an offer dearer than the cap before anything is opened or paid. */
function checkPrice(o: DoorOffer, cap: Micro): void {
  const price = BigInt(o.tickPrice);
  if (price > cap) {
    throw new Error(`offer ${o.offerId} costs ${formatUsdc(price)} USDC a tick, above CHARTER_MAX_TICK (${formatUsdc(cap)} USDC): nothing paid`);
  }
}

async function offersCommand(rest: string[], env: Env, d: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: rest, options: { door: { type: 'string' } }, strict: true });
  const c = await d.client({ doorUrl: doorUrl(values.door, env), maxTickMicro: maxTick(env) });
  const offers = (await read(c, '/v1/offers')) as DoorOffer[];
  if (offers.length === 0) {
    d.out('no listed offers');
    return 0;
  }
  for (const o of offers) {
    d.out(
      [
        o.offerId,
        `${formatUsdc(BigInt(o.tickPrice))} USDC per ${o.intervalSeconds}s tick`,
        `${o.cpu} cpu ${o.memoryMiB} MiB`,
        `images ${o.images.join(',')}`,
        ...(o.home ? [`home ${o.home.diskGiB} GiB, ${o.home.free ?? '?'} of ${o.home.slots} free`] : []),
        o.hiddenHost ? 'hidden host' : 'host not hidden',
        `expires ${new Date(o.expiresAt).toISOString()}`,
      ].join('  '),
    );
  }
  return 0;
}

function jobOf(values: { urls?: string; python?: string; home?: string; image?: string }): JobSpec {
  if ([values.urls, values.python, values.home].filter((v) => v !== undefined).length !== 1) {
    throw new UsageError('rent takes exactly one of --urls, --python and --home');
  }
  if (values.image !== undefined && values.home === undefined) throw new UsageError('--image goes with --home');
  if (values.image !== undefined && !isHomeImage(values.image)) throw new UsageError(`--image must be a home image: ${HOME_IMAGES.join(', ')}`);
  if (values.home !== undefined) {
    const lines = readFileSync(values.home, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    const keys = normalizeSshKeys(lines);
    if (!keys) throw new UsageError('--home must name a file of 1 to 8 SSH public keys, one per line');
    return homeJob(keys, values.image);
  }
  if (values.python !== undefined) {
    const script = readFileSync(values.python, 'utf8');
    if (!isScript(script)) throw new UsageError(`--python must name a non-empty script of at most ${MAX_SCRIPT_BYTES} bytes`);
    return pythonJob(script);
  }
  return fetchJob(required(values.urls, '--urls').split(','));
}

/**
 * The offer named, or the first one in the door's order (its ranking) that runs the job and can be used: not over
 * `cap`, not waiting for the door's funding, and for a home, with a free slot. When every offer that runs the job
 * is over the cap, the first of those, so checkPrice says what it costs.
 */
function pickOffer(offers: DoorOffer[], job: JobSpec, ref: string | undefined, cap: Micro): DoorOffer {
  if (ref !== undefined) {
    const named = offers.find((o) => o.offerId === ref);
    if (!named) throw new Error(`the door lists no offer ${ref}`);
    if (!named.images.includes(job.image)) throw new Error(`offer ${ref} does not list the ${job.image} image`);
    return named;
  }
  const usable = offers.filter(
    (o) => o.images.includes(job.image) && o.record?.funding !== 'waiting' && !(isHomeImage(job.image) && o.home?.free === 0),
  );
  const first = usable.find((o) => BigInt(o.tickPrice) <= cap) ?? usable[0];
  if (!first) throw new Error(`the door lists no offer that runs ${job.image}`);
  return first;
}

async function rentCommand(rest: string[], env: Env, d: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      offer: { type: 'string' },
      urls: { type: 'string' },
      python: { type: 'string' },
      home: { type: 'string' },
      image: { type: 'string' },
      'max-intervals': { type: 'string' },
      door: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const job = jobOf(values);
  const maxIntervals = positiveInt(values['max-intervals'], '--max-intervals');
  const cap = maxTick(env);
  const key = keyFrom(env);
  const c = await d.client({ doorUrl: doorUrl(values.door, env), key, maxTickMicro: cap });

  const offer = pickOffer((await read(c, '/v1/offers')) as DoorOffer[], job, values.offer, cap);
  checkPrice(offer, cap);
  const api = doorHostApi(c, offer.offerId);
  const opts: RunLeaseOpts = { maxIntervals, now: d.now, sleep: d.sleep, onEvent: leaseProgress(d, values.json) };
  let r: RunLeaseResult;
  try {
    r = await runLease(api, leaseOfferOf(offer), job, opts);
  } catch (e) {
    if (!(e instanceof DoorOfferMovedError)) throw e;
    // Nothing is paid yet: the lease waits for its first tick on the host that holds the home.
    if (!values.json) d.err(e.message);
    checkPrice(e.offer, cap);
    r = await continueLease(api, leaseOfferOf(e.offer), e.leaseId, opts);
  }
  return printResult(d, r, values.json);
}

async function renewCommand(rest: string[], env: Env, d: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      lease: { type: 'string' },
      from: { type: 'string' },
      'max-intervals': { type: 'string' },
      door: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const leaseId = required(values.lease, '--lease');
  const from = values.from === undefined ? undefined : nonNegativeInt(values.from, '--from');
  const maxIntervals = positiveInt(values['max-intervals'], '--max-intervals');
  const cap = maxTick(env);
  const key = keyFrom(env);
  const c = await d.client({ doorUrl: doorUrl(values.door, env), key, maxTickMicro: cap });

  // The lease's offer, as the door snapshotted it at open, sets the price and the interval.
  const offer = ((await read(c, leasePath(leaseId))) as { offer?: DoorOffer }).offer;
  if (!offer) throw new Error(`the door names no offer for lease ${leaseId}`);
  checkPrice(offer, cap);
  // A home never reaches done, so this runs until --max-intervals or the lease closes.
  let r: RunLeaseResult;
  try {
    r = await continueLease(doorHostApi(c), leaseOfferOf(offer), leaseId, {
      ...(from !== undefined ? { from } : {}),
      maxIntervals,
      now: d.now,
      sleep: d.sleep,
      onEvent: leaseProgress(d, values.json),
    });
  } catch (e) {
    if (!(e instanceof FromMismatchError)) throw e;
    d.err(e.message);
    return 2;
  }
  return printResult(d, r, values.json);
}

async function statusCommand(rest: string[], env: Env, d: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { door: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) throw new UsageError('status takes <leaseId>');
  const c = await d.client({ doorUrl: doorUrl(values.door, env), maxTickMicro: maxTick(env) });
  const { lease, offer } = (await read(c, leasePath(positionals[0]!))) as { lease: Lease; offer?: DoorOffer };
  if (values.json) {
    d.out(
      JSON.stringify({
        leaseId: lease.id,
        state: lease.state,
        paidIntervals: lease.paidIntervals,
        ...(lease.paidThrough !== undefined ? { paidThrough: lease.paidThrough } : {}),
        ...(lease.closedReason ? { closedReason: lease.closedReason } : {}),
        ...(offer ? { offerId: offer.offerId } : {}),
      }),
    );
    return 0;
  }
  for (const line of leaseLines(lease)) d.out(line);
  if (offer) d.out(`offer ${offer.offerId}, ${formatUsdc(BigInt(offer.tickPrice))} USDC per ${offer.intervalSeconds}s tick`);
  if (lease.access) {
    const line = sshLine(lease.access);
    if (line) d.out(line);
  }
  return 0;
}

function addressCommand(rest: string[], env: Env, d: CliDeps): number {
  parseArgs({ args: rest, options: {}, strict: true });
  d.out(privateKeyToAccount(keyFrom(env)).address);
  return 0;
}

/** Anything the TOON payer took: refused by name, before a command runs. */
function goneUse(argv: string[], env: Env): string | undefined {
  if (argv[0] === 'payer') return 'charter payer is gone: rent and renew pay the door from CHARTER_KEY_FILE';
  if (argv.some((a) => a === '--relay' || a.startsWith('--relay='))) return '--relay is gone: offers come from the door';
  const set = GONE_ENV.find((name) => env[name] !== undefined && env[name]!.trim() !== '');
  if (set) return `${set} is gone: rent and renew pay the door from CHARTER_KEY_FILE`;
  return undefined;
}

export async function runCli(argv: string[], env: Env, deps: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = { ...defaultDeps, ...deps };
  const [cmd, ...rest] = argv;
  const gone = goneUse(argv, env);
  if (gone) {
    d.err(`${gone}\n${USAGE}`);
    return 2;
  }
  try {
    if (cmd === 'offers') return await offersCommand(rest, env, d);
    if (cmd === 'rent') return await rentCommand(rest, env, d);
    if (cmd === 'renew') return await renewCommand(rest, env, d);
    if (cmd === 'status') return await statusCommand(rest, env, d);
    if (cmd === 'address') return addressCommand(rest, env, d);
    d.err(USAGE);
    return 2;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (e instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
      d.err(`${(e as Error).message}\n${USAGE}`);
      return 2;
    }
    d.err(String(e instanceof Error ? e.message : e));
    return 1;
  }
}

// Run only when executed (also through the npm bin symlink), not when imported by a test.
const self = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (self === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
}
