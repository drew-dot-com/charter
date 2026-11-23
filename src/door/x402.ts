import type { Response } from 'express';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { paymentMiddleware } from '@x402/express';
import type { Micro } from '../types.js';
import { MAX_TIMEOUT_SECONDS, buildSchemes, microToUsdc, type Gate, type Schemes, type TestHooks, type X402Config } from '../x402/seller.js';

/** The tick's catalog tags, most important first: PayAI's catalog keeps only the first five (seen 2026-11-06). */
export const BAZAAR_TAGS = ['compute', 'agent-hosting', 'hermes', 'sandbox', 'python', 'fetch', 'toon'] as const;
export const CATALOG_KEPT_TAGS = 5;

/** The lease id out of `/v1/leases/<id>/ticks`. */
function leaseIdOfPath(path: string): string {
  return /^\/v1\/leases\/([^/]+)\/ticks\/?$/.exec(path)?.[1] ?? '';
}

/** The body `POST /v1/rent` takes: the body of `POST /v1/leases`, with `offerId` optional. One of urls, python, home. */
export const RENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    offerId: { type: 'string', description: 'An offerId from GET /v1/offers. Left out: the cheapest listed offer that runs the job.' },
    python: {
      type: 'object',
      description: 'A python job: the script runs once with NumPy and no network; stdout, stderr and the exit code come back.',
      properties: { script: { type: 'string', maxLength: 8192 } },
      required: ['script'],
    },
    urls: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', description: 'An http or https URL.' }, description: 'A fetch job: each page loaded in a headless browser through a hidden exit.' },
    home: {
      type: 'object',
      description: 'A home: a box with a 10 GiB disk kept 7 days, reached by plain SSH with these keys (ssh -p <port> tenant@<host>, from the lease\'s access.ssh).',
      properties: {
        sshKeys: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
        image: { type: 'string', enum: ['charter-home', 'charter-hermes'] },
      },
      required: ['sshKeys'],
    },
  },
} as const;

export const RENT_OUTPUT_EXAMPLE = {
  leaseId: 'a'.repeat(32),
  state: 'running',
  paidIntervals: 1,
  paidThrough: 1760000000000,
  next: { path: `/v1/leases/${'a'.repeat(32)}/ticks`, index: 1 },
};

/** What `POST /v1/rent` costs for the body it carries (undefined body: a bare probe), or undefined when nothing is for rent. */
export type RentPriceOf = (body: unknown) => Promise<Micro | undefined>;

/**
 * The catalog descriptions, as PayAI's and CDP's Bazaars show them. At most DESCRIPTION_MAX characters: the client
 * echoes the resource in its payment, and CDP's facilitator refuses a payload whose description is longer (11-08).
 */
export const DESCRIPTION_MAX = 500;
export const TICK_DESCRIPTION =
  'One paid hour of sandboxed compute on Charter (0.007 USDC on the live host). A lease is a job (Python with NumPy, or a headless-browser fetch) or a home an agent can live in: a box with a 10 GiB disk kept 7 days, plain SSH at the address in access.ssh, network out through Anyone, optionally with Hermes Agent (image charter-hermes). No account, only a wallet. Open a lease first, free: POST /v1/leases. Procedure: https://charter.mainnet.toonprotocol.dev/agents';
export const RENT_DESCRIPTION =
  'Rent sandboxed compute on Charter in one call: opens a lease and pays its first hour (0.007 USDC on the live host). Send a job (python: a script up to 8 KiB with NumPy; urls: up to five pages in a headless browser) or a home (sshKeys: a box with a 10 GiB disk kept 7 days, plain SSH at the address in access.ssh; image charter-hermes has Hermes Agent). No account, only a wallet. Extend with POST /v1/leases/{leaseId}/ticks. Procedure: https://charter.mainnet.toonprotocol.dev/agents';

export function realGate(
  cfg: X402Config,
  priceOf: (leaseId: string) => Micro | undefined,
  schemes: Schemes = buildSchemes(cfg),
  offerBatch = true,
  rentPriceOf?: RentPriceOf,
): Gate {
  const price = async (ctx: { path: string }) => {
    const p = priceOf(leaseIdOfPath(ctx.path));
    // The route guard has already resolved the lease, so this is a bug, not a user error.
    if (p === undefined) throw new Error('no price for this lease');
    return microToUsdc(p);
  };
  const rentPrice = async (ctx: { adapter: { getBody?: () => unknown } }) => {
    const p = await rentPriceOf?.(ctx.adapter.getBody?.());
    // The route guard has already found an offer for this body, so this is a bug (or the offers changed under it).
    if (p === undefined) throw new Error('no price for this rent');
    return microToUsdc(p);
  };
  type Price = typeof price | typeof rentPrice;
  const option = (scheme: 'batch-settlement' | 'exact', p: Price = price) => ({ scheme, network: cfg.network, payTo: cfg.payTo, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, price: p });
  // Ticks: batch first, so a client that speaks both deposits once and signs ticks silently.
  const accepts = (p: Price = price) => (offerBatch ? [option('batch-settlement', p), option('exact', p)] : [option('exact', p)]);
  // Rent: exact first. A rent is one call, so a batch deposit (ten ticks at least) overpays a client that
  // only wanted the first hour, and CDP's Bazaar refuses a resource whose first option is not exact or upto.
  const rentAccepts = (p: Price) => (offerBatch ? [option('exact', p), option('batch-settlement', p)] : [option('exact', p)]);
  const routes: Parameters<typeof paymentMiddleware>[0] = {
    'POST /v1/leases/:id/ticks': {
      accepts: accepts(),
      description: TICK_DESCRIPTION,
      mimeType: 'application/json',
      serviceName: 'charter',
      tags: [...BAZAAR_TAGS],
      // The Bazaar declaration. A facilitator that keeps a catalog (PayAI does) lists the tick from a
      // payment whose client echoes this; the storefront's own payer does not, an @x402/fetch client does.
      extensions: declareDiscoveryExtension({
        bodyType: 'json',
        input: { index: 0 },
        inputSchema: { properties: { index: { type: 'number', description: 'The tick index, from 0, in order.' } }, required: ['index'] },
        pathParams: { id: 'a'.repeat(32) },
        pathParamsSchema: { properties: { id: { type: 'string', description: 'The leaseId from POST /v1/leases.' } }, required: ['id'] },
        output: { example: { paidIntervals: 1, paidThrough: 1760000000000, duplicate: false } },
      }),
    },
  };
  if (rentPriceOf) {
    routes['POST /v1/rent'] = {
      accepts: rentAccepts(rentPrice),
      description: RENT_DESCRIPTION,
      mimeType: 'application/json',
      serviceName: 'charter',
      tags: [...BAZAAR_TAGS],
      extensions: declareDiscoveryExtension({
        bodyType: 'json',
        input: { python: { script: 'print(2 + 2)' } },
        inputSchema: RENT_INPUT_SCHEMA,
        output: { example: RENT_OUTPUT_EXAMPLE },
      }),
    };
  }
  const mw = paymentMiddleware(routes, schemes.server);
  return async (req, res, next) => {
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
      // A rent has no lease in its path: the handler names the lease it opened.
      const settledId = leaseId || String(res.locals.leaseId ?? '');
      try {
        await hooks.settle?.({ leaseId: settledId, price: priceOf(settledId) ?? 0n });
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
