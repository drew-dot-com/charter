import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, isBlockedHostname, checkUrl } from './guard.mjs';

test('blocks loopback, private, link-local, CGNAT and unspecified IPv4', () => {
  for (const a of [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
});

test('allows public IPv4, including just outside the private ranges', () => {
  for (const a of ['93.184.216.34', '8.8.8.8', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '11.0.0.1', '192.169.0.1']) {
    assert.equal(isBlockedAddress(a), false, a);
  }
});

test('blocks loopback, unspecified, link-local, ULA and mapped IPv6', () => {
  for (const a of [
    '::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '::127.0.0.1',
  ]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
});

test('allows public IPv6 and mapped public IPv4', () => {
  for (const a of ['2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, a);
  }
});

test('a non-IP string is refused', () => {
  assert.equal(isBlockedAddress('example.com'), true);
});

test('blocks localhost names', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'a.localhost', 'host.docker.internal', 'host.docker.internal.']) {
    assert.equal(isBlockedHostname(h), true, h);
  }
  assert.equal(isBlockedHostname('example.com'), false);
});

const resolver = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

test('checkUrl blocks IP literals and local names without a lookup', async () => {
  const boom = async () => assert.fail('lookup must not run');
  for (const u of ['http://127.0.0.1/', 'http://[::1]:8080/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://host.docker.internal:9050/', 'http://2130706433/', 'http://0x7f.1/']) {
    const r = await checkUrl(u, { lookup: boom });
    assert.equal(r.ok, false, u);
  }
});

test('checkUrl blocks a hostname if any resolved address is private', async () => {
  const lookup = resolver({ 'mixed.test': ['93.184.216.34', '10.0.0.5'], 'six.test': ['fd00::1'] });
  assert.equal((await checkUrl('https://mixed.test/', { lookup })).ok, false);
  assert.equal((await checkUrl('https://six.test/', { lookup })).ok, false);
});

test('checkUrl allows a hostname that resolves only to public addresses', async () => {
  const lookup = resolver({ 'example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
  assert.deepEqual(await checkUrl('https://example.com/x?y=1', { lookup }), { ok: true });
});

test('checkUrl names the blocked host', async () => {
  const r = await checkUrl('http://127.0.0.1:8080/', { lookup: resolver({}) });
  assert.equal(r.host, '127.0.0.1');
});

test('checkUrl: lookup failure blocks by default and allows when the proxy resolves', async () => {
  const lookup = resolver({});
  assert.equal((await checkUrl('http://abc.onion/', { lookup })).ok, false);
  assert.equal((await checkUrl('http://abc.onion/', { lookup, lookupFailure: 'allow' })).ok, true);
});

test('checkUrl refuses other schemes but lets data and about through', async () => {
  const lookup = resolver({});
  assert.equal((await checkUrl('file:///etc/passwd', { lookup })).ok, false);
  assert.equal((await checkUrl('ftp://example.com/', { lookup })).ok, false);
  assert.equal((await checkUrl('data:text/plain,hi', { lookup })).ok, true);
  assert.equal((await checkUrl('about:blank', { lookup })).ok, true);
});
