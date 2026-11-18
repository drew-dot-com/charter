/**
 * What the Charter MCP server does, with the network, the clock and the disk handed in so every rule
 * here is tested without a door or a wallet (server.ts wires the real ones).
 *
 * The money rules, all in this file:
 *  - only `exact` in USDC on Base, to the payee the door itself names, is ever signed (onlyDoorExact);
 *  - one hour never costs more than `maxHour` (a dearer 402 is not signed);
 *  - one UTC day never costs more than `maxDay` (reserved before a payment, given back only when the
 *    door answers a non-200, since that never settles; a call that throws keeps its reservation).
 */

export const BASE = 'eip155:8453';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const DEFAULT_DOOR = 'https://charter.mainnet.toonprotocol.dev';
export const LEASE_ID = /^[0-9a-f]{32}$/;

/** Longest text handed back for one page or one stream, so a tool answer stays readable. */
export const MAX_TEXT = 20_000;
/** Between two looks at a lease: the door caches a status for 5 s and each fresh look costs it a paid read. */
export const POLL_MS = 5_000;

export interface Answer {
  status: number;
  body: any;
  /** Settlement transaction, when the door's receipt names one. */
  tx?: string;
  /** Why a payment was refused, when the door or facilitator says. */
  reason?: string;
}

export interface Deps {
  /** A free read of the door. */
  get(path: string): Promise<Answer>;
  /** A paid POST. Throws when the policy left nothing to sign. Undefined when the server has no wallet. */
  pay?: (path: string, json: unknown) => Promise<Answer>;
  now(): number;
  sleep(ms: number): Promise<void>;
  spend: SpendBook;
  /** Micro-USDC. */
  maxHour: bigint;
}

/** A decimal USDC amount as micro-USDC. Throws on anything that is not a plain non-negative decimal. */
export function usdcToMicro(s: string): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a USDC amount: ${JSON.stringify(s)} (use a decimal such as 0.25)`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

export function microToUsdc(micro: bigint | number | string): string {
  const n = BigInt(micro);
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${n / 1_000_000n}${frac ? `.${frac}` : ''}`;
}

export interface Requirement {
  scheme?: unknown;
  network?: unknown;
  asset?: unknown;
  payTo?: unknown;
  amount?: unknown;
}

/**
 * The payment policy: of what a 402 offers, only `exact` in USDC on Base, to the door's own payee, at
 * no more than `maxHour`. Nothing left means nothing is signed.
 */
export function onlyDoorExact(payTo: string, maxHour: bigint) {
  return <T extends Requirement>(_version: number, reqs: T[]): T[] =>
    reqs.filter(
      (r) =>
        r.scheme === 'exact' &&
        r.network === BASE &&
        String(r.asset).toLowerCase() === BASE_USDC.toLowerCase() &&
        String(r.payTo).toLowerCase() === payTo.toLowerCase() &&
        /^\d+$/.test(String(r.amount)) &&
        BigInt(String(r.amount)) <= maxHour,
    );
}

/** What the server has spent today (UTC), kept on disk so a restart does not reset the day's cap. */
export interface SpendBook {
  /** Micro-USDC spent on `day` (YYYY-MM-DD). */
  spent(day: string): bigint;
  add(day: string, micro: bigint): void;
  readonly maxDay: bigint;
}

export class CapError extends Error {}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Reserves `micro` against today's cap, runs `pay`, and gives the reservation back unless the door answered 200. */
async function capped(d: Deps, micro: bigint, pay: () => Promise<Answer>): Promise<Answer> {
  const today = day(d.now());
  const spent = d.spend.spent(today);
  if (spent + micro > d.spend.maxDay) {
    throw new CapError(
      `the day's cap is reached: ${microToUsdc(spent)} of ${microToUsdc(d.spend.maxDay)} USDC spent today (UTC) and this call costs ${microToUsdc(micro)}. The operator raises it with CHARTER_MAX_USDC_PER_DAY.`,
    );
  }
  d.spend.add(today, micro);
  // A throw keeps the reservation: the request may have left with a signed payment, so the book errs
  // toward having spent. Only the door's own non-200 answer, which never settles, gives it back.
  const r = await pay();
  if (r.status !== 200) d.spend.add(today, -micro);
  return r;
}

export interface Offer {
  offerId: string;
  tickPrice: string;
  intervalSeconds: number;
  images: string[];
  [k: string]: unknown;
}

export type Job =
  | { python: { script: string } }
  | { urls: string[] }
  | { home: { sshKeys: string[]; image?: string } };

const IMAGE_OF = (job: Job): string =>
  'python' in job ? 'charter-job-python' : 'urls' in job ? 'charter-job-fetch' : (job.home.image ?? 'charter-home');

