/** Pure helpers for the storefront: labels, links, tick answers, output decoding. No DOM, no wallet. */

const MIB_PER_GB = 1024;

function trimmed(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function sizeLabel(cpu: number, memoryMiB: number): string {
  return `${cpu} vCPU · ${trimmed(memoryMiB / MIB_PER_GB)} GB`;
}

/** USDC micro-units as dollars: two decimals at least, up to six. */
export function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${frac}`;
}

/** Micro-units per hour for a tick price (a decimal string) and an interval. */
export function pricePerHour(tickPrice: string, intervalSeconds: number): bigint {
  return (BigInt(tickPrice) * 3600n) / BigInt(intervalSeconds);
}

export interface Landing {
  chain: string;
  tx: string;
  shared: boolean;
}

export interface LandingLink {
  /** Present only for a known chain and a well-formed transaction id. */
  href?: string;
  tx: string;
  shared: boolean;
}

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function landingLink(landing: Landing | undefined): LandingLink | undefined {
  if (!landing) return undefined;
  const { chain, tx, shared } = landing;
  let href: string | undefined;
  if ((chain === 'base' || chain === 'evm') && EVM_TX.test(tx)) href = `https://basescan.org/tx/${tx}`;
  else if (chain === 'solana' && SOLANA_SIG.test(tx)) href = `https://solscan.io/tx/${tx}`;
  return { ...(href ? { href } : {}), tx, shared };
}

export type TickOutcome =
  | { kind: 'paid'; paidIntervals: number; paidThrough: number | undefined }
  /** Sign a new authorization and resend the same index. */
  | { kind: 'retry_later' }
  /** The door expects another index. */
  | { kind: 'resync'; expected: number }
  /** Stop paying and say why. `retry`: a button may offer another go. `final`: the lease is over, so look at its status. */
  | { kind: 'halt'; code: string; message: string; retry: boolean; final: boolean };

const HALTS: Record<string, { message: string; retry: boolean; final?: boolean }> = {
  busy: { message: 'A payment for this lease is already being processed. Is it open in another tab?', retry: true },
  rate_limited: { message: 'Too many requests from this network. Wait a minute, then try again.', retry: true },
  authorization_window: {
    message: 'The signature expired before it reached the door. Approve the wallet prompt sooner, and check that this device’s clock is right.',
    retry: true,
  },
  settlement_failed: { message: 'The payment did not go through. Try again.', retry: true },
  payment_invalid: { message: 'The payment did not go through. Try again.', retry: true },
  payment_reused: { message: 'That signature was already used. Try again to sign a new one.', retry: true },
  lease_done: { message: 'The job has finished. No further payment is needed.', retry: false, final: true },
  not_running: { message: 'This lease is closed. No further payment is needed.', retry: false, final: true },
  stopped: { message: 'The door stopped this lease. No further payment will be taken.', retry: false, final: true },
  payer_blocked: { message: 'This wallet is blocked after an earlier failed payment. Nothing was charged.', retry: false },
  capacity: { message: 'The door has reached its limit for today. Nothing was charged. Try again later.', retry: true },
  duplicate: { message: 'The host had already counted this payment, so the door stopped this lease. You were not charged for it.', retry: false, final: true },
  not_found: { message: 'The door does not know this lease.', retry: false },
};

/** What a tick answer means. `body` is the parsed JSON, or undefined when the body was not JSON. */
export function tickOutcome(status: number, body: unknown): TickOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status === 200) {
    if (typeof b.paidIntervals === 'number') {
      return { kind: 'paid', paidIntervals: b.paidIntervals, paidThrough: typeof b.paidThrough === 'number' ? b.paidThrough : undefined };
    }
    return { kind: 'halt', code: 'bad_answer', message: 'The door answered a payment with something unexpected.', retry: false, final: false };
  }
  const code = typeof b.error === 'string' ? b.error : 'unknown';
  if (status === 503 && code === 'retry_later') return { kind: 'retry_later' };
  if (status === 409 && code === 'out_of_order' && typeof b.expected === 'number' && Number.isSafeInteger(b.expected) && b.expected >= 0) {
    return { kind: 'resync', expected: b.expected };
  }
  const known = HALTS[code];
  if (known) return { kind: 'halt', code, message: known.message, retry: known.retry, final: known.final ?? false };
  if (status === 429) return { kind: 'halt', code, ...HALTS.rate_limited!, final: false };
  if (status === 402) return { kind: 'halt', code, ...HALTS.settlement_failed!, final: false };
  return { kind: 'halt', code, message: `The door could not take this payment (${status} ${code}).`, retry: status >= 500, final: false };
}

export interface OutputPage {
  url: string;
  text: string;
  jpegBase64: string | undefined;
}

export interface FetchOutput {
  kind: 'fetch';
  pages: OutputPage[];
}

