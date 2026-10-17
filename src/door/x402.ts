import type { NextFunction, Request, Response } from 'express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import type { Micro } from '../types.js';

export interface X402Config {
  payTo: string;
  network: 'eip155:8453';
  facilitatorUrl: string;
}

/**
 * Resolves with the response already settled and flushed (or refused). Sets
 * `res.locals.payer` when the payment names who signed it.
 */
export type Gate = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Hooks for the 'free-for-tests' gate. */
export interface TestHooks {
  /** The gate was reached for this lease: a real gate would have asked for payment here. */
  onGate?: (leaseId: string) => void;
  /** Payment verification. Return false to refuse the payment, as a facilitator would. Default: it verifies. */
  verify?: (leaseId: string) => boolean;
  /** Settlement, after a 2xx. Throw to make it fail. */
  settle?: (info: { leaseId: string; price: Micro }) => void | Promise<void>;
}

const UNITS_PER_USDC = 1_000_000n;

/** Micro-USDC as the decimal string x402 prices take: 5000n is "0.005000". */
export function microToUsdc(m: Micro): string {
  return `${m / UNITS_PER_USDC}.${(m % UNITS_PER_USDC).toString().padStart(6, '0')}`;
}

/** What the route allows a payment to take: the middleware's `maxTimeoutSeconds`. */
export const MAX_TIMEOUT_SECONDS = 300;
/**
 * A payment must stay valid this long after the door looks at it. Verify and settle are a tick apart,
 * and a payer whose authorization lapses between them gets a host tick without paying for it.
 */
export const MIN_WINDOW_SECONDS = 110;
/**
 * The host tick's send must be over this long before the authorization's `validBefore`, so settlement
 * still has time. A tick whose send cannot start by then is skipped, unpaid on both sides.
 */
export const SETTLE_MARGIN_SECONDS = 15;