/** The cheapest live offer that runs the job, as the door itself would pick. */
export async function cheapestOffer(d: Pick<Deps, 'get'>, job: Job): Promise<Offer> {
  const r = await d.get('/v1/offers');
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`GET /v1/offers answered ${r.status}: cannot read the price, nothing paid`);
  const image = IMAGE_OF(job);
  const fits = (r.body as Offer[]).filter((o) => Array.isArray(o.images) && o.images.includes(image) && /^\d+$/.test(String(o.tickPrice)));
  if (fits.length === 0) throw new Error(`no machine on sale runs ${image} right now (GET /v1/offers lists ${r.body.length}). Try again later; nothing was paid.`);
  return fits.reduce((a, b) => (BigInt(b.tickPrice) < BigInt(a.tickPrice) ? b : a));
}

function needWallet(d: Deps): NonNullable<Deps['pay']> {
  if (!d.pay) throw new Error('this server has no wallet key, so the paid tools are off. Call charter_wallet to see why.');
  return d.pay;
}

function refusal(what: string, r: Answer): Error {
  const error = typeof r.body?.error === 'string' ? r.body.error : `status ${r.status}`;
  const why =
    r.status === 402
      ? `the payment was refused${r.reason ? ` (${r.reason})` : ''}. Most often the wallet holds too little USDC on Base: call charter_wallet`
      : error === 'busy'
        ? 'the machine is busy (every slot is taken). Try again in a few minutes'
        : error === 'payer_blocked'
          ? 'this wallet is blocked by the door because an earlier payment from it failed to settle'
          : error;
  const unpaid = r.body?.leaseId ? ` The lease ${r.body.leaseId} exists unpaid and lapses by itself in 90 seconds.` : '';
  return new Error(`${what} refused: ${why}. A refused call never settles, so nothing was charged.${unpaid}`);
}

export interface Rented {
  leaseId: string;
  offerId: string;
  paidUsdc: string;
  paidThrough: string;
  tx?: string;
}

/** Opens a lease and pays its first interval: one paid call. */
export async function rent(d: Deps, job: Job): Promise<Rented> {
  const pay = needWallet(d);
  const offer = await cheapestOffer(d, job);
  const price = BigInt(offer.tickPrice);
  if (price > d.maxHour) {
    throw new CapError(`one interval costs ${microToUsdc(price)} USDC, over this server's cap of ${microToUsdc(d.maxHour)} (CHARTER_MAX_USDC_PER_HOUR). Nothing was paid.`);
  }
  const r = await capped(d, price, () => pay('/v1/rent', { ...job, offerId: offer.offerId }));
  if (r.status !== 200 || !LEASE_ID.test(String(r.body?.leaseId))) throw refusal('the rent', r);
  return {
    leaseId: r.body.leaseId,
    offerId: offer.offerId,
    paidUsdc: microToUsdc(price),
    paidThrough: iso(r.body.paidThrough),
    ...(r.tx ? { tx: r.tx } : {}),
  };
}