/** What the python job reports about the renter's script. */
export interface PythonOutput {
  kind: 'python';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  seconds: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type JobOutput = FetchOutput | PythonOutput;

function pythonOutput(o: Record<string, unknown>): PythonOutput {
  const { exitCode, signal, seconds, stdout, stderr } = o;
  if (typeof stdout !== 'string' || typeof stderr !== 'string') throw new Error('the output has no stdout or stderr');
  if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error('the output has a malformed exit code');
  return {
    kind: 'python',
    exitCode: exitCode as number | null,
    signal: typeof signal === 'string' ? signal : null,
    timedOut: o.timedOut === true,
    seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0,
    stdout,
    stderr,
    stdoutTruncated: o.stdoutTruncated === true,
    stderrTruncated: o.stderrTruncated === true,
  };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Joins the base64 output parts as bytes, then reads result.json: a fetch's pages or a python run. Throws on any other shape. */
export function decodeOutput(parts: string[]): JobOutput {
  const chunks = parts.map(bytesOf);
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)) as unknown;
  if (typeof parsed === 'object' && parsed !== null && (parsed as { kind?: unknown }).kind === 'python') {
    return pythonOutput(parsed as Record<string, unknown>);
  }
  const pages = (parsed as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) throw new Error('the output has no pages');
  return {
    kind: 'fetch',
    pages: pages.map((p): OutputPage => {
      const o = p as { url?: unknown; text?: unknown; jpegBase64?: unknown } | null;
      if (!o || typeof o.url !== 'string' || typeof o.text !== 'string') throw new Error('the output has a malformed page');
      const jpeg = typeof o.jpegBase64 === 'string' && BASE64.test(o.jpegBase64) ? o.jpegBase64 : undefined;
      return { url: o.url, text: o.text, jpegBase64: jpeg };
    }),
  };
}

/** What the page says when the door's payment request is not the one it expected. */
export const UNEXPECTED_PAYMENT = 'Unexpected payment request';

/** The x402 client's own errors for a request none of its accepted options fits, and ours. */
export function isUnexpectedPayment(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return m.includes(UNEXPECTED_PAYMENT) || /filtered out by policies|rejected by spendControls|No network\/scheme registered|No payment requirements/.test(m);
}

/** What the page needs of an offer, as the door shows it (`GET /v1/offers`, and a lease status's `offer`). */
export interface PublicOffer {
  offerId: string;
  cpu: number;
  memoryMiB: number;
  intervalSeconds: number;
  /** USDC micro-units as a decimal string. */
  tickPrice: string;
  hiddenHost: boolean;
  hiddenEgress: boolean;
  /** The job images it runs. Empty when the door did not say. */
  images: string[];
  /** Epoch ms the offer lapses, when the door said. */
  expiresAt?: number;
  /** Leases this host has served through the door, with at least one paid interval, when the door said. */
  leases?: number;
  /** Epoch ms the newest of those opened. */
  lastLeaseAt?: number;
}

export function parseOffer(o: unknown): PublicOffer | undefined {
  const x = o as Partial<PublicOffer> | null;
  if (
    x &&
    typeof x.offerId === 'string' &&
    typeof x.cpu === 'number' &&
    typeof x.memoryMiB === 'number' &&
    typeof x.intervalSeconds === 'number' &&
    x.intervalSeconds > 0 &&
    typeof x.tickPrice === 'string' &&
    /^\d+$/.test(x.tickPrice) &&
    typeof x.hiddenHost === 'boolean'
  ) {
    const { offerId, cpu, memoryMiB, intervalSeconds, tickPrice, hiddenHost } = x;
    const images = Array.isArray(x.images) ? x.images.filter((i): i is string => typeof i === 'string') : [];
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    const expiresAt = num(x.expiresAt);
    const leases = num(x.leases);
    const lastLeaseAt = num(x.lastLeaseAt);
    return {
      offerId, cpu, memoryMiB, intervalSeconds, tickPrice, hiddenHost, hiddenEgress: x.hiddenEgress === true, images,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(leases !== undefined ? { leases } : {}),
      ...(lastLeaseAt !== undefined ? { lastLeaseAt } : {}),
    };
  }
  return undefined;
}

/** The price could not be checked (a failed lookup), as opposed to a payment request that does not match it. */
export const PRICE_UNCONFIRMED = 'Could not confirm the price';

export function isPriceUnconfirmed(e: unknown): boolean {
  return (e instanceof Error ? e.message : String(e)).includes(PRICE_UNCONFIRMED);
}

/** A hex id with its head and tail kept: `0xdfbd5e…48af`. */
export function shortHex(s: string, head = 8, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(-tail) : ''}`;
}

/** "45 s ago", "4 min ago", "3 h ago", "6 days ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** "30 s", "2 min 30 s", "2 h 3 min". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/** Local time of day, hh:mm:ss. */
export function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** A host's offer lives this long after it is published (src/host/loop.ts OFFER_LIFETIME_MS). */
export const OFFER_LIFETIME_MS = 30 * 60_000;

/** How long ago the offer was published, and how long until it lapses, from its expiry. */
export function offerFreshness(expiresAt: number, now: number): { publishedMs: number; expiresInMs: number } {
  return { publishedMs: Math.max(0, now - (expiresAt - OFFER_LIFETIME_MS)), expiresInMs: Math.max(0, expiresAt - now) };
}
