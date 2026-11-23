import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offerToJson } from '../offer.js';
import type { Offer } from '../types.js';
import { fetchHostOffer, listedOffers, OFFER_KEEP_MS, OFFER_REFRESH_MS } from './host-offers.js';
import { HostRegistry, hostIdOf } from './hosts.js';

const URL_A = 'https://a.example';
const offerOf = (url: string, over: Partial<Offer> = {}): Offer => ({
  id: 'o1', hostId: hostIdOf(url), url, payTo: `0x${'3'.repeat(40)}`, cpu: 1, memoryMiB: 1024, intervalSeconds: 3600,
  firstTickGraceSeconds: 90, tickPrice: 7000n, openPrice: 0n, statusPrice: 0n, images: ['charter-job-fetch'],
  hiddenHost: false, hiddenEgress: false, expiresAt: 9_999_999_999_000, ...over,
});
const answer = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

test('fetchHostOffer reads GET {url}/v1/offer and takes only an offer that names this host and pays only ticks', async () => {
  const asked: string[] = [];
  const f = (async (u: string | URL | Request) => (asked.push(String(u)), new Response(offerToJson(offerOf(URL_A))))) as typeof fetch;
  assert.deepEqual(await fetchHostOffer(URL_A, f), offerOf(URL_A));
  assert.deepEqual(asked, [`${URL_A}/v1/offer`]);
  for (const bad of [
    offerToJson(offerOf(URL_A, { url: 'https://b.example' })),
    offerToJson(offerOf(URL_A, { hostId: hostIdOf('https://b.example') })),
    offerToJson(offerOf(URL_A, { openPrice: 1n })),
    offerToJson(offerOf(URL_A, { statusPrice: 1n })),
    'not json',
  ]) assert.equal(await fetchHostOffer(URL_A, answer(bad)), 'bad_offer', bad);
  assert.equal(await fetchHostOffer(URL_A, answer(offerToJson(offerOf(URL_A)), 500)), 'bad_offer');
});

test('listedOffers: listed hosts only, refetched at most every 60 s; a failing host keeps its offer 10 minutes, then is hidden until it answers', async () => {
  const reg = new HostRegistry(join(mkdtempSync(join(tmpdir(), 'hostoffers-')), 'hosts.json'));
  const clock = { t: 1_000_000 };
  const a = (reg.register(URL_A, clock.t) as { hostId: string }).hostId;
  reg.register('https://b.example', clock.t);
  reg.probeResult(a, true, clock.t);
  let up = true;
  const fetched: string[] = [];
  const offers = listedOffers({
    registry: reg,
    now: () => clock.t,
    fetchOffer: async (url) => {
      fetched.push(url);
      if (!up) throw new Error('down');
      return offerOf(url, { tickPrice: BigInt(clock.t) });
    },
  });
  assert.deepEqual((await offers()).map((o) => o.hostId), [a], 'b is not listed');
  clock.t += OFFER_REFRESH_MS - 1;
  await offers();
  assert.equal(fetched.length, 1, 'inside 60 s the offer is not fetched again');
  clock.t += 1;
  assert.equal((await offers())[0]!.tickPrice, BigInt(clock.t), 'refetched after 60 s');
  const lastGood = clock.t;
  up = false;
  clock.t = lastGood + OFFER_KEEP_MS - 1;
  assert.equal((await offers())[0]!.tickPrice, BigInt(lastGood), 'a failure keeps the last offer');
  clock.t = lastGood + OFFER_KEEP_MS;
  assert.deepEqual(await offers(), [], 'hidden after 10 minutes');
  up = true;
  assert.equal((await offers()).length, 1, 'back once it answers');
});
