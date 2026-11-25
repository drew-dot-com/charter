import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorFunding, referralConfig, parseSweepKeep, parseCdpKey, parsePayerKey, parseTrustProxy } from './config.js';
import { claimSigner, parseClaimKey } from '../x402/seller.js';

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

test('parsePayerKey: one 0x-prefixed 64-hex key; refusals name CHARTER_DOOR_PAYER_KEY_FILE and no key bytes', () => {
  assert.equal(parsePayerKey(`${KEY}\n`), KEY);
  for (const bad of ['ab'.repeat(32), `${KEY}\n${KEY}`, '']) {
    assert.throws(() => parsePayerKey(bad), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /CHARTER_DOOR_PAYER_KEY_FILE/);
      assert.doesNotMatch(e.message, /[0-9a-f]{8}/);
      return true;
    });
  }
});

test('doorFunding applies the defaults and reads overrides', () => {
  assert.deepEqual(doorFunding({}), {
    probesPerDay: 10, probeMaxTick: 10_000n, probeDeposit: 100_000n, probeCap: 1_000_000n,
    hostDeposit: 500_000n, hostCap: 10_000_000n, selfAddrs: [], doorFee: 0n, hostDailyLoss: 50_000n,
    depositTimeoutDailyCap: 100_000n,
  });
  const f = doorFunding({
    CHARTER_PROBES_PER_DAY: '3', CHARTER_PROBE_MAX_TICK: '7000', CHARTER_PROBE_DEPOSIT: '200000', CHARTER_PROBE_CAPITAL_CAP: '2000000',
    CHARTER_HOST_DEPOSIT: '1000000', CHARTER_HOST_CAPITAL_CAP: '20000000', CHARTER_DOOR_SELF_ADDRS: ' 37.27.86.235, 2a01:4f9::/64 ,',
    CHARTER_DOOR_FEE: '500', CHARTER_HOST_DAILY_LOSS: '20000', CHARTER_DEPOSIT_TIMEOUT_DAILY_CAP: '30000',
  });
  assert.deepEqual(f, {
    probesPerDay: 3, probeMaxTick: 7000n, probeDeposit: 200_000n, probeCap: 2_000_000n,
    hostDeposit: 1_000_000n, hostCap: 20_000_000n, selfAddrs: ['37.27.86.235', '2a01:4f9::/64'], doorFee: 500n, hostDailyLoss: 20_000n,
    depositTimeoutDailyCap: 30_000n,
  });
  for (const [k, v] of [['CHARTER_PROBES_PER_DAY', '-1'], ['CHARTER_PROBE_MAX_TICK', '0'], ['CHARTER_HOST_DEPOSIT', '1.5'], ['CHARTER_HOST_CAPITAL_CAP', 'lots'], ['CHARTER_DOOR_FEE', '-5'], ['CHARTER_HOST_DAILY_LOSS', 'x'], ['CHARTER_DEPOSIT_TIMEOUT_DAILY_CAP', '1e5']] as const) {
    assert.throws(() => doorFunding({ [k]: v }), new RegExp(k));
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

test('parseCdpKey: the JSON the CDP portal downloads, {id} or legacy {name}, with privateKey; anything else is refused without echoing the file', () => {
  assert.deepEqual(parseCdpKey(JSON.stringify({ id: 'key-1', privateKey: 'c2VjcmV0' })), { id: 'key-1', secret: 'c2VjcmV0' });
  assert.deepEqual(parseCdpKey(JSON.stringify({ name: 'organizations/o/apiKeys/k', privateKey: '-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\n' })), {
    id: 'organizations/o/apiKeys/k',
    secret: '-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\n',
  });
  for (const bad of ['not json SECRETVALUE', '{}', JSON.stringify({ id: 'k' }), JSON.stringify({ privateKey: 'SECRETVALUE' }), JSON.stringify({ id: '', privateKey: 'SECRETVALUE' })]) {
    assert.throws(() => parseCdpKey(bad), (e: Error) => /CHARTER_CDP_KEY_FILE/.test(e.message) && !e.message.includes('SECRETVALUE'), bad);
  }
});

test('CHARTER_SWEEP_KEEP is a non-negative integer, default 15 USDC', () => {
  assert.equal(parseSweepKeep(undefined), 15_000_000n);
  assert.equal(parseSweepKeep(' 0 '), 0n);
  assert.equal(parseSweepKeep('20000000'), 20_000_000n);
  for (const bad of ['-1', '15.5', '1e7', 'abc']) assert.throws(() => parseSweepKeep(bad), /non-negative integer/);
});

test('referralConfig: defaults', () => {
  const c = referralConfig({});
  assert.equal(c.bps, 0);
  assert.equal(c.minPayout, 100_000n);
  assert.equal(c.dailyCap, 5_000_000n);
  assert.equal(c.keep, 5_000_000n);
  assert.equal(c.hosts.size, 0);
});

test('referralConfig: bps tops out at 5000 and must be a whole number', () => {
  assert.equal(referralConfig({ CHARTER_REFERRAL_BPS: '5000' }).bps, 5000);
  assert.throws(() => referralConfig({ CHARTER_REFERRAL_BPS: '5001' }), /CHARTER_REFERRAL_BPS/);
  assert.throws(() => referralConfig({ CHARTER_REFERRAL_BPS: 'abc' }), /CHARTER_REFERRAL_BPS/);
});

test('referralConfig: hosts is a trimmed, lower-cased set of 64-hex ids', () => {
  const a = 'AB'.repeat(32);
  const b = 'cd'.repeat(32);
  const c = referralConfig({ CHARTER_REFERRAL_HOSTS: ` ${a} , ${b},` });
  assert.deepEqual([...c.hosts], [a.toLowerCase(), b]);
  assert.throws(() => referralConfig({ CHARTER_REFERRAL_HOSTS: `${b},abc` }), /CHARTER_REFERRAL_HOSTS/);
});
