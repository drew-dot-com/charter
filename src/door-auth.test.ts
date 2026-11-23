import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DOOR_SIG_HEADER, DOOR_TS_HEADER, rawJson, requireDoor, signDoorRequest, verifyDoorRequest,
} from './door-auth.js';

const KEY = privateKeyToAccount('0x' + '11'.repeat(32) as `0x${string}`);
const OTHER = privateKeyToAccount('0x' + '22'.repeat(32) as `0x${string}`);
const T = 1_700_000_000_000;
const body = '{"a":1}';

async function check(headers: Record<string, string>, over: { path?: string; body?: string; now?: number; door?: `0x${string}` } = {}) {
  return verifyDoorRequest({
    headers, method: 'POST', path: over.path ?? '/lease?x=1', body: over.body ?? body,
    door: over.door ?? KEY.address, now: over.now ?? T,
  });
}

test('a signed request verifies', async () => {
  const h = await signDoorRequest(KEY, 'post', '/lease?x=1', body, T);
  assert.equal(await check(h), true);
});

test('skew: 59 s accepted, 61 s refused', async () => {
  const h = await signDoorRequest(KEY, 'POST', '/lease?x=1', body, T);
  assert.equal(await check(h, { now: T + 59_000 }), true);
  assert.equal(await check(h, { now: T - 59_000 }), true);
  assert.equal(await check(h, { now: T + 61_000 }), false);
  assert.equal(await check(h, { now: T - 61_000 }), false);
});

test('a signature replayed on another path or body is refused', async () => {
  const h = await signDoorRequest(KEY, 'POST', '/lease?x=1', body, T);
  assert.equal(await check(h, { path: '/other' }), false);
  assert.equal(await check(h, { body: '{"a":2}' }), false);
});

test('another key is refused', async () => {
  const h = await signDoorRequest(OTHER, 'POST', '/lease?x=1', body, T);
  assert.equal(await check(h), false);
});

test('requireDoor answers 401 not_door with no headers, accepts a signed request', async () => {
  const app = express();
  let door: `0x${string}` | undefined = KEY.address;
  app.post('/x', rawJson, requireDoor(() => door, () => T), (_req, res) => { res.json({ ok: true }); });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const bad = await fetch(`${base}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: 'not_door' });
    const h = await signDoorRequest(KEY, 'POST', '/x', body, T);
    assert.ok(h[DOOR_SIG_HEADER] && h[DOOR_TS_HEADER]);
    const good = await fetch(`${base}/x`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body });
    assert.equal(good.status, 200);
    door = undefined;
    const unset = await fetch(`${base}/x`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body });
    assert.equal(unset.status, 401);
  } finally {
    srv.close();
  }
});
