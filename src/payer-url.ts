import { DeadlinePassedError, PacketRefusedError, SendTimeoutError, WRAPPER_GRACE_MS, type PacketAnswer, type PacketRequest, type Payer, type SendOpts } from './payer.js';

/** How long a send through the service may take when it names no deadline: the service's own 45 s, the queue ahead of it, and slack. */
export const URL_SEND_TIMEOUT_MS = 120_000;

/**
 * How long a send keeps retrying a refused connection: nothing listens, so nothing was sent and a retry
 * cannot pay twice. It outlasts boot-default.sh restarting a dead payer (30 s) plus the payer's own start.
 */
export const URL_REFUSED_RETRY_MS = 90_000;
export const URL_REFUSED_GAP_MS = 2_000;

export interface UrlPayerRetry {
  /** 0 turns the retry off. */
  refusedRetryMs?: number;
  refusedGapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether a fetch failed because nothing accepted the connection, so the request never left this side. */
export function isRefused(e: unknown): boolean {
  const codes = (x: unknown): string[] => {
    if (!x || typeof x !== 'object') return [];
    const o = x as { code?: unknown; errors?: unknown; cause?: unknown };
    return [
      ...(typeof o.code === 'string' ? [o.code] : []),
      ...(Array.isArray(o.errors) ? o.errors.flatMap(codes) : []),
      ...(o.cause !== undefined && o.cause !== x ? codes(o.cause) : []),
    ];
  };
  const found = codes(e);
  return found.length > 0 && found.every((c) => c === 'ECONNREFUSED');
}

/** The JSON a `POST /send` carries. Amounts and the deadline travel as strings and numbers; the body is passed as is. */
export interface SendWire {
  dest: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  sealKey: string;
  sealUrl: string;
  /** Micro-USDC, decimal string. */
  amount: string;
  priority?: 'high';
  /** Epoch ms. */
  deadline?: number;
}

/** What `POST /send` answers with 200. */
export interface SendWireAnswer {
  status: number;
  body: unknown;
  /** Micro-USDC, decimal string. */
  paid: string;
}

/** What `POST /send` answers with a non-2xx status. */
export interface SendWireError {
  error: string;
  message?: string;
  code?: string;
  refusedBy?: string;
}

/** The service could not be reached, or answered something that is not its protocol. Nothing was paid as far as this side knows. */
export class PayerServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayerServiceError';
  }
}

function detail(e: unknown): string {
  const msg = String(e instanceof Error ? e.message : e);
  const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : '';
  return (msg + cause).slice(0, 200);
}

/** Turns a service error body back into the error the local payer would have thrown. */
export function errorFromWire(status: number, e: SendWireError): Error {
  if (e.error === 'packet_refused') return new PacketRefusedError(e.code ?? '?', e.refusedBy ?? '?', e.message ?? '');
  if (e.error === 'deadline_passed') return new DeadlinePassedError();
  if (e.error === 'send_timeout') return new SendTimeoutError();
  return new PayerServiceError(`payer service answered ${status} ${e.error}${e.message ? `: ${e.message.slice(0, 400)}` : ''}`);
}

/**
 * A Payer that sends through a `charter payer` service on this machine (`CHARTER_PAYER=url`). The service
 * owns the channel and its running total; every process in a box pays through it, so no two sign at once.
 */
export class UrlPayer implements Payer {
  private readonly base: string;
  private readonly refusedRetryMs: number;
  private readonly refusedGapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    url: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    retry: UrlPayerRetry = {},
  ) {
    this.base = url.replace(/\/+$/, '');
    this.refusedRetryMs = retry.refusedRetryMs ?? URL_REFUSED_RETRY_MS;
    this.refusedGapMs = retry.refusedGapMs ?? URL_REFUSED_GAP_MS;
    this.sleep = retry.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async send(dest: string, req: PacketRequest, opts: SendOpts): Promise<PacketAnswer> {
    const wire: SendWire = {
      dest,
      method: req.method,
      path: req.path,
      ...(req.body === undefined ? {} : { body: req.body }),
      sealKey: opts.sealKey,
      sealUrl: opts.sealUrl,
      amount: opts.amount.toString(),
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }),
    };
    // A refused connection (the payer restarting) is retried until the window or the deadline ends. Any
    // other failure is not: the service may have taken the send, and a second one could pay twice.
    const retryUntil = Math.min(this.now() + this.refusedRetryMs, opts.deadline ?? Number.POSITIVE_INFINITY);
    let res: Response;
    for (;;) {
      // The service gives up on a deadline send itself; this waits a little past that, never less than a moment.
      const ms = opts.deadline === undefined ? URL_SEND_TIMEOUT_MS : Math.max(1_000, opts.deadline - this.now() + 2 * WRAPPER_GRACE_MS);
      try {
        res = await this.fetchFn(`${this.base}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(wire),
          signal: AbortSignal.timeout(ms),
        });
        break;
      } catch (e) {
        const gap = Math.min(this.refusedGapMs, retryUntil - this.now());
        if (isRefused(e) && gap > 0) {
          await this.sleep(gap);
          continue;
        }
        throw new PayerServiceError(`payer service unreachable at ${this.base}: ${detail(e)}`);
      }
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new PayerServiceError(`payer service answered ${res.status} with no JSON`);
    }
    if (res.ok) {
      const a = parsed as SendWireAnswer;
      if (typeof a.status !== 'number' || typeof a.paid !== 'string' || !/^\d+$/.test(a.paid)) {
        throw new PayerServiceError('payer service answered an unreadable send result');
      }
      return { status: a.status, body: a.body, paid: BigInt(a.paid) };
    }
    const e = (parsed ?? {}) as SendWireError;
    throw errorFromWire(res.status, typeof e.error === 'string' ? e : { error: 'unknown' });
  }
}
