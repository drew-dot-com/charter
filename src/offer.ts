import type { Micro, Offer } from './types.js';

/** A host's offer as JSON (what `GET /v1/offer` answers): bigint prices as decimal strings. */
export function offerToJson(o: Offer): string {
  return JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** The longest host URL an offer may carry. */
const MAX_URL_CHARS = 2048;

/** An http(s) URL of sane length. The door checks a host's URL further against its registry. */
function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_URL_CHARS) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Decimal micro-USDC: at least 1, or at least 0 when `zeroOk`. */
function parsePrice(v: unknown, zeroOk = false): Micro | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = BigInt(v);
  return n > 0n || (zeroOk && n === 0n) ? n : null;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * An offer from its JSON, or null for anything that is not a well-formed Charter offer. `expiresAt` may be 0:
 * a host's own offer, as it hands it to a box, has none.
 */
export function offerFromJson(text: string): Offer | null {
  let c: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    c = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof c.id !== 'string' || !c.id) return null;
  if (typeof c.hostId !== 'string' || !/^[0-9a-f]{64}$/.test(c.hostId)) return null;
  if (!isHttpUrl(c.url)) return null;
  if (typeof c.payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.payTo)) return null;
  if (typeof c.expiresAt !== 'number' || !Number.isSafeInteger(c.expiresAt) || c.expiresAt < 0) return null;

  // Only ticks are paid: an open or a status read may be priced at 0.
  const tickPrice = parsePrice(c.tickPrice);
  const openPrice = parsePrice(c.openPrice, true);
  const statusPrice = parsePrice(c.statusPrice, true);
  if (tickPrice === null || openPrice === null || statusPrice === null) return null;

  if (!isPositiveInt(c.cpu) || !isPositiveInt(c.memoryMiB) || !isPositiveInt(c.intervalSeconds) || !isPositiveInt(c.firstTickGraceSeconds)) {
    return null;
  }
  if (!isStringArray(c.images)) return null;
  if (typeof c.hiddenHost !== 'boolean' || typeof c.hiddenEgress !== 'boolean') return null;

  let home: Offer['home'];
  if (c.home !== undefined) {
    const h = c.home as Record<string, unknown> | null;
    if (typeof h !== 'object' || h === null || Array.isArray(h)) return null;
    if (!isPositiveInt(h.diskGiB) || !isPositiveInt(h.retentionDays) || !isPositiveInt(h.slots)) return null;
    home = { diskGiB: h.diskGiB, retentionDays: h.retentionDays, slots: h.slots };
    if (h.root !== undefined) {
      if (h.root !== true) return null;
      home.root = true;
    }
    if (h.free !== undefined) {
      if (typeof h.free !== 'number' || !Number.isInteger(h.free) || h.free < 0 || h.free > h.slots) return null;
      home.free = h.free;
    }
  }

  return {
    id: c.id,
    hostId: c.hostId,
    url: c.url,
    payTo: c.payTo as `0x${string}`,
    cpu: c.cpu,
    memoryMiB: c.memoryMiB,
    intervalSeconds: c.intervalSeconds,
    firstTickGraceSeconds: c.firstTickGraceSeconds,
    tickPrice,
    openPrice,
    statusPrice,
    images: c.images,
    hiddenHost: c.hiddenHost,
    hiddenEgress: c.hiddenEgress,
    expiresAt: c.expiresAt,
    ...(home ? { home } : {}),
  };
}
