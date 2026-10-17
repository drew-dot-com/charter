import type { Micro, Offer } from './types.js';

export const OFFER_KIND = 31390;

export interface UnsignedEvent {
  kind: number;
  tags: string[][];
  content: string;
}

export interface OfferEvent {
  pubkey: string;
  tags: string[][];
  content: string;
}

export interface SignedOfferEvent extends OfferEvent {
  /** Seconds. */
  created_at: number;
}

export function offerToEvent(o: Offer): UnsignedEvent {
  const { id, hostPubkey: _hostPubkey, expiresAt, ...rest } = o;
  const tags: string[][] = [
    ['d', id],
    ['L', 'charter'],
    ['expiration', String(Math.floor(expiresAt / 1000))],
  ];
  if (o.hiddenHost) tags.push(['t', 'hidden-host']);
  const content = JSON.stringify(rest, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return { kind: OFFER_KIND, tags, content };
}

function tagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

function parsePrice(v: unknown): Micro | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = BigInt(v);
  return n > 0n ? n : null;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** The 65-byte uncompressed secp256k1 point a connector seals to, as `0x04` and 128 hex digits. */
export function isSealKey(v: unknown): v is string {
  return typeof v === 'string' && /^0x04[0-9a-fA-F]{128}$/.test(v);
}

/** An http(s) URL, as `toon send --seal-to` takes. */
export function isSealUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 512) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** `now` is epoch ms. Returns null for anything that is not a live, well-formed Charter offer. */
export function offerFromEvent(ev: OfferEvent, now: number): Offer | null {
  if (!ev.tags.some((t) => t[0] === 'L' && t[1] === 'charter')) return null;
  const id = tagValue(ev.tags, 'd');
  if (!id) return null;
  const expSeconds = tagValue(ev.tags, 'expiration');
  if (expSeconds === undefined || !/^\d+$/.test(expSeconds)) return null;
  const expiresAt = Number(expSeconds) * 1000;
  // A number of digits past a safe integer would read as an offer that never expires.
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;

  let c: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(ev.content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    c = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const tickPrice = parsePrice(c.tickPrice);
  const openPrice = parsePrice(c.openPrice);
  const statusPrice = parsePrice(c.statusPrice);
  if (tickPrice === null || openPrice === null || statusPrice === null) return null;

  if (typeof c.ilpBase !== 'string' || !isSealKey(c.sealKey) || !isSealUrl(c.sealUrl)) return null;
  if (!isPositiveInt(c.cpu) || !isPositiveInt(c.memoryMiB) || !isPositiveInt(c.intervalSeconds) || !isPositiveInt(c.firstTickGraceSeconds)) {
    return null;
  }
  if (!isStringArray(c.images)) return null;
  if (typeof c.hiddenHost !== 'boolean' || typeof c.hiddenEgress !== 'boolean') return null;

  return {
    id,
    hostPubkey: ev.pubkey,
    ilpBase: c.ilpBase,
    sealKey: c.sealKey,
    sealUrl: c.sealUrl,
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
    expiresAt,
  };
}

/** Keeps the newest event per (pubkey, d), then drops any that are expired or malformed. `now` is epoch ms. */
export function latestOffers(events: SignedOfferEvent[], now: number): Offer[] {
  const newest = new Map<string, SignedOfferEvent>();
  for (const ev of events) {
    const d = tagValue(ev.tags, 'd');
    if (d === undefined) continue;
    const key = `${ev.pubkey}\u0000${d}`;
    const prev = newest.get(key);
    if (!prev || ev.created_at > prev.created_at) newest.set(key, ev);
  }
  const out: Offer[] = [];
  for (const ev of newest.values()) {
    const o = offerFromEvent(ev, now);
    if (o) out.push(o);
  }
  return out;
}
