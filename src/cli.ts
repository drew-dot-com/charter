#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Payer } from './payer.js';
import { ToonCli } from './toon-cli.js';
import type { Lease, Micro, Offer } from './types.js';
import { hostApi } from './tenant/host-api.js';
import { fetchOffers as fetchOffersFromRelay } from './tenant/offers.js';
import { runLease } from './tenant/run-lease.js';

const USAGE = `usage:
  charter offers --relay <url>
  charter rent --offer <id> --urls <a,b> --max-intervals <n> --relay <url> [--json]
  charter status <offerId> <leaseId> --relay <url> [--json]
paying commands read the wallet passphrase file named by TOON_PASSPHRASE_FILE`;

const JOB_IMAGE = 'charter-job-fetch';

export interface CliDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchOffers: (relayUrl: string, now: number) => Promise<Offer[]>;
  makePayer: (passphraseFile: string) => Payer;
}

const defaultDeps: CliDeps = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchOffers: (relayUrl, now) => fetchOffersFromRelay(relayUrl, now),
  makePayer: (passphraseFile) => new ToonCli({ passphraseFile }),
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

function required(v: string | undefined, flag: string): string {
  if (!v) throw new UsageError(`${flag} is required`);
  return v;
}

function passphraseFile(env: Record<string, string | undefined>): string {
  const f = env.TOON_PASSPHRASE_FILE;
  if (!f) throw new UsageError('TOON_PASSPHRASE_FILE is not set; paying commands need the wallet passphrase file');
  return f;
}

async function findOffer(d: CliDeps, relay: string, id: string): Promise<Offer> {
  const offers = await d.fetchOffers(relay, d.now());
  const o = offers.find((x) => x.id === id);
  if (!o) throw new Error(`no live offer with id ${id} on ${relay}`);
  return o;
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
        o.id,
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
      'max-intervals': { type: 'string' },
      relay: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
  });
  const offerId = required(values.offer, '--offer');
  const urls = required(values.urls, '--urls');
  const relay = required(values.relay, '--relay');
  const maxIntervals = positiveInt(values['max-intervals'], '--max-intervals');
  const payer = d.makePayer(passphraseFile(env));

  const offer = await findOffer(d, relay, offerId);
  if (!offer.images.includes(JOB_IMAGE)) throw new Error(`offer ${offerId} does not list the ${JOB_IMAGE} image`);
  const progress = (s: string) => {
    if (!values.json) d.err(s);
  };
  const r = await runLease(hostApi(payer, offer), offer, { image: JOB_IMAGE, args: { URLS: urls } }, {
    maxIntervals,
    now: d.now,
    sleep: d.sleep,
    onEvent: (e) => {
      if (e.kind === 'opened') progress(`opened lease ${e.leaseId}`);
      else if (e.kind === 'ticked') progress(`paid tick ${e.index}`);
    },
  });

  const output = r.output ? decodeOutput(r.output) : undefined;
  if (values.json) {
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

async function statusCommand(rest: string[], env: Record<string, string | undefined>, d: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { relay: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 2) throw new UsageError('status takes <offerId> <leaseId>');
  const [offerId, leaseId] = positionals as [string, string];
  const relay = required(values.relay, '--relay');
  const payer = d.makePayer(passphraseFile(env));
  const offer = await findOffer(d, relay, offerId);
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
  const d = { ...defaultDeps, ...deps };
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'offers') return await offersCommand(rest, d);
    if (cmd === 'rent') return await rentCommand(rest, env, d);
    if (cmd === 'status') return await statusCommand(rest, env, d);
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
