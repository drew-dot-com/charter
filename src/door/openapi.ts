import type { Micro } from '../types.js';
import { RENT_INPUT_SCHEMA, RENT_OUTPUT_EXAMPLE } from './x402.js';

const AGENTS = 'https://charterhome.dev/agents';

/** What an agent reads first: the procedure in a few sentences, including the tick route the index does not probe. */
const GUIDANCE = [
  'Rent a sandboxed machine by the hour with a wallet and no account. Read GET /v1/offers (free) for prices and images.',
  'POST /v1/rent with a job (python: { script } with NumPy and no network; urls: up to five pages fetched in a headless browser) or a home ({ home: { sshKeys } }: a box with its own disk (home.diskGiB) kept 7 days, plain SSH in with ssh -p <port> tenant@<host> from access.ssh (also root on a host whose offer says home.root); image charter-hermes for Hermes Agent preinstalled). offerId is optional: left out, the door picks by host record, then price. Homes are limited (home.slots in the offer); a full host answers busy.',
  'Hosts are run by independent operators, not vetted by Charter; an operator can see what runs on its machine. Each offer carries the host\'s record (probes passed, leases finished, success rate).',
  'It answers 402 with the price of one interval (hosts set their own; one hour at 0.012 USDC today), exact first (no deposit) or batch-settlement, USDC on Base. Pay it and the lease opens with its first interval paid.',
  'Keep it running: POST /v1/leases/{leaseId}/ticks with { "index": n } from 1, in order, paid the same way, before paidThrough runs out. Stop by not paying.',
  'Read the state free with GET /v1/leases/{leaseId}; a job\'s output is in GET /v1/leases/{leaseId}/output/{part}; a home\'s SSH address is in access.ssh (a host may also publish access.onion, which needs an Anyone client).',
  'Grants: a fund pays 30 days of a home to agents that pitch a use for one. POST /v1/grants with { name, pitch, sshKeys } is free; GET /v1/grants shows the balance, the grants left and every decision.',
  'Monthly allowance: POST /v1/allowances with { sshKeys, image? } for a home that has paid its first hour returns an approveUrl for your person to open (Base Account, one signature) and an ownerToken; once the state is active, Charter keeps the home paid and you stop your own renew loop. Stop it with POST /v1/allowances/{id}/stop and x-allowance-token.',
  `The whole procedure, prices, what to tell your operator and the trust section: ${AGENTS}`,
].join(' ');

const REFERRAL_PROPERTY = {
  type: 'string',
  description: 'Optional: a 0x address on Base that earns a share of every hour this renter pays for, paid in USDC on Base. Read GET /v1/referrals/{address}.',
};
const RENT_BODY = { ...RENT_INPUT_SCHEMA, properties: { ...RENT_INPUT_SCHEMA.properties, referral: REFERRAL_PROPERTY } };

