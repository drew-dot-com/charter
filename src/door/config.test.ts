import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimSigner, parseClaimKey, parseDoorHosts, parseTrustProxy } from './config.js';

const A = 'ab'.repeat(32);
const B = 'cd'.repeat(32);

test('F-I5: CHARTER_DOOR_TRUST_PROXY accepts 1, true, or a hop count, and nothing else', () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(''), undefined);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy(' TRUE '), true);
  for (const bad of ['yes', 'loopback', '-1', '0', '1.5', 'false']) {
    assert.throws(() => parseTrustProxy(bad), /CHARTER_DOOR_TRUST_PROXY/, bad);
  }
});

test('F-C1: CHARTER_DOOR_HOSTS is a comma list of <pubkey>=<ilpBase>, and is required', () => {
  const m = parseDoorHosts(`${A}=g.toon.69b2a212547e7a9c, ${B}=g.toon.c50e6a019916b7cb`);
  assert.deepEqual([...m], [[A, 'g.toon.69b2a212547e7a9c'], [B, 'g.toon.c50e6a019916b7cb']]);
  for (const bad of [undefined, '', ' , ', `${A}`, `${A}=`, `${A.toUpperCase()}=g.toon.x`, `${A.slice(2)}=g.toon.x`, `${A}=not an address`, `${A}=g.toon.x,${A}=g.toon.y`]) {
    assert.throws(() => parseDoorHosts(bad), /CHARTER_DOOR_HOSTS/, String(bad));
  }
});

const KEY = '0x' + 'ab'.repeat(32);

test('parseClaimKey: a 0x-prefixed 64-hex key, trailing newline allowed', () => {
  assert.equal(parseClaimKey(`${KEY}\n`), KEY);
});

test('parseClaimKey refuses a missing prefix, a short key and a second line, and names no key bytes', () => {
  for (const bad of ['ab'.repeat(32), '0x' + 'ab'.repeat(31) + 'a', `${KEY}\n${KEY}`, '']) {
    assert.throws(() => parseClaimKey(bad), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /CHARTER_CLAIM_KEY_FILE must hold one 0x-prefixed 64-hex private key/);
      assert.doesNotMatch(e.message, /[0-9a-f]{8}/);
      return true;
    });
  }
});

test('claimSigner derives the key address and signs typed data', async () => {
  const s = claimSigner(KEY);
  assert.match(s.address, /^0x[0-9a-fA-F]{40}$/);
  const sig = await s.signTypedData({
    domain: { name: 't', version: '1', chainId: 8453 },
    types: { M: [{ name: 'v', type: 'uint256' }] },
    primaryType: 'M',
    message: { v: 1n },
  });
  assert.match(sig, /^0x[0-9a-f]{130}$/);
});
