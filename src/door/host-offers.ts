// The offers the door lists: each listed host's own `GET /v1/offer`, kept fresh.
import { offerFromJson } from '../offer.js';
import type { Offer } from '../types.js';
import { hostIdOf, normalizeHostUrl, type HostRegistry } from './hosts.js';

/** A listed host's offer is fetched again once it is this old. */
export const OFFER_REFRESH_MS = 60_000;
/** A host whose offer cannot be fetched keeps its last one this long after it was fetched, then is not listed. */
export const OFFER_KEEP_MS = 10 * 60_000;

/** Why the door refuses a host's offer. */
export type OfferRefusal = `status_${number}` | 'pay_to' | 'unparseable' | 'url_mismatch' | 'open_price' | 'status_price';

/**
 * A host's offer from `GET {url}/v1/offer`, where `url` is the host's normalized URL, or why it is refused: a
 * non-200 answer, a payTo that is not an address, one that does not parse, one that names another host (its
 * `url` or `hostId`), one that prices an open or a status read (the door pays ticks only). Throws when the fetch does.
 */
export async function checkHostOffer(url: string, f: typeof fetch): Promise<Offer | { refused: OfferRefusal }> {
  const res = await f(`${url}/v1/offer`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (res.status !== 200) return { refused: `status_${res.status}` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { refused: 'unparseable' };
  }
  const payTo = (raw as { payTo?: unknown } | null)?.payTo;
  if (typeof payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) return { refused: 'pay_to' };
  const o = offerFromJson(text);
  if (!o) return { refused: 'unparseable' };
  if (normalizeHostUrl(o.url) !== url || o.hostId !== hostIdOf(url)) return { refused: 'url_mismatch' };
  if (o.openPrice !== 0n) return { refused: 'open_price' };
  if (o.statusPrice !== 0n) return { refused: 'status_price' };
  return o;
}

/** checkHostOffer, with every refusal as 'bad_offer'. */
export async function fetchHostOffer(url: string, f: typeof fetch): Promise<Offer | 'bad_offer'> {
  const o = await checkHostOffer(url, f);
  return 'refused' in o ? 'bad_offer' : o;
}

/**
 * The door's `offers()`: the offer of every listed host, fetched again once it is OFFER_REFRESH_MS old. A host
 * that fails to answer (or answers a bad offer) is not tried again for OFFER_REFRESH_MS, so a dark host does not
 * slow every call; it keeps its last offer until that is OFFER_KEEP_MS old, and is left out after that until it
 * answers again.
 */
export function listedOffers(d: {
  registry: HostRegistry;
  fetchOffer: (url: string) => Promise<Offer | 'bad_offer'>;
  now: () => number;
}): () => Promise<Offer[]> {
  /** When each host's last fetch failed (epoch ms). */
  const failedAt = new Map<string, number>();
  return async () => {
    const offers = await Promise.all(
      d.registry.listed().map(async (r): Promise<Offer | undefined> => {
        const age = r.offer && r.offerFetchedAt !== undefined ? d.now() - r.offerFetchedAt : Infinity;
        const kept = age < OFFER_KEEP_MS ? r.offer : undefined;
        if (age < OFFER_REFRESH_MS) return r.offer;
        const failed = failedAt.get(r.hostId);
        if (failed !== undefined && d.now() - failed < OFFER_REFRESH_MS) return kept;
        let o: Offer | 'bad_offer';
        try {
          o = await d.fetchOffer(r.url);
        } catch {
          o = 'bad_offer';
        }
        if (o !== 'bad_offer') {
          failedAt.delete(r.hostId);
          d.registry.setOffer(r.hostId, o, d.now());
          return o;
        }
        failedAt.set(r.hostId, d.now());
        return kept;
      }),
    );
    return offers.filter((o): o is Offer => o !== undefined);
  };
}
