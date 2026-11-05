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
  assert.equal(c.offer.intervalSeconds, 3600);
  assert.equal(c.offer.tickPrice, 7000n);
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
  assert.equal(c.runtime, undefined);
});

test('loadConfig reads CHARTER_RUNTIME and refuses anything that is not a runtime name', () => {
  assert.equal(loadConfig({ ...ENV, CHARTER_RUNTIME: 'runsc' }).runtime, 'runsc');
  assert.throws(() => loadConfig({ ...ENV, CHARTER_RUNTIME: 'runsc --privileged' }), /CHARTER_RUNTIME/);
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

const HOME_ENV = {
  ...ENV,
  CHARTER_ALLOW_IMAGES: 'charter-job-fetch,charter-home',
  CHARTER_MAX_LEASES: '2',
  CHARTER_MAX_HOMES: '1',
  CHARTER_ANON_HS_DIR: '/etc/anon/hs.d',
  CHARTER_ANON_PIDFILE: '/run/anon/anon.pid',
  CHARTER_TENANT_CONNECTOR_URL: 'https://connector.mainnet.toonprotocol.dev',
};

test('a host with homes needs the anon paths and a tenant connector URL and advertises its terms', () => {
  const c = loadConfig(HOME_ENV);
  assert.equal(c.maxHomes, 1);
  assert.deepEqual(c.offer.home, { diskGiB: 2, retentionDays: 7, slots: 1 });
  assert.deepEqual(c.home, {
    dir: '/var/charter/homes',
    network: 'charter-home',
    gateway: '172.19.0.1',
    socksPort: 9050,
    httpPort: 9080,
    anonHsDir: '/etc/anon/hs.d',
    anonPidFile: '/run/anon/anon.pid',
    tenantConnectorUrl: 'https://connector.mainnet.toonprotocol.dev',
  });
  for (const k of ['CHARTER_ANON_HS_DIR', 'CHARTER_ANON_PIDFILE', 'CHARTER_TENANT_CONNECTOR_URL']) {
    assert.throws(() => loadConfig({ ...HOME_ENV, [k]: '' }), new RegExp(k));
  }
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_TENANT_CONNECTOR_URL: 'ftp://x' }), /CHARTER_TENANT_CONNECTOR_URL/);
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_HOME_GATEWAY: 'gw.local' }), /CHARTER_HOME_GATEWAY/);
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_HOME_SOCKS_PORT: '0' }), /CHARTER_HOME_SOCKS_PORT/);
  assert.equal(loadConfig({ ...HOME_ENV, CHARTER_HOME_DIR: '/mnt/h' }).home?.dir, '/mnt/h');
});

test('a host without home slots has no home and no home terms', () => {
  const c = loadConfig(ENV);
  assert.equal(c.maxHomes, 0);
  assert.equal(c.home, undefined);
  assert.equal(c.offer.home, undefined);
});

test('the home image without a home slot is a configuration error', () => {
  assert.throws(
    () => loadConfig({ ...ENV, CHARTER_ALLOW_IMAGES: 'charter-job-fetch,charter-home' }),
    /CHARTER_MAX_HOMES/,
  );
});

test('charter-hermes alone also needs CHARTER_MAX_HOMES', () => {
  assert.throws(() => loadConfig({ ...ENV, CHARTER_ALLOW_IMAGES: 'charter-job-fetch,charter-hermes' }), /CHARTER_MAX_HOMES/);
  const c = loadConfig({ ...HOME_ENV, CHARTER_ALLOW_IMAGES: 'charter-home,charter-hermes' });
  assert.deepEqual(c.offer.images, ['charter-home', 'charter-hermes']);
});

test('more home slots than lease slots is an error', () => {
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_MAX_LEASES: '1', CHARTER_MAX_HOMES: '2' }), /CHARTER_MAX_HOMES/);
});

test('loadConfig reads CHARTER_HOST_PUBKEY into the offer and refuses one that is not 64 hex', () => {
  assert.equal(loadConfig(ENV).offer.hostPubkey, '');
  const pk = 'ab'.repeat(32);
  assert.equal(loadConfig({ ...ENV, CHARTER_HOST_PUBKEY: ` ${pk} ` }).offer.hostPubkey, pk);
  for (const bad of ['ab'.repeat(31), 'AB'.repeat(32), 'zz'.repeat(32), 'npub1xyz']) {
    assert.throws(() => loadConfig({ ...ENV, CHARTER_HOST_PUBKEY: bad }), /CHARTER_HOST_PUBKEY/);
  }
});