export interface PaymentId {
  from: string;
  nonce: string;
  /** Seconds since the epoch. */
  validAfter: number;
  validBefore: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SECONDS = /^\d{1,15}$/;

/**
 * The payment header the middleware will act on. It reads `payment-signature || x-payment`, so the
 * door accepts exactly one of the two, non-empty: with both (or an empty one beside the other) the two
 * could disagree about which authorization is being paid. 'none' when neither is present.
 */
function paymentHeader(req: Request): string | 'none' | 'bad' {
  const sig = req.headers['payment-signature'];
  const legacy = req.headers['x-payment'];
  if (sig === undefined && legacy === undefined) return 'none';
  if (sig !== undefined && legacy !== undefined) return 'bad';
  const h = sig ?? legacy;
  return typeof h === 'string' && h !== '' ? h : 'bad';
}

/**
 * The EIP-3009 authorization a payment header carries, in canonical form. One authorization can be
 * encoded many ways (key order, whitespace, extra fields), so this, not the header's bytes, is what
 * identifies a payment. The door offers EIP-3009 only: a payload that also carries a Permit2 authorization
 * is refused, since the facilitator might pay on the one the door did not read. 'bad' for anything that
 * is not exactly that.
 */
export function paymentIdOf(req: Request): PaymentId | 'none' | 'bad' {
  const h = paymentHeader(req);
  if (h === 'none' || h === 'bad') return h;
  try {
    const p = decodePaymentSignatureHeader(h) as { payload?: Record<string, unknown> } | null;
    const payload = p?.payload;
    if (typeof payload !== 'object' || payload === null || 'permit2Authorization' in payload) return 'bad';
    const a = payload.authorization as Record<string, unknown> | undefined;
    if (typeof a !== 'object' || a === null) return 'bad';
    const { from, nonce, validAfter, validBefore } = a;
    if (typeof from !== 'string' || !ADDRESS.test(from) || typeof nonce !== 'string' || !NONCE.test(nonce)) return 'bad';
    if (typeof validAfter !== 'string' || !SECONDS.test(validAfter) || typeof validBefore !== 'string' || !SECONDS.test(validBefore)) return 'bad';
    return { from: from.toLowerCase(), nonce: nonce.toLowerCase(), validAfter: Number(validAfter), validBefore: Number(validBefore) };
  } catch {
    return 'bad';
  }
}

/** The facilitator's reason for a failed settlement, from the PAYMENT-RESPONSE header the failure carried. */
export function settleReasonOf(res: Response): string | undefined {
  const h = res.getHeader('payment-response');
  if (typeof h !== 'string') return undefined;
  try {
    const r = decodePaymentResponseHeader(h) as { errorReason?: unknown };
    return typeof r.errorReason === 'string' ? r.errorReason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Facilitator reasons that are the payer's doing, by exact code: no balance, a nonce already used, a bad
 * signature. These are the exact-scheme EVM codes @x402/evm defines for those three meanings. Anything
 * else (the facilitator down, a facilitator wallet's own "nonce too low", an authorization that expired
 * while the tick waited) is not, so it never blocks.
 */
const PAYER_FAULT_REASONS: ReadonlySet<string> = new Set([
  'invalid_exact_evm_insufficient_balance',
  'invalid_exact_evm_nonce_already_used',
  'invalid_exact_evm_signature',
]);

export function isPayerFault(reason: string | undefined): boolean {
  return reason !== undefined && PAYER_FAULT_REASONS.has(reason);
}

/** The lease id out of `/v1/leases/<id>/ticks`. */
function leaseIdOfPath(path: string): string {
  return /^\/v1\/leases\/([^/]+)\/ticks\/?$/.exec(path)?.[1] ?? '';
}

/**
 * Real x402: `exact` on Base USDC, priced per request from `priceOf`, settled by
 * the facilitator only after the handler answers 2xx (the middleware's order, as LADING).
 */
export function realGate(cfg: X402Config, priceOf: (leaseId: string) => Micro | undefined): Gate {
  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(cfg.network, new ExactEvmScheme());
  const mw = paymentMiddleware(
    {
      'POST /v1/leases/:id/ticks': {
        accepts: {
          scheme: 'exact',
          network: cfg.network,
          payTo: cfg.payTo,
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          price: async (ctx) => {
            const price = priceOf(leaseIdOfPath(ctx.path));
            // The route guard has already resolved the lease, so this is a bug, not a user error.
            if (price === undefined) throw new Error('no price for this lease');
            return microToUsdc(price);
          },
        },
        description: 'One Charter interval: the door pays the host the same interval over TOON.',
        mimeType: 'application/json',
        serviceName: 'charter',
      },
    },
    server,
  );
  return async (req, res, next) => {
    const id = paymentIdOf(req);
    if (typeof id === 'object') res.locals.payer = id.from;
    await mw(req, res, next);
  };
}

/**
 * The stand-in for tests: every request is paid. Like the real middleware it
 * holds the handler's answer back, runs settlement after a 2xx, and replaces
 * the answer with a 402 when settlement throws.
 */
export function stubGate(priceOf: (leaseId: string) => Micro | undefined, hooks: TestHooks = {}): Gate {
  return async (req, res, next) => {
    const leaseId = String(req.params.id ?? '');
    hooks.onGate?.(leaseId);
    const payer = req.get('x-test-payer');
    if (payer) res.locals.payer = payer;
    if (hooks.verify?.(leaseId) === false) {
      res.status(402).json({ error: 'payment_invalid' });
      return;
    }

    const end = res.end.bind(res);
    let held: unknown[] = [];
    let ended!: () => void;
    const answered = new Promise<void>((r) => (ended = r));
    (res as unknown as { end: (...a: unknown[]) => Response }).end = (...a) => {
      held = a;
      ended();
      return res;
    };
    next();
    await answered;
    res.end = end;

    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        await hooks.settle?.({ leaseId, price: priceOf(leaseId) ?? 0n });
      } catch (e) {
        // As the real middleware: the reason travels in PAYMENT-RESPONSE.
        const errorReason = e instanceof Error ? e.message : 'Settlement failed';
        res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: false, errorReason })).toString('base64'));
        res.status(402).json({ error: 'settlement_failed' });
        return;
      }
    }
    (end as (...a: unknown[]) => unknown)(...held);
  };
}
