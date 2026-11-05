#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_SCRIPT_BYTES, fetchJob, homeJob, HOME_IMAGES, isHomeImage, isScript, normalizeSshKeys, pythonJob } from './jobs.js';
import { offerFromJson } from './offer.js';
import { ToonClientPayer, serialized, type Payer, type ToonClientPayerConfig } from './payer.js';
import { payerAddress, toonClientConfigFromEnv } from './payer-env.js';
import { DEFAULT_DAILY_CAP, DEFAULT_LISTEN, DailyBudget, loadNostrKey, payerService } from './payer-service.js';
import { UrlPayer } from './payer-url.js';
import { ToonCli } from './toon-cli.js';
import type { HomeAccess, Lease, Micro, Offer } from './types.js';
import { hostApi } from './tenant/host-api.js';
import { fetchOffers as fetchOffersFromRelay } from './tenant/offers.js';
import { FromMismatchError, continueLease, runLease, type LeaseEvent, type RunLeaseResult } from './tenant/run-lease.js';

const USAGE = `usage:
  charter offers --relay <url>
  charter rent --offer <pubkey>:<id> (--urls <a,b> | --python <file.py> | --home <keys file> [--image <home image>]) --max-intervals <n> --relay <url> [--json]
  charter renew --offer <pubkey>:<id> --lease <id> [--from <index>] --max-intervals <n> [--relay <url>] [--json]
  charter status <pubkey>:<offerId> <leaseId> --relay <url> [--json]
  charter payer [--listen <host:port>]
--home takes one SSH public key per line, --image picks the home image (charter-home by default, or charter-hermes); renew pays an open lease from the host's paid count on
  (--from, when given, must equal that count, or nothing is paid)
paying commands read the wallet passphrase file named by TOON_PASSPHRASE_FILE
CHARTER_PAYER=toon-client pays with the TOON library instead (CHARTER_TOON_KEY_FILE, CHARTER_TOON_CHANNEL_STORE,
  CHARTER_TOON_CHAIN, CHARTER_TOON_CONNECTOR_URL or CHARTER_CONNECTOR_URL); CHARTER_OFFER_JSON, set inside a rented
  box, is the offer to use, and --relay is then not needed
CHARTER_PAYER=url pays through a charter payer service at CHARTER_PAYER_URL (http://127.0.0.1:3510 by default):
  \`charter payer\` is that service, one process that owns the toon-client channel (same CHARTER_TOON_* variables)
  and answers POST /send, GET /extract?url=, POST /relay/post, GET /relay/read and GET /health on loopback`;

export interface CliDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchOffers: (relayUrl: string, now: number) => Promise<Offer[]>;
  /** The payer CHARTER_PAYER names: `toon` (the default), `toon-client` or `url`. */
  makePayer: (env: Record<string, string | undefined>) => Promise<Payer>;
  /** Builds the `toon-client` payer; a seam for tests. */
  makeClientPayer: (cfg: ToonClientPayerConfig) => Promise<Payer>;
}

const defaultDeps: Omit<CliDeps, 'makePayer'> = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchOffers: (relayUrl, now) => fetchOffersFromRelay(relayUrl, now),
  makeClientPayer: (cfg) => ToonClientPayer.create(cfg),
};

class UsageError extends Error {}

/** The package version, for `charter payer`'s health and log lines. */
const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0';
  } catch {
    return '0';
  }
})();

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

function required(v: string | undefined, flag: string): string {
  if (!v) throw new UsageError(`${flag} is required`);
  return v;
}

function passphraseFile(env: Record<string, string | undefined>): string {
  const f = env.TOON_PASSPHRASE_FILE;
  if (!f) throw new UsageError('TOON_PASSPHRASE_FILE is not set; paying commands need the wallet passphrase file');
  return f;
}

/** `<pubkey>:<id>` names one host's offer exactly; a bare `<id>` is accepted only when one offer has it. */
export function resolveOffer(offers: Offer[], ref: string): Offer {
  const m = /^([0-9a-f]{64}):(.+)$/.exec(ref);
  if (m) {
    const exact = offers.find((x) => x.hostPubkey === m[1] && x.id === m[2]);
    if (exact) return exact;
    // A box's own offer (CHARTER_OFFER_JSON) has no pubkey when its host did not set CHARTER_HOST_PUBKEY:
    // it is the one candidate and names no host, so the id alone picks it.
    const only = offers.length === 1 ? offers[0]! : undefined;
    if (only && only.hostPubkey === '' && only.id === m[2]) return only;
    throw new Error(`no live offer ${ref}`);
  }
  const matches = offers.filter((x) => x.id === ref);
  if (matches.length === 0) throw new Error(`no live offer with id ${ref}`);
  if (matches.length > 1) {
    throw new Error(
      `offer id ${ref} is published by ${matches.length} hosts; name one as <pubkey>:<id>:\n` +
        matches.map((x) => `  ${x.hostPubkey}:${x.id}`).join('\n'),
    );
  }
  return matches[0]!;
}

