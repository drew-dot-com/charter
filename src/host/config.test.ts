import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostIdOf } from '../door/hosts.js';
import { DEFAULT_DOOR_URL, loadConfig } from './config.js';

const PAY_TO = '0x' + '3'.repeat(40);

const ENV = {
  CHARTER_DATA_DIR: '/var/charter',
  CHARTER_ALLOW_IMAGES: 'charter-job-fetch',
  CHARTER_OFFER_ID: 'o1',
  CHARTER_HOST_URL: 'https://Host.Example/',
  CHARTER_HOST_PAY_TO: PAY_TO,
  CHARTER_CLAIM_KEY_FILE: '/etc/charter/claim.key',
};

test('loadConfig applies the v1 defaults', () => {
  const c = loadConfig(ENV);
  assert.equal(c.hostUrl, 'https://host.example');
  assert.equal(c.payTo, PAY_TO);
  assert.equal(c.port, 7401);
  assert.equal(c.doorUrl, DEFAULT_DOOR_URL);
  assert.equal(c.claimKeyFile, '/etc/charter/claim.key');
  assert.equal(c.facilitatorUrl, 'https://facilitator.payai.network');
  assert.equal(c.offer.hostId, hostIdOf('https://host.example'));
  assert.equal(c.offer.url, 'https://host.example');
  assert.equal(c.offer.payTo, PAY_TO);
  assert.equal(c.offer.intervalSeconds, 3600);
  assert.equal(c.offer.tickPrice, 7000n);
  assert.equal(c.offer.openPrice, 0n, 'the door pays ticks only');
  assert.equal(c.offer.statusPrice, 0n);
  assert.equal(c.offer.hiddenHost, false);
  assert.equal(c.offer.hiddenEgress, false);
  assert.equal(c.offer.firstTickGraceSeconds, 90);
  assert.equal(c.maxLeases, 1);
  assert.deepEqual(c.offer.images, ['charter-job-fetch']);
});

test('loadConfig reads overrides, the proxy and the hidden host flag', () => {
  const c = loadConfig({
    ...ENV, CHARTER_HOST_PORT: '7500', CHARTER_DOOR_URL: 'https://door.example/', X402_FACILITATOR_URL: 'https://f.example', CHARTER_PROXY: 'socks5h://127.0.0.1:9050', CHARTER_HIDDEN_HOST: 'true',
    CHARTER_TICK_PRICE: '7000', CHARTER_ALLOW_IMAGES: 'a, b', CHARTER_MAX_LEASES: '3',
  });
  assert.equal(c.maxLeases, 3);
  assert.equal(c.port, 7500);
  assert.equal(c.doorUrl, 'https://door.example');
  assert.equal(c.facilitatorUrl, 'https://f.example');
  assert.equal(c.proxy, 'socks5h://127.0.0.1:9050');
  assert.equal(c.offer.hiddenEgress, true);
  assert.equal(c.offer.hiddenHost, true);
  assert.equal(c.offer.tickPrice, 7000n);
  assert.deepEqual(c.allowImages, ['a', 'b']);
  assert.equal(c.runtime, undefined);
});

test('loadConfig reads CHARTER_JOB_DNS, needs CHARTER_PROXY beside it, and refuses anything but a dotted IPv4 address', () => {
  assert.equal(loadConfig(ENV).jobDns, undefined);
  assert.equal(loadConfig({ ...ENV, CHARTER_PROXY: 'socks5://172.17.0.1:9150', CHARTER_JOB_DNS: '172.17.0.1' }).jobDns, '172.17.0.1');
  assert.throws(() => loadConfig({ ...ENV, CHARTER_PROXY: 'socks5://172.17.0.1:9150', CHARTER_JOB_DNS: 'dns.example' }), /CHARTER_JOB_DNS/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_PROXY: 'socks5://172.17.0.1:9150', CHARTER_JOB_DNS: '172.17.0.1 --privileged' }), /CHARTER_JOB_DNS/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_PROXY: '', CHARTER_JOB_DNS: '172.17.0.1' }), /CHARTER_JOB_DNS/);
});

test('loadConfig reads CHARTER_RUNTIME and refuses anything that is not a runtime name', () => {
  assert.equal(loadConfig({ ...ENV, CHARTER_RUNTIME: 'runsc' }).runtime, 'runsc');
  assert.throws(() => loadConfig({ ...ENV, CHARTER_RUNTIME: 'runsc --privileged' }), /CHARTER_RUNTIME/);
});

