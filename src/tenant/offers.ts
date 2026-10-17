import { SimplePool } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import { latestOffers, OFFER_KIND, type SignedOfferEvent } from '../offer.js';
import type { Offer } from '../types.js';

export type QueryEvents = (relayUrl: string, filter: Filter) => Promise<SignedOfferEvent[]>;

const queryRelay: QueryEvents = async (relayUrl, filter) => {
  const pool = new SimplePool();
  try {
    return await pool.querySync([relayUrl], filter, { maxWait: 8000 });
  } finally {
    pool.close([relayUrl]);
  }
};

/** Live Charter offers on one relay, newest per (host, offer id). `now` is epoch ms. */
export async function fetchOffers(relayUrl: string, now: number, query: QueryEvents = queryRelay): Promise<Offer[]> {
  const events = await query(relayUrl, { kinds: [OFFER_KIND], '#L': ['charter'] });
  return latestOffers(events, now);
}
