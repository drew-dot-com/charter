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
  if (expiresAt <= now) return null;

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

  if (typeof c.ilpBase !== 'string' || typeof c.sealKey !== 'string') return null;
  if (typeof c.cpu !== 'number' || typeof c.memoryMiB !== 'number' || typeof c.intervalSeconds !== 'number') {
    return null;
  }
  if (!isStringArray(c.images)) return null;
  if (typeof c.hiddenHost !== 'boolean' || typeof c.hiddenEgress !== 'boolean') return null;

  return {
    id,
    hostPubkey: ev.pubkey,
    ilpBase: c.ilpBase,
    sealKey: c.sealKey,
    cpu: c.cpu,
    memoryMiB: c.memoryMiB,
    intervalSeconds: c.intervalSeconds,
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
