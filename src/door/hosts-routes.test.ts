import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offerToJson } from '../offer.js';
import { OFFER } from '../tenant/test-host.js';
import type { Offer } from '../types.js';
import { fetchHostOffer, listedOffers } from './host-offers.js';
import { HOSTS_FILE, HostRegistry, hostIdOf } from './hosts.js';
import { DoorLedger } from './ledger.js';
import { SafeFetchError } from './safe-fetch.js';
import { doorApp, MAX_TICK_PRICE } from './server.js';

const HOUR = 3_600_000;

/** A host's offer at `url`, as its `GET /v1/offer` would answer it. */
const offerAt = (url: string, over: Partial<Offer> = {}): Offer => ({ ...OFFER, hostId: hostIdOf(url), url, ...over });

/**
 * A door with a real registry whose registrations fetch offers from `answers` (by host URL): an Offer, raw
 * text, or an Error to throw. Listed offers come from the registry as in production.
 */
async function door(answers: Map<string, Offer | string | Error>) {
  const dir = mkdtempSync(join(tmpdir(), 'hosts-routes-'));
  const clock = { t: 1_800_000_000_000 };
  const registry = new HostRegistry(join(dir, HOSTS_FILE));
  const hostFetch = (async (input: string | URL | Request) => {
    const href = String(input instanceof Request ? input.url : input);
    const a = answers.get(href.replace(/\/v1\/offer$/, ''));
    if (a instanceof Error) throw a;
    if (a === undefined) return new Response('nope', { status: 404 });
    return new Response(typeof a === 'string' ? a : offerToJson(a), { status: 200 });
  }) as typeof fetch;
  const server = doorApp({
    offers: listedOffers({ registry, fetchOffer: (url) => fetchHostOffer(url, hostFetch), now: () => clock.t }),
    api: () => {
      throw new Error('no host calls here');
    },
    registry,
    hostFetch,
    ledger: new DoorLedger(join(dir, 'ledger.json')),
    x402: 'free-for-tests',
    now: () => clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    registry, clock,
    close: () => void server.close(),
    register: async (url: unknown) => {
      const r = await fetch(`${base}/v1/hosts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    get: async (path: string) => (await fetch(base + path)).json() as Promise<unknown>,
  };
}

test('register then probe pass lists the host in /v1/offers with record.new true', async () => {
  const url = 'https://h1.example';
  const d = await door(new Map([[url, offerAt(url)]]));
  try {
    const r = await d.register('https://H1.example/');
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { hostId: hostIdOf(url), state: 'probing' });
    assert.deepEqual(await d.get('/v1/offers'), [], 'not listed before a probe passes');
    assert.deepEqual(await d.get('/v1/hosts'), [{
      hostId: hostIdOf(url), url, state: 'probing', record: { probesPassed: 0, leasesFinished: 0, successRate: 1, new: true },
    }]);

    d.registry.probeResult(hostIdOf(url), true, d.clock.t);
    d.clock.t += 61_000;
    const list = (await d.get('/v1/offers')) as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.offerId, `${hostIdOf(url)}:${OFFER.id}`);
    assert.equal(list[0]!.operator, 'independent');
    assert.deepEqual(list[0]!.record, { probesPassed: 1, leasesFinished: 0, successRate: 1, new: true });
    assert.equal(list[0]!.tickPrice, OFFER.tickPrice.toString());
    assert.equal(((await d.get('/v1/hosts')) as Array<{ state: string }>)[0]!.state, 'listed');
  } finally {
    d.close();
  }
});

test('bad_offer when openPrice is not 0, and for every other offer the door will not list', async () => {
  const at = (n: string) => `https://${n}.example`;
  const cases: Array<[string, Offer | string, string]> = [
    [at('open'), offerAt(at('open'), { openPrice: 1n }), 'open_price'],
    [at('status'), offerAt(at('status'), { statusPrice: 1n }), 'status_price'],
    [at('tick'), offerAt(at('tick'), { tickPrice: MAX_TICK_PRICE + 1n }), 'tick_price'],
    [at('payto'), offerToJson(offerAt(at('payto'))).replace(/"payTo":"0x3+"/, '"payTo":"0x123"'), 'pay_to'],
    [at('other'), offerAt(at('elsewhere')), 'url_mismatch'],
    [at('junk'), 'not json', 'unparseable'],
  ];
  const d = await door(new Map(cases.map(([u, a]) => [u, a])));
  try {
    for (const [u, , reason] of cases) {
      assert.deepEqual(await d.register(u), { status: 400, body: { error: 'bad_offer', reason } }, u);
      d.clock.t += HOUR;
    }
    assert.deepEqual(await d.register(at('missing')), { status: 400, body: { error: 'bad_offer', reason: 'status_404' } });
    assert.deepEqual(d.registry.all(), [], 'nothing refused is registered');
  } finally {
    d.close();
  }
});

test('bad_url for http://, and for a URL the door refuses to fetch', async () => {
  const inward = 'https://inward.example';
  const d = await door(new Map([[inward, new SafeFetchError('bad_url', 'resolves to 10.0.0.1')], ['https://down.example', new Error('ECONNREFUSED')]]));
  try {
    assert.deepEqual(await d.register('http://h1.example'), { status: 400, body: { error: 'bad_url' } });
    assert.deepEqual(await d.register('https://localhost'), { status: 400, body: { error: 'bad_url' } });
    assert.deepEqual(await d.register(42), { status: 400, body: { error: 'bad_url' } });
    assert.deepEqual(await d.register(inward), { status: 400, body: { error: 'bad_url' } });
    assert.deepEqual(await d.register('https://down.example'), { status: 400, body: { error: 'bad_offer', reason: 'unreachable' } });
    assert.deepEqual(d.registry.all(), []);
  } finally {
    d.close();
  }
});

test('429 on the second register of one URL inside an hour', async () => {
  const url = 'https://h1.example';
  const d = await door(new Map([[url, offerAt(url)]]));
  try {
    assert.equal((await d.register(url)).status, 202);
    assert.deepEqual(await d.register(`${url}/`), { status: 429, body: { error: 'rate_limited' } }, 'the same URL, normalized');
    d.clock.t += HOUR;
    assert.equal((await d.register(url)).status, 202);
  } finally {
    d.close();
  }
});

test('429 past 10 registrations an hour from one IP', async () => {
  const urls = Array.from({ length: 11 }, (_, i) => `https://h${i}.example`);
  const d = await door(new Map(urls.map((u) => [u, offerAt(u)])));
  try {
    for (const u of urls.slice(0, 10)) assert.equal((await d.register(u)).status, 202, u);
    assert.deepEqual(await d.register(urls[10]), { status: 429, body: { error: 'rate_limited' } });
    d.clock.t += HOUR;
    assert.equal((await d.register(urls[10])).status, 202);
  } finally {
    d.close();
  }
});

test('GET /v1/hosts leaves out a dropped host', async () => {
  const [a, b] = ['https://a.example', 'https://b.example'];
  const d = await door(new Map([[a, offerAt(a)], [b, offerAt(b)]]));
  try {
    await d.register(a);
    await d.register(b);
    for (let i = 0; i < 3; i++) d.registry.probeResult(hostIdOf(b), false, d.clock.t + i);
    const hosts = (await d.get('/v1/hosts')) as Array<{ hostId: string; record: Record<string, unknown> }>;
    assert.deepEqual(hosts.map((h) => h.hostId), [hostIdOf(a)]);
  } finally {
    d.close();
  }
});
