import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Offer } from './types.js';
import { OFFER_KIND, offerFromEvent, offerToEvent, latestOffers } from './offer.js';

const NOW = 1_800_000_000_000;
const PUB = 'ab'.repeat(32);
const SEAL_KEY = '0x04' + 'cd'.repeat(64);

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-1',
    hostPubkey: PUB,
    ilpBase: 'g.drew.charter',
    sealKey: SEAL_KEY,
    sealUrl: 'http://ev2ocvzg.anyone/ilp',
    cpu: 1,
    memoryMiB: 1024,
    intervalSeconds: 30,
    firstTickGraceSeconds: 90,
    tickPrice: 5000n,
    openPrice: 1000n,
    statusPrice: 100n,
    images: ['alpine:3.20'],
    hiddenHost: true,
    hiddenEgress: false,
    expiresAt: NOW + 30 * 60 * 1000,
    ...over,
  };
}

function signed(o: Offer, created_at: number) {
  return { pubkey: o.hostPubkey, created_at, ...offerToEvent(o) };
}

test('offer kind is 31390', () => {
  assert.equal(OFFER_KIND, 31390);
});

test('offerToEvent writes the expected tags and bigint-free content', () => {
  const ev = offerToEvent(offer());
  assert.equal(ev.kind, 31390);
  assert.deepEqual(ev.tags, [
    ['d', 'offer-1'],
    ['L', 'charter'],
    ['expiration', String(Math.floor((NOW + 30 * 60 * 1000) / 1000))],
    ['t', 'hidden-host'],
  ]);
  const content = JSON.parse(ev.content);
  assert.equal(content.tickPrice, '5000');
  assert.equal('id' in content, false);
  assert.equal('hostPubkey' in content, false);
  assert.equal('expiresAt' in content, false);
});

test('no hidden-host tag when hiddenHost is false', () => {
  const ev = offerToEvent(offer({ hiddenHost: false }));
  assert.equal(ev.tags.some((t) => t[0] === 't'), false);
});

test('round trip deep-equals and tickPrice stays a bigint', () => {
  const o = offer();
  const back = offerFromEvent({ pubkey: PUB, ...offerToEvent(o) }, NOW);
  assert.deepEqual(back, o);
  assert.equal(typeof back?.tickPrice, 'bigint');
});

test('expired event returns null', () => {
  const o = offer({ expiresAt: NOW - 1000 });
  assert.equal(offerFromEvent({ pubkey: PUB, ...offerToEvent(o) }, NOW), null);
});

test('event missing the L tag returns null', () => {
  const ev = offerToEvent(offer());
  const tags = ev.tags.filter((t) => t[0] !== 'L');
  assert.equal(offerFromEvent({ pubkey: PUB, tags, content: ev.content }, NOW), null);
});

test('non-positive price returns null', () => {
  const ev = offerToEvent(offer());
  const content = JSON.stringify({ ...JSON.parse(ev.content), tickPrice: '0' });
  assert.equal(offerFromEvent({ pubkey: PUB, tags: ev.tags, content }, NOW), null);
});

test('missing field, junk price, bad JSON and missing d all return null', () => {
  const ev = offerToEvent(offer());
  const parsed = JSON.parse(ev.content);
  const { sealKey: _s, ...noSeal } = parsed;
  const cases = [
    { tags: ev.tags, content: JSON.stringify(noSeal) },
    { tags: ev.tags, content: JSON.stringify({ ...parsed, openPrice: 'abc' }) },
    { tags: ev.tags, content: JSON.stringify({ ...parsed, statusPrice: '-5' }) },
    { tags: ev.tags, content: '{not json' },
    { tags: ev.tags.filter((t) => t[0] !== 'd'), content: ev.content },
    { tags: ev.tags.filter((t) => t[0] !== 'expiration'), content: ev.content },
  ];
  for (const c of cases) assert.equal(offerFromEvent({ pubkey: PUB, ...c }, NOW), null);
});

test('latestOffers keeps only the newer event per (pubkey, d)', () => {
  const older = signed(offer({ cpu: 1 }), 100);
  const newer = signed(offer({ cpu: 2 }), 200);
  const out = latestOffers([newer, older], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.cpu, 2);
  assert.equal(latestOffers([older, newer], NOW)[0]?.cpu, 2);
});

test('latestOffers keeps different ids and different pubkeys apart', () => {
  const other = 'ef'.repeat(32);
  const out = latestOffers(
    [
      signed(offer({ id: 'a' }), 1),
      signed(offer({ id: 'b' }), 1),
      signed(offer({ id: 'a', hostPubkey: other }), 1),
    ],
    NOW,
  );
  assert.equal(out.length, 3);
});

test('latestOffers drops an offer whose newest event is expired', () => {
  const live = signed(offer(), 100);
  const dead = signed(offer({ expiresAt: NOW - 1 }), 200);
  assert.deepEqual(latestOffers([live, dead], NOW), []);
});

function content(over: Record<string, unknown>) {
  const ev = offerToEvent(offer());
  return { pubkey: PUB, tags: ev.tags, content: JSON.stringify({ ...JSON.parse(ev.content), ...over }) };
}

test('F-C1: cpu, memoryMiB, intervalSeconds and firstTickGraceSeconds must be positive safe integers', () => {
  for (const field of ['cpu', 'memoryMiB', 'intervalSeconds', 'firstTickGraceSeconds']) {
    for (const bad of [0, -1, 1.5, 2 ** 60, '1', null]) {
      assert.equal(offerFromEvent(content({ [field]: bad }), NOW), null, `${field} = ${String(bad)}`);
    }
  }
  assert.notEqual(offerFromEvent(content({ cpu: 2, memoryMiB: 2048, intervalSeconds: 60 }), NOW), null);
});

test('F-C1: an expiration tag beyond a safe integer is refused, not read as never expiring', () => {
  const ev = offerToEvent(offer());
  for (const exp of ['9'.repeat(30), String(Number.MAX_SAFE_INTEGER)]) {
    const tags = ev.tags.map((t) => (t[0] === 'expiration' ? ['expiration', exp] : t));
    assert.equal(offerFromEvent({ pubkey: PUB, tags, content: ev.content }, NOW), null, exp);
  }
});

test('F-C2: sealKey must be the 65-byte uncompressed hex key and sealUrl an http(s) URL', () => {
  for (const bad of ['http://x.anyone/ilp', '0x04' + 'cd'.repeat(63), '0x02' + 'cd'.repeat(64), 'cd'.repeat(65), '0x04' + 'zz'.repeat(64)]) {
    assert.equal(offerFromEvent(content({ sealKey: bad }), NOW), null, bad);
  }
  for (const bad of ['', 'ftp://x/ilp', 'not a url', 5]) {
    assert.equal(offerFromEvent(content({ sealUrl: bad }), NOW), null, String(bad));
  }
  const { sealUrl: _u, ...noUrl } = JSON.parse(offerToEvent(offer()).content);
  assert.equal(offerFromEvent({ pubkey: PUB, tags: offerToEvent(offer()).tags, content: JSON.stringify(noUrl) }, NOW), null);
  const back = offerFromEvent(content({}), NOW)!;
  assert.equal(back.sealKey, SEAL_KEY);
  assert.equal(back.sealUrl, 'http://ev2ocvzg.anyone/ilp');
  assert.equal(back.firstTickGraceSeconds, 90);
});
