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
  /** Settlement, after a 2xx. Throw to make it fail. */
  settle?: (info: { leaseId: string; price: Micro }) => void | Promise<void>;
}

const UNITS_PER_USDC = 1_000_000n;

/** Micro-USDC as the decimal string x402 prices take: 5000n is "0.005000". */
export function microToUsdc(m: Micro): string {
  return `${m / UNITS_PER_USDC}.${(m % UNITS_PER_USDC).toString().padStart(6, '0')}`;
}

interface DecodedPayment {
  payload?: {
    authorization?: { from?: unknown; nonce?: unknown };
    permit2Authorization?: { from?: unknown; nonce?: unknown };
    from?: unknown;
  };
}

function paymentHeader(req: Request): string | undefined {
  return req.get('payment-signature') ?? req.get('x-payment');
}

/** Who signed the x402 payment on this request, when it carried one. Best effort. */
export function payerOf(req: Request): string | undefined {
  const h = paymentHeader(req);
  if (!h) return undefined;
  try {
    const p = decodePaymentSignatureHeader(h) as DecodedPayment;
    const from = p.payload?.authorization?.from ?? p.payload?.from;
    return typeof from === 'string' ? from : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The signed authorization a payment header carries: who signed it and its nonce, lowercased. One
 * authorization can be encoded many ways (key order, whitespace, extra fields), so this, not the
 * header's bytes, is what identifies a payment. 'none' when there is no payment header; 'bad' when
 * it does not decode to both fields.
 */
export function paymentIdOf(req: Request): { from: string; nonce: string } | 'none' | 'bad' {
  const h = paymentHeader(req);
  if (!h) return 'none';
  try {
    const p = decodePaymentSignatureHeader(h) as DecodedPayment | null;
    const a = p?.payload?.authorization ?? p?.payload?.permit2Authorization;
    if (typeof a?.from === 'string' && typeof a.nonce === 'string' && a.from !== '' && a.nonce !== '') {
      return { from: a.from.toLowerCase(), nonce: a.nonce.toLowerCase() };
    }
  } catch {
    // falls through
  }
  return 'bad';
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
 * A settlement failure that is the payer's doing: no balance, a nonce already used, a bad signature.
 * Anything else (the facilitator down, an authorization that expired while the tick waited) is not.
 */
export function isPayerFault(reason: string | undefined): boolean {
  return reason !== undefined && /insufficient|nonce|signature/i.test(reason);
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
          maxTimeoutSeconds: 60,
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
    const payer = payerOf(req);
    if (payer) res.locals.payer = payer;
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
