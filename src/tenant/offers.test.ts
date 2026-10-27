// fetchOffers on a stubbed relay query, and findOfferExact. No relay, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFER_KIND, offerToEvent, type SignedOfferEvent } from '../offer.js';
import type { Offer } from '../types.js';
import { fetchOffers, findOfferExact, type QueryEvents } from './offers.js';
import { OFFER } from './test-host.js';

const NOW = 1_800_000_000_000;
const OTHER_HOST = 'ef'.repeat(32);

function offer(over: Partial<Offer> = {}): Offer {
  return { ...OFFER, expiresAt: NOW + 10 * 60_000, ...over };
}

function signed(o: Offer, created_at: number): SignedOfferEvent {
  return { pubkey: o.hostPubkey, created_at, ...offerToEvent(o) };
}

/** A relay that answers `events` to any query, recording what it was asked. */
function relay(events: SignedOfferEvent[] | Error) {
  const asked: Array<{ relayUrl: string; filter: Parameters<QueryEvents>[1] }> = [];
  const query: QueryEvents = async (relayUrl, filter) => {
    asked.push({ relayUrl, filter });
    if (events instanceof Error) throw events;
    return events;
  };
  return { query, asked };
}

test('fetchOffers asks the relay for kind 31390 events labelled charter and returns the live offers', async () => {
  const r = relay([signed(offer(), 100)]);
  const out = await fetchOffers('wss://relay.example', NOW, r.query);
  assert.deepEqual(out, [offer()]);
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0]!.relayUrl, 'wss://relay.example');
  assert.deepEqual(r.asked[0]!.filter, { kinds: [OFFER_KIND], '#L': ['charter'] });
});

test('fetchOffers keeps the newest event per (host, id), drops expired and malformed ones', async () => {
  const older = signed(offer({ cpu: 1 }), 100);
  const newer = signed(offer({ cpu: 4 }), 200);
  const expired = signed(offer({ id: 'old', expiresAt: NOW - 1 }), 300);
  const other = signed(offer({ id: 'o1', hostPubkey: OTHER_HOST, cpu: 2 }), 50);
  const junk: SignedOfferEvent = { pubkey: OTHER_HOST, created_at: 400, tags: [['d', 'junk'], ['L', 'charter']], content: '{not json' };
  const out = await fetchOffers('wss://relay.example', NOW, relay([older, junk, expired, newer, other]).query);
  assert.equal(out.length, 2);
  assert.deepEqual(new Set(out.map((o) => `${o.hostPubkey}:${o.id}:${o.cpu}`)), new Set([`${OFFER.hostPubkey}:o1:4`, `${OTHER_HOST}:o1:2`]));
});

test('fetchOffers with no events is an empty list; a relay failure is thrown, not swallowed', async () => {
  assert.deepEqual(await fetchOffers('wss://relay.example', NOW, relay([]).query), []);
  await assert.rejects(fetchOffers('wss://relay.example', NOW, relay(new Error('relay down')).query), /relay down/);
});

test('findOfferExact matches only <64-hex pubkey>:<id>, never a bare id, a prefix or another host', () => {
  const mine = offer();
  const theirs = offer({ hostPubkey: OTHER_HOST });
  const list = [mine, theirs];
  assert.equal(findOfferExact(list, `${OFFER.hostPubkey}:${OFFER.id}`), mine);
  assert.equal(findOfferExact(list, `${OTHER_HOST}:${OFFER.id}`), theirs);
  for (const ref of [OFFER.id, `${OFFER.hostPubkey}:`, `${OFFER.hostPubkey}:${OFFER.id}x`, `${OFFER.hostPubkey.slice(1)}:${OFFER.id}`, `${OFFER.hostPubkey.toUpperCase()}:${OFFER.id}`, `${'0'.repeat(64)}:${OFFER.id}`, ':', '']) {
    assert.equal(findOfferExact(list, ref), undefined, ref);
  }
  // An id with a colon in it is matched whole.
  const colon = offer({ id: 'a:b' });
  assert.equal(findOfferExact([colon], `${OFFER.hostPubkey}:a:b`), colon);
  assert.equal(findOfferExact([], `${OFFER.hostPubkey}:${OFFER.id}`), undefined);
});
