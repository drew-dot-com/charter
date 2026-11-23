// The offers the door lists: each listed host's own `GET /v1/offer`, kept fresh.
import { offerFromJson } from '../offer.js';
import type { Offer } from '../types.js';
import { hostIdOf, normalizeHostUrl, type HostRegistry } from './hosts.js';

/** A listed host's offer is fetched again once it is this old. */
export const OFFER_REFRESH_MS = 60_000;
/** A host whose offer cannot be fetched keeps its last one this long after it was fetched, then is not listed. */
export const OFFER_KEEP_MS = 10 * 60_000;

/**
 * A host's offer from `GET {url}/v1/offer`, where `url` is the host's normalized URL. 'bad_offer' for a
 * non-200 answer, one that does not parse, one that names another host (its `url` or `hostId`), and one that
 * prices an open or a status read: the door pays ticks only. Throws when the fetch does.
 */
export async function fetchHostOffer(url: string, f: typeof fetch): Promise<Offer | 'bad_offer'> {
  const res = await f(`${url}/v1/offer`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (res.status !== 200) return 'bad_offer';
  const o = offerFromJson(text);
  if (!o || normalizeHostUrl(o.url) !== url || o.hostId !== hostIdOf(url)) return 'bad_offer';
  if (o.openPrice !== 0n || o.statusPrice !== 0n) return 'bad_offer';
  return o;
}

/**
 * The door's `offers()`: the offer of every listed host, fetched again once it is OFFER_REFRESH_MS old. A host
 * that fails to answer (or answers a bad offer) keeps its last offer until that is OFFER_KEEP_MS old, and is
 * left out after that until it answers again.
 */
export function listedOffers(d: {
  registry: HostRegistry;
  fetchOffer: (url: string) => Promise<Offer | 'bad_offer'>;
  now: () => number;
}): () => Promise<Offer[]> {
  return async () => {
    const offers = await Promise.all(
      d.registry.listed().map(async (r): Promise<Offer | undefined> => {
        const age = r.offer && r.offerFetchedAt !== undefined ? d.now() - r.offerFetchedAt : Infinity;
        if (age < OFFER_REFRESH_MS) return r.offer;
        let o: Offer | 'bad_offer';
        try {
          o = await d.fetchOffer(r.url);
        } catch {
          o = 'bad_offer';
        }
        if (o !== 'bad_offer') {
          d.registry.setOffer(r.hostId, o, d.now());
          return o;
        }
        return age < OFFER_KEEP_MS ? r.offer : undefined;
      }),
    );
    return offers.filter((o): o is Offer => o !== undefined);
  };
}
