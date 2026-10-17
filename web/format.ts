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
    message: 'The signature expired before it reached the door. Approve the wallet prompt within ten seconds, and check that this device’s clock is right.',
    retry: true,
  },
  settlement_failed: { message: 'The payment did not go through. Try again.', retry: true },
  payment_invalid: { message: 'The payment did not go through. Try again.', retry: true },
  payment_reused: { message: 'That signature was already used. Try again to sign a new one.', retry: true },
  lease_done: { message: 'The job has finished. No further payment is needed.', retry: false, final: true },
  not_running: { message: 'This lease is closed. No further payment is needed.', retry: false, final: true },
  stopped: { message: 'The door stopped this lease. No further payment will be taken.', retry: false, final: true },
  payer_blocked: { message: 'This wallet is blocked after an earlier failed payment. Nothing was charged.', retry: false },
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

export interface JobOutput {
  pages: OutputPage[];
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Joins the base64 output parts as bytes, then reads result.json. Throws on any other shape. */
export function decodeOutput(parts: string[]): JobOutput {
  const chunks = parts.map(bytesOf);
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)) as unknown;
  const pages = (parsed as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) throw new Error('the output has no pages');
  return {
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