test('loadConfig names what is missing or malformed', () => {
  for (const k of ['CHARTER_HOST_URL', 'CHARTER_HOST_PAY_TO', 'CHARTER_CLAIM_KEY_FILE']) {
    assert.throws(() => loadConfig({ ...ENV, [k]: '' }), new RegExp(k));
  }
  for (const bad of ['http://host.example', 'https://localhost', 'https://127.0.0.1', 'https://host.example/?a=1']) {
    assert.throws(() => loadConfig({ ...ENV, CHARTER_HOST_URL: bad }), /CHARTER_HOST_URL/, bad);
  }
  assert.throws(() => loadConfig({ ...ENV, CHARTER_HOST_PAY_TO: '0x123' }), /CHARTER_HOST_PAY_TO/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_DOOR_URL: 'http://door.example' }), /CHARTER_DOOR_URL/);
  assert.throws(() => loadConfig({ ...ENV, CHARTER_HOST_PORT: '70000' }), /CHARTER_HOST_PORT/);
  // F-I2: the concurrency cap is a positive integer.
  assert.throws(() => loadConfig({ ...ENV, CHARTER_MAX_LEASES: '0' }), /CHARTER_MAX_LEASES/);
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
    diskGib: 2,
    root: false,
    onion: true,
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

test('CHARTER_HOME_PUBLIC_HOST sets home.publicHost and turns the onion off by default', () => {
  const c = loadConfig({ ...HOME_ENV, CHARTER_HOME_PUBLIC_HOST: '37.27.86.235', CHARTER_ANON_HS_DIR: '', CHARTER_ANON_PIDFILE: '' });
  assert.equal(c.home?.publicHost, '37.27.86.235');
  assert.equal(c.home?.onion, false);
});

test('CHARTER_HOME_ONION=1 with a public host keeps the onion and needs the anon paths', () => {
  assert.throws(
    () => loadConfig({ ...HOME_ENV, CHARTER_HOME_PUBLIC_HOST: '37.27.86.235', CHARTER_HOME_ONION: '1', CHARTER_ANON_HS_DIR: '' }),
    /CHARTER_ANON_HS_DIR/,
  );
  const c = loadConfig({ ...HOME_ENV, CHARTER_HOME_PUBLIC_HOST: '37.27.86.235', CHARTER_HOME_ONION: '1' });
  assert.equal(c.home?.onion, true);
});

test('no public host: onion on and anon paths required, as today', () => {
  const c = loadConfig(HOME_ENV);
  assert.equal(c.home?.publicHost, undefined);
  assert.equal(c.home?.onion, true);
});

test('CHARTER_HOME_PUBLIC_HOST must be a dotted IPv4 address', () => {
  for (const bad of ['http://37.27.86.235', '37.27.86.235:22', 'a b', '999.1.1.1', '1.2.3', '1.2.3.4.5']) {
    assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_HOME_PUBLIC_HOST: bad }), /CHARTER_HOME_PUBLIC_HOST/, bad);
  }
  assert.throws(
    () => loadConfig({ ...HOME_ENV, CHARTER_HOME_PUBLIC_HOST: 'box.example.com' }),
    /CHARTER_HOME_PUBLIC_HOST must be a dotted IPv4 address/,
    'a hostname is refused: docker -p binds only an IP',
  );
  assert.equal(loadConfig({ ...HOME_ENV, CHARTER_HOME_PUBLIC_HOST: '10.0.0.255' }).home?.publicHost, '10.0.0.255');
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

test('CHARTER_HOME_DISK_GIB sets the home disk size in the config and the offer; default 2', () => {
  const d = loadConfig(HOME_ENV);
  assert.equal(d.home?.diskGib, 2);
  assert.equal(d.offer.home?.diskGiB, 2);
  const c = loadConfig({ ...HOME_ENV, CHARTER_HOME_DISK_GIB: '10' });
  assert.equal(c.home?.diskGib, 10);
  assert.equal(c.offer.home?.diskGiB, 10);
  for (const bad of ['0', '-1', '1.5', '65', 'ten']) {
    assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_HOME_DISK_GIB: bad }), /CHARTER_HOME_DISK_GIB/, bad);
  }
});

test('CHARTER_HOME_ROOT turns root homes on, only under gVisor, and the offer says so', () => {
  const off = loadConfig(HOME_ENV);
  assert.equal(off.home?.root, false);
  assert.equal(off.offer.home && 'root' in off.offer.home, false);
  const on = loadConfig({ ...HOME_ENV, CHARTER_RUNTIME: 'runsc', CHARTER_HOME_ROOT: '1' });
  assert.equal(on.home?.root, true);
  assert.equal(on.offer.home?.root, true);
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_HOME_ROOT: '1' }), /CHARTER_HOME_ROOT/);
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_RUNTIME: 'runc', CHARTER_HOME_ROOT: '1' }), /CHARTER_HOME_ROOT/);
});

test('charter-hermes alone also needs CHARTER_MAX_HOMES', () => {
  assert.throws(() => loadConfig({ ...ENV, CHARTER_ALLOW_IMAGES: 'charter-job-fetch,charter-hermes' }), /CHARTER_MAX_HOMES/);
  const c = loadConfig({ ...HOME_ENV, CHARTER_ALLOW_IMAGES: 'charter-home,charter-hermes' });
  assert.deepEqual(c.offer.images, ['charter-home', 'charter-hermes']);
});

test('more home slots than lease slots is an error', () => {
  assert.throws(() => loadConfig({ ...HOME_ENV, CHARTER_MAX_LEASES: '1', CHARTER_MAX_HOMES: '2' }), /CHARTER_MAX_HOMES/);
});
