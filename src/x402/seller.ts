import type { NextFunction, Request, Response } from 'express';
import { HTTPFacilitatorClient, type FacilitatorConfig } from '@x402/core/server';
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import type { AuthorizerSigner } from '@x402/evm/batch-settlement/server';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';
import { FileChannelStorage } from '@x402/evm/batch-settlement/server/file-storage';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { x402ResourceServer } from '@x402/express';
import { privateKeyToAccount } from 'viem/accounts';
import type { Micro } from '../types.js';

const CLAIM_KEY = /^0x[0-9a-f]{64}$/i;

/**
 * CHARTER_CLAIM_KEY_FILE: one 0x-prefixed 64-hex secp256k1 private key, the door's x402 claim authorizer.
 * It signs claim batches and refunds for the payee and holds no funds. The message never carries key bytes.
 */
export function parseClaimKey(fileText: string): `0x${string}` {
  const s = fileText.trim();
  if (!CLAIM_KEY.test(s) || s.includes('\n')) throw new Error('CHARTER_CLAIM_KEY_FILE must hold one 0x-prefixed 64-hex private key');
  return s as `0x${string}`;
}

/** The claim key as the x402 batch-settlement server's receiver authorizer: an address and a typed-data signer. */
export function claimSigner(key: `0x${string}`): AuthorizerSigner {
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    signTypedData: (params) => account.signTypedData(params as unknown as Parameters<typeof account.signTypedData>[0]),
  };
}

export interface X402Config {
  payTo: string;
  network: 'eip155:8453';
  facilitatorUrl: string;
  /** The door's x402 claim authorizer: a hex secp256k1 private key (CHARTER_CLAIM_KEY_FILE). */
  claimKey: `0x${string}`;
  /** Where the batch-settlement server keeps its channel records (one JSON file per channel). */
  channelDir: string;
  /**
   * A second facilitator for `exact` only (CDP, CHARTER_CDP_KEY_FILE). CDP's Bazaar lists a resource only from
   * payments settled through CDP; batch stays with `facilitatorUrl`, whose claims and refunds the door's timers run.
   */
  exactFacilitator?: FacilitatorConfig;
}

/** A facilitator client that admits to `exact` only, so the resource server sends it nothing else. */
class ExactOnlyFacilitator extends HTTPFacilitatorClient {
  override async getSupported(): ReturnType<HTTPFacilitatorClient['getSupported']> {
    const s = await super.getSupported();
    return { ...s, kinds: s.kinds.filter((k) => k.scheme === 'exact') };
  }
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

/** One `exact` EIP-3009 authorization: one payment, spent once. */
export interface ExactPaymentId {
  kind: 'exact';
  from: string;
  nonce: string;
  /** Seconds since the epoch. */
  validAfter: number;
  validBefore: number;
}
/**
 * A `batch-settlement` voucher or deposit. Vouchers are cumulative per channel, so one is never "spent": the
 * scheme's channel state decides whether it pays for this request. The door only needs to know who pays.
 */
export interface BatchPaymentId {
  kind: 'batch';
  from: string;
  channelId: string;
  maxClaimable: string;
  /** A deposit's EIP-3009 window, seconds since the epoch; absent on a voucher, which has no window. */
  validAfter?: number;
  validBefore?: number;
}
export type PaymentId = ExactPaymentId | BatchPaymentId;

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
    if (payload.type === 'voucher' || payload.type === 'deposit') return batchIdOf(payload);
    const a = payload.authorization as Record<string, unknown> | undefined;
    if (typeof a !== 'object' || a === null) return 'bad';
    const { from, nonce, validAfter, validBefore } = a;
    if (typeof from !== 'string' || !ADDRESS.test(from) || typeof nonce !== 'string' || !NONCE.test(nonce)) return 'bad';
    if (typeof validAfter !== 'string' || !SECONDS.test(validAfter) || typeof validBefore !== 'string' || !SECONDS.test(validBefore)) return 'bad';
    return { kind: 'exact', from: from.toLowerCase(), nonce: nonce.toLowerCase(), validAfter: Number(validAfter), validBefore: Number(validBefore) };
  } catch {
    return 'bad';
  }
}

const DECIMAL = /^\d{1,30}$/;

