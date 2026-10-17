import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoorHosts, parseTrustProxy } from './config.js';

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
