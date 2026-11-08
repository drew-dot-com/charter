import type { Micro } from '../types.js';
import { RENT_INPUT_SCHEMA, RENT_OUTPUT_EXAMPLE } from './x402.js';

const AGENTS = 'https://charter.mainnet.toonprotocol.dev/agents';

/** What an agent reads first: the procedure in a few sentences, including the tick route the index does not probe. */
const GUIDANCE = [
  'Rent a sandboxed machine by the hour with a wallet and no account. Read GET /v1/offers (free) for prices and images.',
  'POST /v1/rent with a job (python: { script } with NumPy and no network; urls: up to five pages fetched in a headless browser) or a home ({ home: { sshKeys } }: a box with a 2 GiB disk kept 7 days, SSH in at an onion address; image charter-hermes for Hermes Agent preinstalled). offerId is optional.',
  'It answers 402 with the price of one interval (one hour at 0.007 USDC on the live host), exact first (no deposit) or batch-settlement, USDC on Base. Pay it and the lease opens with its first interval paid.',
  'Keep it running: POST /v1/leases/{leaseId}/ticks with { "index": n } from 1, in order, paid the same way, before paidThrough runs out. Stop by not paying.',
  'Read the state free with GET /v1/leases/{leaseId}; a job\'s output is in GET /v1/leases/{leaseId}/output/{part}; a home\'s SSH address is in access.ssh.',
  `The whole procedure, prices, what to tell your operator and the trust section: ${AGENTS}`,
].join(' ');

const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const error = (description: string) => json({ type: 'object', properties: { error: { type: 'string' } }, required: ['error'] }, description);
const leaseIdParam = { name: 'leaseId', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{32}$' } };

/**
 * The door's OpenAPI document, as x402scan reads it (x402scan.com/discovery/spec.md): the paid rent route with
 * `x-payment-info`, and the free routes marked `security: []`. The tick route is left to the guidance: an
 * index probes each paid path literally, and a tick needs a lease that exists.
 *
 * `prices`: the tick prices of the offers open to rent now. One price is `fixed`, several a `dynamic` range,
 * none a range up to `max`. `contactEmail`: the operator's address for `info.contact`, left out when unset.
 */
/** Where a person reaches the operator. An index reads `info.contact` to verify who runs the origin. */
const CONTACT_URL = 'https://github.com/drew-dot-com/charter/issues';

export function openApiDoc(prices: Micro[], max: Micro, usd: (m: Micro) => string, contactEmail?: string): object {
  const sorted = [...new Set(prices)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const price =
    sorted.length === 1
      ? { mode: 'fixed', currency: 'USD', amount: usd(sorted[0]!) }
      : { mode: 'dynamic', currency: 'USD', min: usd(sorted[0] ?? 1n), max: usd(sorted[sorted.length - 1] ?? max) };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Charter',
      version: '1.0.0',
      description: 'Sandboxed compute by the hour, paid per interval in USDC on Base over x402. No account, only a wallet.',
      'x-guidance': GUIDANCE,
      contact: { name: 'Charter', url: CONTACT_URL, ...(contactEmail ? { email: contactEmail } : {}) },
    },
    externalDocs: { description: 'How an agent rents', url: AGENTS },
    paths: {
      '/v1/rent': {
        post: {
          operationId: 'rent',
          summary: 'Rent compute: open a lease and pay its first interval in one call',
          tags: ['Compute'],
          'x-payment-info': { price, protocols: [{ x402: {} }] },
          requestBody: { required: true, content: { 'application/json': { schema: RENT_INPUT_SCHEMA, example: { python: { script: 'print(2 + 2)' } } } } },
          responses: {
            '200': json(
              {
                type: 'object',
                properties: {
                  leaseId: { type: 'string' },
                  state: { type: 'string' },
                  paidIntervals: { type: 'integer' },
                  paidThrough: { type: 'integer', description: 'Epoch ms the paid time runs out.' },
                  next: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'integer' } } },
                  offer: { type: 'object' },
                },
                required: ['leaseId', 'paidIntervals', 'paidThrough', 'next'],
                example: RENT_OUTPUT_EXAMPLE,
              },
              'The lease is open and its first interval paid.',
            ),
            '400': error('The body is not a job or a home, or the offer does not run that image.'),
            '402': { description: 'Payment Required: one interval, exact first or batch-settlement, USDC on Base.' },
            '403': error('payer_blocked: this payer cost the door a failed settlement in the last 24 hours.'),
            '404': error('No listed offer for this body.'),
            '409': error('payment_reused, busy, or channel_withdrawing.'),
            '429': error('rate_limited'),
            '502': error('The host failed. When the lease opened, leaseId is in the body: pay index 0 on the tick route.'),
            '503': error('capacity, or retry_later with leaseId.'),
          },
        },
      },
      '/v1/offers': {
        get: {
          operationId: 'listOffers',
          summary: 'The machines for rent now, with their prices and images',
          tags: ['Compute'],
          security: [],
          responses: { '200': json({ type: 'array', items: { type: 'object' } }) },
        },
      },
      '/v1/leases': {
        post: {
          operationId: 'openLease',
          summary: 'Open a lease without paying (then pay index 0 on the tick route); POST /v1/rent does both',
          tags: ['Compute'],
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { ...RENT_INPUT_SCHEMA, required: ['offerId'] } } } },
          responses: { '200': json({ type: 'object', properties: { leaseId: { type: 'string' }, state: { type: 'string' } } }) },
        },
      },
      '/v1/leases/{leaseId}': {
        get: {
          operationId: 'getLease',
          summary: 'A lease: state, paid intervals, paidThrough, output parts, a home\'s SSH access',
          tags: ['Compute'],
          security: [],
          parameters: [leaseIdParam],
          responses: { '200': json({ type: 'object' }), '404': error('not_found') },
        },
      },
      '/v1/leases/{leaseId}/output/{part}': {
        get: {
          operationId: 'getLeaseOutput',
          summary: 'One part of a finished job\'s output',
          tags: ['Compute'],
          security: [],
          parameters: [leaseIdParam, { name: 'part', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
          responses: { '200': json({ type: 'object' }), '404': error('not_found') },
        },
      },
    },
  };
}