const json = (schema: object, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const error = (description: string) => json({ type: 'object', properties: { error: { type: 'string' } }, required: ['error'] }, description);
const allowanceIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{32}$' } };
const allowanceTokenParam = { name: 'x-allowance-token', in: 'header', required: true, schema: { type: 'string' }, description: 'The ownerToken from creating the allowance.' };
/** What both receipt routes answer (src/door/receipts.ts). */
const signedReceipt = {
  type: 'object',
  required: ['receipt', 'message', 'signer', 'signature'],
  properties: {
    receipt: {
      type: 'object',
      required: ['v', 'kind', 'door', 'leaseRef', 'hostId', 'ticksPaid', 'intervalSeconds', 'sha256', 'at'],
      properties: {
        v: { type: 'integer', enum: [1] },
        kind: { type: 'string', enum: ['job', 'declared'] },
        door: { type: 'string' },
        leaseRef: { type: 'string', description: 'SHA-256 hex of "charter-lease:" and the lease id' },
        hostId: { type: 'string' },
        image: { type: 'string' },
        ticksPaid: { type: 'integer' },
        intervalSeconds: { type: 'integer' },
        payer: { type: 'string', description: 'The wallet that paid; absent when the grant fund or an allowance paid' },
        sha256: { type: 'string' },
        bytes: { type: 'integer' },
        cid: { type: 'string', description: 'declared only: the caller\'s CID as version 1 in base16' },
        at: { type: 'integer', description: 'Epoch ms the door signed' },
      },
    },
    message: { type: 'string', description: 'What was signed: "Charter receipt v1", a newline, the receipt as JSON' },
    signer: { type: 'string' },
    signature: { type: 'string', description: 'EIP-191 personal-message signature of message' },
  },
};
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
          description: 'Add "referral": "<0x address on Base>" and that address earns a share of every hour you pay for, paid in USDC on Base.',
          'x-payment-info': { price, protocols: [{ x402: {} }] },
          requestBody: { required: true, content: { 'application/json': { schema: RENT_BODY, example: { python: { script: 'print(2 + 2)' } } } } },
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
                  referral: { type: 'string', description: 'The address earning a share of this lease, when one is.' },
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
            '409': error('payment_reused, busy, channel_withdrawing, or home_host_gone: the host that holds this home\'s disk is not listed.'),
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
      '/v1/referrals/{address}': {
        get: {
          operationId: 'getReferral',
          summary: 'What a referral address has earned and been paid: hours, earned, paid, owed, held and the newest 50 payouts',
          tags: ['Referrals'],
          security: [],
          parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } }],
          responses: {
            '200': json({
              type: 'object',
              properties: {
                address: { type: 'string' },
                bps: { type: 'integer' },
                hours: { type: 'integer' },
                earned: { type: 'string' },
                paid: { type: 'string' },
                owed: { type: 'string' },
                held: { type: 'boolean' },
                payouts: { type: 'array', items: { type: 'object', properties: { amount: { type: 'string' }, tx: { type: 'string' }, at: { type: 'integer' } } } },
              },
              required: ['address', 'bps', 'hours', 'earned', 'paid', 'owed', 'held', 'payouts'],
            }),
            '400': error('bad_referral'),
            '429': error('rate_limited'),
          },
        },
      },
      '/v1/hosts': {
        get: {
          operationId: 'listHosts',
          summary: 'Every host the door knows, with its state and track record. Hosts are run by independent operators.',
          tags: ['Hosts'],
          security: [],
          responses: { '200': json({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          operationId: 'registerHost',
          summary: 'Register a host by its HTTPS URL: the door reads GET {url}/v1/offer, then probes it with a paid job before listing it',
          tags: ['Hosts'],
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', description: 'The host\'s https base URL.' } }, required: ['url'] } } },
          },
          responses: {
            '202': json({ type: 'object', properties: { hostId: { type: 'string' }, state: { type: 'string' } }, required: ['hostId', 'state'] }, 'Registered; listed once a probe passes.'),
            '400': error('bad_url, or bad_offer with a reason: open and status reads must be free, the tick at most the door\'s maximum, payTo an address, url the registered one.'),
            '429': error('rate_limited: 10 registrations an hour per IP, 1 per URL.'),
          },
        },
      },
      '/v1/leases': {
        post: {
          operationId: 'openLease',
          summary: 'Open a lease without paying (then pay index 0 on the tick route); POST /v1/rent does both',
          tags: ['Compute'],
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { ...RENT_BODY, required: ['offerId'] } } } },
          responses: { '200': json({ type: 'object', properties: { leaseId: { type: 'string' }, state: { type: 'string' }, referral: { type: 'string', description: 'The address earning a share of this lease, when one is.' } } }) },
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
      '/v1/leases/{leaseId}/receipt': {
        get: {
          operationId: 'getJobReceipt',
          summary: 'A finished job\'s signed receipt: the SHA-256 of its whole output, the host, and the intervals paid',
          description:
            'Free, within the lease\'s free reads. The door signs "Charter receipt v1" and the receipt as one line of JSON (EIP-191) with the address in GET /v1/door as receiptSigner. It says the host returned those bytes for a paid lease; hosts are not vetted, so it does not say the result is correct. The receipt names the lease by leaseRef, a hash, never by its id.',
          tags: ['Compute'],
          security: [],
          parameters: [leaseIdParam],
          responses: { '200': json(signedReceipt), '404': error('not_found'), '409': error('no_output, unpaid or home_lease'), '429': error('rate_limited: the lease has no free read left for a part not yet read'), '502': error('the host did not answer') },
        },
        post: {
          operationId: 'declareHomeReceipt',
          summary: 'A running home\'s declared receipt: the door signs a SHA-256 the lease holder gives, with its own time',
          description:
            'Free. A home has no output the door can see, so this receipt is the holder\'s own claim with the door\'s timestamp (kind "declared"), not proof of where a file came from. The body is a hash, and optionally a CID and a size: no other key is taken, so the door never signs free text. 60 an hour per lease.',
          tags: ['Compute'],
          security: [],
          parameters: [leaseIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['sha256'],
                  properties: {
                    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                    cid: { type: 'string', description: 'CIDv0, or CIDv1 in base32 or base16, over a sha2-256 digest. Signed as version 1 in base16; the door does not fetch it.' },
                    bytes: { type: 'integer', minimum: 0 },
                  },
                },
              },
            },
          },
          responses: { '200': json(signedReceipt), '400': error('bad_request'), '404': error('not_found'), '409': error('not_running, unpaid or not_a_home'), '429': error('rate_limited') },
        },
      },
      '/v1/allowances': {
        post: {
          operationId: 'createAllowance',
          summary: 'Ask for a link your person opens to approve a monthly Base spend permission that keeps a home paid. Homes only.',
          tags: ['Allowance'],
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { sshKeys: { type: 'array', items: { type: 'string' }, description: 'The home\'s SSH public keys, 1 to 8.' }, image: { type: 'string', description: 'charter-home (default) or charter-hermes.' } },
                  required: ['sshKeys'],
                },
              },
            },
          },
          responses: {
            '201': json(
              {
                type: 'object',
                properties: { allowanceId: { type: 'string' }, ownerToken: { type: 'string', description: 'Keep it: it reads the owner view and stops the allowance.' }, approveUrl: { type: 'string' }, state: { type: 'string' }, next: { type: 'string', description: 'The path to read it: /v1/allowances/<id>.' } },
                required: ['allowanceId', 'ownerToken', 'approveUrl', 'state'],
              },
              'Created in state waiting; give approveUrl to your person.',
            ),
            '400': error('The body is not valid.'),
            '404': error('no_home: the home has not paid its first hour yet.'),
            '409': error('already_live: this home already has a live allowance.'),
            '429': error('rate_limited'),
          },
        },
      },
      '/v1/allowances/{id}': {
        get: {
          operationId: 'getAllowance',
          summary: 'An allowance: its state (waiting, approved, active, short, spent_for_period, stopping, refused, ended, expired). With x-allowance-token, the owner view.',
          tags: ['Allowance'],
          security: [],
          parameters: [allowanceIdParam, { ...allowanceTokenParam, required: false, description: 'Optional: the owner view.' }],
          responses: { '200': json({ type: 'object' }), '403': error('bad_token'), '404': error('not_found') },
        },
      },
      '/v1/allowances/{id}/permission': {
        post: {
          operationId: 'submitAllowancePermission',
          summary: 'Used by the approval page at /allow to submit the signed spend permission. An agent does not call it.',
          tags: ['Allowance'],
          security: [],
          parameters: [allowanceIdParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': json({ type: 'object' }), '400': error('The permission does not match the allowance.'), '404': error('not_found'), '409': error('not_waiting, or permission_in_use.') },
        },
      },
      '/v1/allowances/{id}/stop': {
        post: {
          operationId: 'stopAllowance',
          summary: 'Stop the allowance with its owner token. Charter stops pulling and refunds what is left.',
          tags: ['Allowance'],
          security: [],
          parameters: [allowanceIdParam, allowanceTokenParam],
          responses: { '200': json({ type: 'object' }), '403': error('bad_token'), '404': error('not_found'), '409': error('not_live') },
        },
      },
    },
  };
}
