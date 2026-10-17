import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const KEY = '0x04' + '69'.repeat(64);

const ENV = {
  CHARTER_DATA_DIR: '/var/charter',
  CHARTER_ALLOW_IMAGES: 'charter-job-fetch',
  CHARTER_RELAY_URL: 'wss://relay.example',
  TOON_PASSPHRASE_FILE: '/etc/charter/pass',
  CHARTER_OFFER_ID: 'o1',
  CHARTER_ILP_BASE: 'g.toon.abc',
  CHARTER_SEAL_KEY: KEY,
  CHARTER_SEAL_URL: 'http://abc.anyone/ilp',
};

test('loadConfig applies the v1 defaults', () => {
  const c = loadConfig(ENV);
  assert.deepEqual(c.ports, { open: 7401, tick: 7402, status: 7403 });
  assert.equal(c.offer.intervalSeconds, 30);
  assert.equal(c.offer.tickPrice, 5000n);
  assert.equal(c.offer.openPrice, 1000n);
  assert.equal(c.offer.statusPrice, 100n);
  assert.equal(c.offer.hiddenHost, false);
  assert.equal(c.offer.hiddenEgress, false);
  assert.equal(c.offer.sealKey, KEY);
  assert.equal(c.offer.sealUrl, 'http://abc.anyone/ilp');
  assert.equal(c.offer.firstTickGraceSeconds, 90);
  assert.equal(c.maxLeases, 1);
  assert.deepEqual(c.offer.images, ['charter-job-fetch']);
});

test('loadConfig reads overrides, the proxy and the hidden host flag', () => {
  const c = loadConfig({
    ...ENV, CHARTER_PORTS: '1,2,3', CHARTER_PROXY: 'socks5h://127.0.0.1:9050', CHARTER_HIDDEN_HOST: 'true',
    CHARTER_TICK_PRICE: '7000', CHARTER_ALLOW_IMAGES: 'a, b', CHARTER_MAX_LEASES: '3',
  });
  assert.equal(c.maxLeases, 3);
  assert.deepEqual(c.ports, { open: 1, tick: 2, status: 3 });
  assert.equal(c.proxy, 'socks5h://127.0.0.1:9050');
  assert.equal(c.offer.hiddenEgress, true);
  assert.equal(c.offer.hiddenHost, true);
  assert.equal(c.offer.tickPrice, 7000n);
  assert.deepEqual(c.allowImages, ['a', 'b']);
});

test('loadConfig names what is missing or malformed', () => {
  assert.throws(() => loadConfig({ ...ENV, CHARTER_SEAL_KEY: '' }), /CHARTER_SEAL_KEY/);
  // F-C2: the key is the connector's hex public key, the URL is separate.
  assert.throws(() => loadConfig({ ...ENV, CHARTER_SEAL_KEY: 'http://abc.anyone/ilp' }), /CHARTER_SEAL_KEY/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_SEAL_URL: undefined }), /CHARTER_SEAL_URL/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_SEAL_URL: 'ftp://x/ilp' }), /CHARTER_SEAL_URL/);
  // F-I2: the concurrency cap is a positive integer.
  assert.throws(() => loadConfig({ ...ENV, CHARTER_MAX_LEASES: '0' }), /CHARTER_MAX_LEASES/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_PORTS: '1,1,2' }), /CHARTER_PORTS/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_TICK_PRICE: '-5' }), /CHARTER_TICK_PRICE/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_INTERVAL_SECONDS: '0' }), /CHARTER_INTERVAL_SECONDS/);
});
