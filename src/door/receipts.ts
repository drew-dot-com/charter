import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyMessage } from 'viem';

/**
 * A receipt is a short statement the door signs about a lease: the SHA-256 of a job's output (`job`), or a hash
 * the holder of a home lease declared (`declared`). The door signs `RECEIPT_PREFIX` and the receipt as one line of
 * JSON, as an EIP-191 personal message: an x402 `exact` payment is EIP-712 typed data, so a receipt signature can
 * never be one. Every field is hex, an integer, a CID shape or one of two words: the door never signs free text.
 */
export const RECEIPT_PREFIX = 'Charter receipt v1\n';

export type ReceiptKind = 'job' | 'declared';

export interface Receipt {
  v: 1;
  kind: ReceiptKind;
  /** The door's public URL. */
  door: string;
  /** leaseRefOf the lease id. The id itself reads the lease, so it is never in a receipt. */
  leaseRef: string;
  hostId: string;
  /** The job's image. Left out for a lease opened before the ledger kept it. */
  image?: string;
  /** Ticks the renter's payments settled, at signing time. */
  ticksPaid: number;
  /** How long one tick buys on this lease's host. */
  intervalSeconds: number;
  /** The lease's payer, lower case, when it is the renter's own wallet. */
  payer?: string;
  /** job: of the whole output, the decoded parts joined in order. declared: as the caller gave it. */
  sha256: string;
  bytes?: number;
  /** declared only, as the caller gave it. The door never fetches or checks it. */
  cid?: string;
  /** Epoch ms the door signed. */
  at: number;
}

export interface SignedReceipt {
  receipt: Receipt;
  message: string;
  signer: `0x${string}`;
  signature: `0x${string}`;
}

export interface ReceiptSigner {
  address: `0x${string}`;
  signMessage(a: { message: string }): Promise<`0x${string}`>;
}

/** What a receipt names a lease by: only someone who holds the lease id can show the two match. */
export function leaseRefOf(leaseId: string): string {
  return createHash('sha256').update(`charter-lease:${leaseId}`).digest('hex');
}

/** The receipt with its keys in the one signed order, undefined optionals left out. */
export function buildReceipt(f: Omit<Receipt, 'v'>): Receipt {
  return {
    v: 1,
    kind: f.kind,
    door: f.door,
    leaseRef: f.leaseRef,
    hostId: f.hostId,
    ...(f.image !== undefined ? { image: f.image } : {}),
    ticksPaid: f.ticksPaid,
    intervalSeconds: f.intervalSeconds,
    ...(f.payer !== undefined ? { payer: f.payer } : {}),
    sha256: f.sha256,
    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
    ...(f.cid !== undefined ? { cid: f.cid } : {}),
    at: f.at,
  };
}

export function messageOf(r: Receipt): string {
  return RECEIPT_PREFIX + JSON.stringify(r);
}

export async function signReceipt(r: Receipt, s: ReceiptSigner): Promise<SignedReceipt> {
  const message = messageOf(r);
  return { receipt: r, message, signer: s.address, signature: await s.signMessage({ message }) };
}

/** True only when `signature` is `signer`'s over `message`, the message has the prefix, and its JSON is `receipt`. */
export async function verifyReceipt(s: SignedReceipt): Promise<boolean> {
  try {
    if (typeof s.message !== 'string' || !s.message.startsWith(RECEIPT_PREFIX)) return false;
    if (!isDeepStrictEqual(JSON.parse(s.message.slice(RECEIPT_PREFIX.length)), s.receipt)) return false;
    return await verifyMessage({ address: s.signer, message: s.message, signature: s.signature });
  } catch {
    return false;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{50,120}$/;

/** CIDv0 (`Qm` and 44 base58 characters) or CIDv1 in base32 (`b` and 50 to 120 of a-z, 2-7). */
export function isCid(v: unknown): v is string {
  return typeof v === 'string' && (CID_V0.test(v) || CID_V1.test(v));
}

/** A declared receipt's request body, or null: `sha256` (64 lower hex), and optionally `cid` and `bytes`. No other key. */
export function declaredBody(v: unknown): { sha256: string; cid?: string; bytes?: number } | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { sha256, cid, bytes, ...rest } = v as { sha256?: unknown; cid?: unknown; bytes?: unknown };
  if (Object.keys(rest).length > 0) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  if (cid !== undefined && !isCid(cid)) return null;
  if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0)) return null;
  return { sha256, ...(cid !== undefined ? { cid } : {}), ...(bytes !== undefined ? { bytes } : {}) };
}
