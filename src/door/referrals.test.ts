import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReferral, shareOf } from './referrals.js';

test('parseReferral', () => {
  const a = '0x52908400098527886E0F7030069857D2E4169EE7'; // valid checksum
  assert.equal(parseReferral(undefined, []), undefined);
  assert.equal(parseReferral(a, []), a.toLowerCase());
  assert.equal(parseReferral(a.toLowerCase(), []), a.toLowerCase());
  assert.equal(parseReferral('0x52908400098527886E0F7030069857D2E4169Ee7', []), 'bad_referral'); // checksum broken
  assert.equal(parseReferral('0x' + '0'.repeat(40), []), 'bad_referral');
  assert.equal(parseReferral(a, [a.toLowerCase()]), 'bad_referral');
  assert.equal(parseReferral(a, [undefined]), a.toLowerCase());
  for (const v of [null, 7, '', '0x12', {}, [a]]) assert.equal(parseReferral(v, []), 'bad_referral');
});

test('shareOf', () => {
  assert.equal(shareOf({ paid: 7000n, fee: 0n, bps: 1000, hostListed: true }), 700n);
  assert.equal(shareOf({ paid: 7000n, fee: 0n, bps: 1000, hostListed: false }), 0n);
  assert.equal(shareOf({ paid: 7700n, fee: 700n, bps: 1000, hostListed: false }), 700n);
  assert.equal(shareOf({ paid: 7700n, fee: 300n, bps: 1000, hostListed: false }), 300n);
  assert.equal(shareOf({ paid: 7001n, fee: 0n, bps: 1000, hostListed: true }), 700n); // floor
  assert.equal(shareOf({ paid: 7000n, fee: 0n, bps: 0, hostListed: true }), 0n);
});
