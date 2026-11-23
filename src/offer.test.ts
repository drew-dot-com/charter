import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Offer } from './types.js';
import { offerFromJson, offerToJson } from './offer.js';

const NOW = 1_800_000_000_000;

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 'offer-1',
    hostId: 'ab'.repeat(32),
    url: 'https://host.example',
    payTo: `0x${'3'.repeat(40)}`,
    cpu: 1,
    memoryMiB: 1024,
    intervalSeconds: 30,
    firstTickGraceSeconds: 90,
    tickPrice: 5000n,
    openPrice: 0n,
    statusPrice: 0n,
    images: ['alpine:3.20'],
    hiddenHost: true,
    hiddenEgress: false,
    expiresAt: NOW + 30 * 60 * 1000,
    ...over,
  };
}

/** The offer's JSON with fields replaced (or removed, as undefined). */
function json(over: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(offerToJson(offer())), ...over });
}

test('round trip deep-equals and the prices stay bigints', () => {
  const o = offer();
  const text = offerToJson(o);
  assert.equal(JSON.parse(text).tickPrice, '5000');
  const back = offerFromJson(text)!;
  assert.deepEqual(back, o);
  assert.equal(typeof back.tickPrice, 'bigint');
  assert.deepEqual(offerFromJson(offerToJson({ ...o, expiresAt: 0 })), { ...o, expiresAt: 0 }, 'a host offer may carry expiresAt 0');
});

test('the tick price must be above 0; an open or status price may be 0', () => {
  assert.equal(offerFromJson(json({ tickPrice: '0' })), null);
  assert.equal(offerFromJson(offerToJson(offer({ openPrice: 1000n, statusPrice: 100n })))!.openPrice, 1000n);
  for (const bad of ['-1', '1.5', 5, 'x']) {
    for (const field of ['tickPrice', 'openPrice', 'statusPrice']) assert.equal(offerFromJson(json({ [field]: bad })), null, `${field} ${bad}`);
  }
});

test('hostId is 64 lowercase hex, url an http(s) URL, payTo an address', () => {
  for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), undefined, 5]) assert.equal(offerFromJson(json({ hostId: bad })), null, String(bad));
  for (const bad of ['ftp://x', 'not a url', `https://${'a'.repeat(2048)}.example`, undefined]) assert.equal(offerFromJson(json({ url: bad })), null, String(bad));
  for (const bad of ['0x123', '3'.repeat(40), undefined]) assert.equal(offerFromJson(json({ payTo: bad })), null, String(bad));
});

test('cpu, memoryMiB, intervalSeconds and firstTickGraceSeconds must be positive safe integers', () => {
  for (const field of ['cpu', 'memoryMiB', 'intervalSeconds', 'firstTickGraceSeconds']) {
    for (const bad of [0, -1, 1.5, 2 ** 60, '1', null]) {
      assert.equal(offerFromJson(json({ [field]: bad })), null, `${field} = ${String(bad)}`);
    }
  }
});

test('missing fields, a bad expiresAt and junk all return null', () => {
  for (const field of ['id', 'images', 'hiddenHost', 'hiddenEgress', 'expiresAt']) assert.equal(offerFromJson(json({ [field]: undefined })), null, field);
  for (const bad of [-1, 1.5, 2 ** 60, '0']) assert.equal(offerFromJson(json({ expiresAt: bad })), null, String(bad));
  for (const text of ['not json', '[]', 'null', '5']) assert.equal(offerFromJson(text), null, text);
});

test('an offer carries its home terms; home.root only as true; home.free within 0..slots', () => {
  const o = offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 1, root: true } });
  assert.deepEqual(offerFromJson(offerToJson(o)), o);
  assert.equal(offerFromJson(offerToJson(offer()))!.home, undefined);
  const home = offerFromJson(offerToJson(offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2 } })))!.home!;
  assert.equal('free' in home, false);
  assert.equal('root' in home, false);
  for (const bad of [
    { diskGiB: 0, retentionDays: 7, slots: 1 },
    { diskGiB: 2, retentionDays: 7, slots: 2, root: false },
    { diskGiB: 2, retentionDays: 7, slots: 2, root: 'yes' },
    { diskGiB: 2, retentionDays: 7, slots: 2, free: -1 },
    { diskGiB: 2, retentionDays: 7, slots: 2, free: 0.5 },
    { diskGiB: 2, retentionDays: 7, slots: 2, free: 3 },
    [],
  ]) assert.equal(offerFromJson(json({ home: bad })), null, JSON.stringify(bad));
});