const iso = (ms: unknown): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) + 'Z' : 'unknown');
const cut = (s: unknown): string => {
  const t = typeof s === 'string' ? s : '';
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[cut: ${t.length - MAX_TEXT} more characters]` : t;
};

export interface LeaseView {
  leaseId: string;
  state: string;
  closedReason?: string;
  paidIntervals: number;
  paidThrough: string;
  minutesLeft: number | null;
  /** A home's way in, once the host has published it. */
  ssh?: { host: string; port: number; user: string; how: string };
  outputParts: number;
  note?: string;
}

/** A free read of a lease. */
export async function lease(d: Pick<Deps, 'get' | 'now'>, leaseId: string): Promise<{ view: LeaseView; raw: any }> {
  if (!LEASE_ID.test(leaseId)) throw new Error('a leaseId is 32 lowercase hex characters');
  const r = await d.get(`/v1/leases/${leaseId}`);
  if (r.status === 404) throw new Error('the door does not know this lease (only a lease opened through the door can be read here)');
  if (r.status === 429) throw new Error('the door is rate limiting reads of this lease. Wait a minute and ask again.');
  const l = r.body?.lease;
  if (r.status !== 200 || !l) throw new Error(`the status read answered ${r.status}`);
  const through = typeof l.paidThrough === 'number' ? l.paidThrough : undefined;
  const ssh = l.access?.ssh;
  const view: LeaseView = {
    leaseId,
    state: String(l.state),
    ...(l.closedReason ? { closedReason: String(l.closedReason) } : {}),
    paidIntervals: Number(l.paidIntervals ?? 0),
    paidThrough: iso(through),
    minutesLeft: through === undefined ? null : Math.round((through - d.now()) / 60_000),
    ...(ssh?.host
      ? {
          ssh: {
            host: String(ssh.host),
            port: Number(ssh.port ?? 22),
            user: String(ssh.user ?? 'tenant'),
            how: 'The host is an onion address on the Anyone network. With an Anyone client running: ssh -o ProxyCommand="nc -x 127.0.0.1:<its SOCKS port> %h %p" tenant@<host>. No Anyone client, no way in.',
          },
        }
      : {}),
    outputParts: Number(l.outputParts ?? 0),
    ...(r.body.stopped ? { note: 'stopped by the door' } : {}),
  };
  return { view, raw: r.body };
}

/** A finished job's output, decoded: a python job's streams and exit code, or a fetch job's pages without the screenshots. */
export async function output(d: Pick<Deps, 'get'>, leaseId: string, parts: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  for (let n = 0; n < parts; n++) {
    const r = await d.get(`/v1/leases/${leaseId}/output/${n}`);
    if (r.status !== 200 || typeof r.body?.data !== 'string') throw new Error(`output part ${n} answered ${r.status}`);
    chunks.push(Buffer.from(r.body.data, 'base64'));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let out: any;
  try {
    out = JSON.parse(text);
  } catch {
    return { raw: cut(text) };
  }
  if (Array.isArray(out?.pages)) {
    return {
      pages: out.pages.map((p: any) => ({
        url: p.url,
        ...(p.error ? { error: p.error } : {}),
        text: cut(p.text),
        screenshot: p.jpegBase64 ? 'taken (not returned here; it is in the raw output part)' : 'none',
      })),
    };
  }
  if (out && typeof out === 'object' && ('stdout' in out || 'exitCode' in out)) {
    const { stdout, stderr, ...rest } = out;
    return { ...rest, stdout: cut(stdout), stderr: cut(stderr) };
  }
  return out;
}

export interface JobResult {
  lease: LeaseView;
  rented: Rented;
  /** Present when the job finished inside the wait. */
  output?: unknown;
  next?: string;
}

/** Rents a python or fetch job, waits for it to finish (it has one paid hour), and hands back the output. */
export async function runJob(d: Deps, job: Job, waitSeconds: number): Promise<JobResult> {
  const rented = await rent(d, job);
  const until = d.now() + waitSeconds * 1000;
  let seen: LeaseView | undefined;
  let lastError = '';
  while (d.now() < until) {
    await d.sleep(POLL_MS);
    try {
      seen = (await lease(d, rented.leaseId)).view;
      if (seen.state === 'done' || seen.state === 'closed') break;
    } catch (e) {
      // One failed look does not end the wait: the lease is paid and the job is running.
      lastError = (e as Error).message;
    }
  }
  if (!seen) {
    return {
      rented,
      lease: { leaseId: rented.leaseId, state: 'unknown', paidIntervals: 1, paidThrough: rented.paidThrough, minutesLeft: null, outputParts: 0 },
      next: `The lease is paid but its state could not be read (${lastError || 'no answer'}). Call charter_lease with this leaseId; it costs nothing.`,
    };
  }
  if (seen.state !== 'done' && seen.state !== 'closed') {
    return { rented, lease: seen, next: 'Still running. Call charter_lease with this leaseId to collect the output; it costs nothing and the hour is already paid.' };
  }
  if (seen.outputParts === 0) return { rented, lease: seen, next: `The lease ended with no output (${seen.closedReason ?? seen.state}).` };
  return { rented, lease: seen, output: await output(d, rented.leaseId, seen.outputParts) };
}

export interface Extended {
  leaseId: string;
  hoursPaid: number;
  paidUsdc: string;
  paidThrough: string;
  txs: string[];
  stopped?: string;
}

/** Pays the next `hours` intervals of a running lease, one payment each, in order. Stops at the first refusal. */
export async function extend(d: Deps, leaseId: string, hours: number): Promise<Extended> {
  const pay = needWallet(d);
  const first = await lease(d, leaseId);
  if (first.view.state === 'done' || first.view.state === 'closed') {
    throw new Error(`the lease is over (${first.view.closedReason ?? first.view.state}); nothing to extend and nothing was paid. A home opens again with the same keys.`);
  }
  const price = BigInt(String(first.raw.offer?.tickPrice ?? ''));
  if (price > d.maxHour) throw new CapError(`one interval costs ${microToUsdc(price)} USDC, over this server's cap of ${microToUsdc(d.maxHour)}. Nothing was paid.`);
  let index = first.view.paidIntervals;
  let paid = 0;
  let through = first.view.paidThrough;
  const txs: string[] = [];
  let stopped: string | undefined;
  for (; paid < hours; paid++, index++) {
    let r: Answer;
    try {
      r = await capped(d, price, () => pay(`/v1/leases/${leaseId}/ticks`, { index }));
    } catch (e) {
      if (paid === 0) throw e;
      stopped = (e as Error).message;
      break;
    }
    if (r.status !== 200) {
      if (paid === 0) throw refusal('the payment', r);
      stopped = refusal('the next payment', r).message;
      break;
    }
    if (r.tx) txs.push(r.tx);
    through = iso(r.body?.paidThrough);
  }
  return { leaseId, hoursPaid: paid, paidUsdc: microToUsdc(price * BigInt(paid)), paidThrough: through, txs, ...(stopped ? { stopped } : {}) };
}
