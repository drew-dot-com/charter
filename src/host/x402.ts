import { paymentMiddleware } from '@x402/express';
import type { Micro } from '../types.js';
import { MAX_TIMEOUT_SECONDS, microToUsdc, paymentIdOf, type Gate, type Schemes, type X402Config } from '../x402/seller.js';

/**
 * The host's paid tick: `batch-settlement` only, at `priceOf()` to `cfg.payTo`. A host answers the door alone,
 * so a payment that verifies but whose payer is not `door()` answers 403 `not_door`; a non-2xx answer is never
 * settled. Sets `res.locals.payer` to the verified payer.
 */
export function hostTickGate(cfg: X402Config, priceOf: () => Micro, schemes: Schemes, door: () => string | undefined): Gate {
  const mw = paymentMiddleware({
    'POST /v1/leases/:id/ticks': {
      accepts: [{
        scheme: 'batch-settlement', network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        price: async () => microToUsdc(priceOf()),
      }],
      description: 'One paid interval of a Charter lease, sold to the door only.',
      mimeType: 'application/json',
      serviceName: 'charter-host',
    },
  }, schemes.server);
  return async (req, res, next) => {
    // The middleware runs this only once the payment has verified.
    await mw(req, res, () => {
      const payment = paymentIdOf(req);
      const payer = payment === 'none' || payment === 'bad' ? undefined : payment.from;
      const d = door()?.toLowerCase();
      if (!payer || !d || payer !== d) return void res.status(403).json({ error: 'not_door' });
      res.locals.payer = payer;
      next();
    });
  };
}