/** A batch payload names its payer in the channel config and its cumulative amount in the voucher. Anything else beside it is 'bad'. */
function batchIdOf(payload: Record<string, unknown>): BatchPaymentId | 'bad' {
  if ('authorization' in payload) return 'bad';
  const c = payload.channelConfig as Record<string, unknown> | undefined;
  const v = payload.voucher as Record<string, unknown> | undefined;
  if (typeof c !== 'object' || c === null || typeof v !== 'object' || v === null) return 'bad';
  const { payer } = c;
  const { channelId, maxClaimableAmount } = v;
  if (typeof payer !== 'string' || !ADDRESS.test(payer) || typeof channelId !== 'string' || !NONCE.test(channelId)) return 'bad';
  if (typeof maxClaimableAmount !== 'string' || !DECIMAL.test(maxClaimableAmount)) return 'bad';
  const id: BatchPaymentId = { kind: 'batch', from: payer.toLowerCase(), channelId: channelId.toLowerCase(), maxClaimable: maxClaimableAmount };
  if (payload.type === 'voucher') return id;
  // A deposit moves the renter's USDC by an EIP-3009 authorization with a window, as an exact payment does.
  // The door offers EIP-3009 only: a Permit2 deposit is refused, as for exact.
  const deposit = payload.deposit as Record<string, unknown> | undefined;
  const authorization = (deposit?.authorization ?? {}) as Record<string, unknown>;
  const auth = authorization.erc3009Authorization as Record<string, unknown> | undefined;
  if (typeof auth !== 'object' || auth === null || 'permit2Authorization' in authorization) return 'bad';
  const { validAfter, validBefore } = auth;
  if (typeof validAfter !== 'string' || !SECONDS.test(validAfter) || typeof validBefore !== 'string' || !SECONDS.test(validBefore)) return 'bad';
  return { ...id, validAfter: Number(validAfter), validBefore: Number(validBefore) };
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
  'invalid_batch_settlement_evm_insufficient_balance',
  'invalid_batch_settlement_evm_receive_authorization_signature',
  'invalid_batch_settlement_evm_voucher_signature',
  'invalid_exact_evm_insufficient_balance',
  'invalid_exact_evm_nonce_already_used',
  'invalid_exact_evm_signature',
]);

export function isPayerFault(reason: string | undefined): boolean {
  return reason !== undefined && PAYER_FAULT_REASONS.has(reason);
}

/**
 * Real x402: `exact` on Base USDC, priced per request from `priceOf`, settled by
 * the facilitator only after the handler answers 2xx (the middleware's order, as LADING).
 */
/** USDC on Base mainnet: the only asset the door is paid in. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/** A renter's channel can be withdrawn unilaterally this long after asking: PayAI's floor, and the door's claim timers run well inside it. */
export const WITHDRAW_DELAY_SECONDS = 3600;

export interface Schemes {
  server: x402ResourceServer;
  batch: BatchSettlementEvmScheme;
  facilitator: HTTPFacilitatorClient;
}

/**
 * The two schemes the door accepts: `batch-settlement` (a channel the renter deposits into once, then
 * signs cumulative vouchers against) and `exact` (one EIP-3009 authorization per tick). The batch
 * scheme keeps one JSON record per channel under `cfg.channelDir`; the claim key signs claims and refunds.
 */
export function buildSchemes(cfg: X402Config): Schemes {
  const facilitator = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const batch = new BatchSettlementEvmScheme(cfg.payTo as `0x${string}`, {
    storage: new FileChannelStorage({ directory: cfg.channelDir }),
    receiverAuthorizerSigner: claimSigner(cfg.claimKey),
    withdrawDelay: WITHDRAW_DELAY_SECONDS,
  });
  // Earlier facilitators take precedence per scheme. An exact facilitator that cannot be reached at boot lists
  // nothing, and exact falls back to the main facilitator.
  const clients = cfg.exactFacilitator ? [new ExactOnlyFacilitator(cfg.exactFacilitator), facilitator] : facilitator;
  const server = new x402ResourceServer(clients).register(cfg.network, batch).register(cfg.network, new ExactEvmScheme());
  return { server, batch, facilitator };
}

/**
 * Whether the facilitator lists `batch-settlement` on the network. A door that offers batch against a
 * facilitator that does not would fail every tick, exact included (the route cannot be built), so the
 * door asks at boot and offers batch only on a yes. Unreachable counts as no.
 */
export async function facilitatorOffersBatch(facilitatorUrl: string, network: string): Promise<boolean> {
  try {
    const kinds = (await new HTTPFacilitatorClient({ url: facilitatorUrl }).getSupported()).kinds;
    return kinds.some((k) => k.scheme === 'batch-settlement' && k.network === network);
  } catch {
    return false;
  }
}