async function payerFromEnv(env: Record<string, string | undefined>, makeClientPayer: CliDeps['makeClientPayer']): Promise<Payer> {
  const kind = env.CHARTER_PAYER?.trim() || 'toon';
  if (kind === 'toon') return new ToonCli({ passphraseFile: passphraseFile(env) });
  if (kind === 'url') return new UrlPayer(env.CHARTER_PAYER_URL?.trim() || `http://${DEFAULT_LISTEN}`);
  if (kind !== 'toon-client') throw new UsageError('CHARTER_PAYER must be toon, toon-client or url');
  return makeClientPayer(clientPayerConfig(env));
}

/** The toon-client payer's config. Inside a rented box the connector to send through is the one the box names. */
function clientPayerConfig(env: Record<string, string | undefined>): ToonClientPayerConfig {
  const connector = env.CHARTER_TOON_CONNECTOR_URL?.trim() || env.CHARTER_CONNECTOR_URL?.trim();
  if (!connector) throw new Error('CHARTER_TOON_CONNECTOR_URL or CHARTER_CONNECTOR_URL is required');
  return toonClientConfigFromEnv({ ...env, CHARTER_TOON_CONNECTOR_URL: connector });
}

function listenAddress(v: string): { host: string; port: number } {
  const m = /^(.+):(\d{1,5})$/.exec(v);
  const port = m ? Number(m[2]) : NaN;
  if (!m || !Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError('--listen must be <host>:<port>');
  return { host: m[1]!, port };
}

/**
 * `charter payer`: the one process in a box that owns the channel. Pays with the toon-client payer, one send at a
 * time, and serves the HTTP surface in payer-service.ts on loopback. Everything else in the box uses
 * CHARTER_PAYER=url. Runs until killed.
 */
async function payerCommand(rest: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: rest, options: { listen: { type: 'string' } }, strict: true });
  const { host, port } = listenAddress(values.listen ?? env.CHARTER_PAYER_LISTEN?.trim() ?? DEFAULT_LISTEN);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) d.err(`charter payer: listening on ${host}, not loopback; anyone who reaches it can spend from the channel`);
  const cfg = clientPayerConfig(env);
  const client = await ToonClientPayer.create(cfg);
  // The channel is opened (or found) now, not inside the first caller's deadline.
  try {
    await client.warm();
    const left = await client.headroom();
    d.err(`charter payer: channel ready, headroom ${left === undefined ? 'unknown' : formatUsdc(left)} USDC`);
  } catch (e) {
    d.err(`charter payer: could not open the channel at start (the first send retries it): ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  const capRaw = env.CHARTER_PAYER_DAILY_CAP?.trim();
  if (capRaw !== undefined && capRaw !== '' && !/^\d{1,18}$/.test(capRaw)) throw new UsageError('CHARTER_PAYER_DAILY_CAP must be micro-USDC');
  const storeDir = dirname(cfg.channelStore);
  const budget = new DailyBudget(join(storeDir, 'payer-budget.json'), capRaw ? BigInt(capRaw) : DEFAULT_DAILY_CAP, d.now);
  let nostrKey: Uint8Array | undefined;
  const address = payerAddress(cfg);
  const handler = payerService({
    payer: serialized(client),
    describe: () => client.describe(),
    connectorUrl: cfg.connectorUrl,
    payerAddress: address ?? null,
    channel: async () => {
      const left = await client.headroom();
      const live = client.channels().filter((c) => c.closedAt === undefined);
      return {
        chain: cfg.chain,
        payer: address ?? null,
        headroom: left === undefined ? null : left.toString(),
        channels: live.map((c) => ({ id: c.channel.channelId, depositTotal: c.depositTotal.toString(), signed: c.signed.toString() })),
      };
    },
    nostrKey: () => (nostrKey ??= loadNostrKey(env.CHARTER_PAYER_NOSTR_KEY_FILE?.trim() || join(storeDir, 'nostr.key'))),
    budget,
    ...(env.CHARTER_PAYER_EXTRACT_ROUTE?.trim() ? { extractRoute: env.CHARTER_PAYER_EXTRACT_ROUTE.trim() } : {}),
    ...(env.CHARTER_PAYER_RELAY_ROUTE?.trim() ? { relayRoute: env.CHARTER_PAYER_RELAY_ROUTE.trim() } : {}),
    ...(env.CHARTER_PAYER_RELAY_URL?.trim() ? { relayUrl: env.CHARTER_PAYER_RELAY_URL.trim() } : {}),
    now: d.now,
    log: (line) => d.err(`${new Date(d.now()).toISOString()} ${line}`),
    version: VERSION,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  d.err(`charter payer v${VERSION} listening on http://${host}:${port}, paying through ${cfg.connectorUrl}; daily cap ${formatUsdc(budget.cap)} USDC on the app endpoints`);
  const stop = () => {
    d.err('charter payer: stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>(() => undefined);
  return 0;
}

/**
 * The offer `ref` names. Inside a box CHARTER_OFFER_JSON is the host's own offer, read instead of a relay
 * (the box reaches the web only through its proxy, which a relay WebSocket would not pass).
 */
async function findOffer(d: CliDeps, env: Record<string, string | undefined>, relay: string | undefined, ref: string): Promise<Offer> {
  const own = env.CHARTER_OFFER_JSON;
  if (own !== undefined && own.trim() !== '') {
    const o = offerFromJson(own);
    if (!o) throw new Error('CHARTER_OFFER_JSON is not an offer');
    return resolveOffer([o], ref);
  }
  return resolveOffer(await d.fetchOffers(required(relay, '--relay'), d.now()), ref);
}

/** Read only when the offer comes from a relay, so a missing --relay is a usage error before anything is paid. */
function relayFor(d: CliDeps, env: Record<string, string | undefined>, relay: string | undefined): string | undefined {
  if (!env.CHARTER_OFFER_JSON?.trim()) return required(relay, '--relay');
  if (relay !== undefined) d.err('using the offer in CHARTER_OFFER_JSON; --relay is ignored');
  return undefined;
}

/** How a tenant reaches its home through Anyone; the port is the tenant's own SOCKS port. */
function sshLine(a: HomeAccess): string {
  return `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${a.ssh.host}`;
}

/** Progress to stderr (none with --json), and the ssh line once, the first time a read shows it. */
function leaseProgress(d: CliDeps, json: boolean | undefined): (e: LeaseEvent) => void {
  let shown = false;
  return (e) => {
    if (e.kind === 'opened' && !json) d.err(`opened lease ${e.leaseId}`);
    else if (e.kind === 'ticked' && !json) d.err(`paid tick ${e.index}`);
    else if (e.kind === 'status' && e.access && !shown) {
      shown = true;
      d.err(sshLine(e.access));
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
    for (const line of leaseLines(r.lease, r.spent)) d.out(line);
    if (r.error) d.out(`boot error ${r.error}`);
    if (output !== undefined) d.out(`output\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`);
  }
  return r.lease.state === 'closed' ? 1 : 0;
}

function nonNegativeInt(v: string | undefined, flag: string): number {
  if (v === undefined || !/^(0|[1-9]\d*)$/.test(v) || !Number.isSafeInteger(Number(v))) {
    throw new UsageError(`${flag} must be a non-negative integer`);
  }
  return Number(v);
}

function leaseLines(l: Lease, spent: Micro): string[] {
  const lines = [`lease ${l.id}`, `state ${l.state}${l.closedReason ? ` (${l.closedReason})` : ''}`, `paid intervals ${l.paidIntervals}`];
  if (l.paidThrough !== undefined) lines.push(`paid through ${new Date(l.paidThrough).toISOString()}`);
  lines.push(`spent ${formatUsdc(spent)} USDC`);
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

async function offersCommand(rest: string[], d: CliDeps): Promise<number> {
  const { values } = parseArgs({ args: rest, options: { relay: { type: 'string' } }, strict: true });
  const relay = required(values.relay, '--relay');
  const offers = await d.fetchOffers(relay, d.now());
  if (offers.length === 0) {
    d.out('no live offers');
    return 0;
  }
  for (const o of offers) {
    d.out(
      [
        `${o.hostPubkey}:${o.id}`,
        `${formatUsdc(o.tickPrice)} USDC per ${o.intervalSeconds}s tick`,
        `open ${formatUsdc(o.openPrice)}`,
        `${o.cpu} cpu ${o.memoryMiB} MiB`,
        `images ${o.images.join(',')}`,
        o.hiddenHost ? 'hidden host' : 'host not hidden',
        `expires ${new Date(o.expiresAt).toISOString()}`,
      ].join('  '),
    );
  }
  return 0;
}

async function rentCommand(rest: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      offer: { type: 'string' },
      urls: { type: 'string' },
      python: { type: 'string' },
      home: { type: 'string' },
      image: { type: 'string' },
      'max-intervals': { type: 'string' },
      relay: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const offerId = required(values.offer, '--offer');
  if ([values.urls, values.python, values.home].filter((v) => v !== undefined).length !== 1) {
    throw new UsageError('rent takes exactly one of --urls, --python and --home');
  }
  if (values.image !== undefined && values.home === undefined) throw new UsageError('--image goes with --home');
  if (values.image !== undefined && !isHomeImage(values.image)) throw new UsageError(`--image must be a home image: ${HOME_IMAGES.join(', ')}`);
  let job;
  if (values.home !== undefined) {
    const lines = readFileSync(values.home, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    const keys = normalizeSshKeys(lines);
    if (!keys) throw new UsageError('--home must name a file of 1 to 8 SSH public keys, one per line');
    job = homeJob(keys, values.image);
  } else if (values.python !== undefined) {
    const script = readFileSync(values.python, 'utf8');
    if (!isScript(script)) throw new UsageError(`--python must name a non-empty script of at most ${MAX_SCRIPT_BYTES} bytes`);
    job = pythonJob(script);
  } else {
    job = fetchJob(required(values.urls, '--urls').split(','));
  }
  const relay = relayFor(d, env, values.relay);
  const maxIntervals = positiveInt(values['max-intervals'], '--max-intervals');
  const payer = await d.makePayer(env);

  const offer = await findOffer(d, env, relay, offerId);
  if (!offer.images.includes(job.image)) throw new Error(`offer ${offerId} does not list the ${job.image} image`);
  const r = await runLease(hostApi(payer, offer), offer, job, {
    maxIntervals,
    now: d.now,
    sleep: d.sleep,
    onEvent: leaseProgress(d, values.json),
  });
  return printResult(d, r, values.json);
}

async function renewCommand(rest: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      offer: { type: 'string' },
      lease: { type: 'string' },
      from: { type: 'string' },
      'max-intervals': { type: 'string' },
      relay: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const offerId = required(values.offer, '--offer');
  const leaseId = required(values.lease, '--lease');
  const from = values.from === undefined ? undefined : nonNegativeInt(values.from, '--from');
  const maxIntervals = positiveInt(values['max-intervals'], '--max-intervals');
  const relay = relayFor(d, env, values.relay);
  const payer = await d.makePayer(env);

  const offer = await findOffer(d, env, relay, offerId);
  // A home never reaches done, so this runs until --max-intervals or the lease closes.
  let r: RunLeaseResult;
  try {
    r = await continueLease(hostApi(payer, offer), offer, leaseId, {
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

async function statusCommand(rest: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { relay: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 2) throw new UsageError('status takes <offerId> <leaseId>');
  const [offerId, leaseId] = positionals as [string, string];
  const relay = relayFor(d, env, values.relay);
  const payer = await d.makePayer(env);
  const offer = await findOffer(d, env, relay, offerId);
  const api = hostApi(payer, offer);
  const lease = await api.status(leaseId);
  if (values.json) {
    d.out(
      JSON.stringify({
        leaseId: lease.id,
        state: lease.state,
        paidIntervals: lease.paidIntervals,
        spent: api.spent().toString(),
        ...(lease.paidThrough !== undefined ? { paidThrough: lease.paidThrough } : {}),
        ...(lease.closedReason ? { closedReason: lease.closedReason } : {}),
      }),
    );
  } else {
    for (const line of leaseLines(lease, api.spent())) d.out(line);
  }
  return 0;
}

export async function runCli(argv: string[], env: Record<string, string | undefined>, deps: Partial<CliDeps> = {}): Promise<number> {
  const makeClientPayer = deps.makeClientPayer ?? defaultDeps.makeClientPayer;
  // Unless a test replaces it, the payer is the one CHARTER_PAYER names, built with this run's makeClientPayer.
  const d: CliDeps = { ...defaultDeps, ...deps, makeClientPayer, makePayer: deps.makePayer ?? ((e) => payerFromEnv(e, makeClientPayer)) };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'offers') return await offersCommand(rest, d);
    if (cmd === 'rent') return await rentCommand(rest, env, d);
    if (cmd === 'renew') return await renewCommand(rest, env, d);
    if (cmd === 'status') return await statusCommand(rest, env, d);
    if (cmd === 'payer') return await payerCommand(rest, env, d);
    d.err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
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
