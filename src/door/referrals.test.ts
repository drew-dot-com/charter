import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReferral, shareOf, ReferralStore, REFERRALS_FILE } from './referrals.js';

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

const R = '0x' + 'ab'.repeat(20);
const file = () => join(mkdtempSync(join(tmpdir(), 'referrals-')), REFERRALS_FILE);

test('store: accrue keeps the first owedSince; markPaid to zero clears it; a later accrue sets a new one', () => {
  const s = new ReferralStore(file());
  s.accrue(R, 700n, 1_000);
  s.accrue(R, 300n, 2_000);
  assert.deepEqual(s.get(R), { earned: 1000n, paid: 0n, hours: 2, owedSince: 1_000 });
  assert.equal(s.owed(R), 1000n);
  assert.equal(s.totalOwed(), 1000n);
  s.markPaid(R, 400n, 'p1');
  assert.equal(s.get(R)?.owedSince, 1_000);
  s.markPaid(R, 600n, 'p2');
  assert.equal(s.owed(R), 0n);
  assert.equal(s.get(R)?.owedSince, undefined);
  s.accrue(R, 5n, 9_000);
  assert.equal(s.get(R)?.owedSince, 9_000);
  assert.equal(s.owed('0xunknown'), 0n);
  assert.equal(s.get('0xunknown'), undefined);
  assert.deepEqual(s.all().map((r) => r.address), [R]);
});

test('store: markPaid twice with the same payout id adds once, also after a reload', () => {
  const f = file();
  const s = new ReferralStore(f);
  s.accrue(R, 1000n, 1);
  s.markPaid(R, 300n, 'x');
  s.markPaid(R, 300n, 'x');
  assert.equal(s.get(R)?.paid, 300n);
  const t = new ReferralStore(f);
  t.markPaid(R, 300n, 'x');
  assert.equal(t.get(R)?.paid, 300n);
  assert.equal(t.get(R)?.lastPayoutId, 'x');
  t.markPaid(R, 200n, 'y');
  assert.equal(t.get(R)?.paid, 500n);
  assert.equal(new ReferralStore(f).owed(R), 500n);
});

test('store: hold and release', () => {
  const s = new ReferralStore(file());
  s.accrue(R, 1n, 1);
  s.hold(R, 'bad transfer');
  assert.equal(s.get(R)?.held, 'bad transfer');
  s.release(R);
  assert.equal(s.get(R)?.held, undefined);
});

test('store: hold on an address never seen creates a held record with nothing owed', () => {
  const f = file();
  const s = new ReferralStore(f);
  s.hold(R.toUpperCase().replace('0X', '0x'), 'unresolved payout x');
  assert.deepEqual(s.get(R), { earned: 0n, paid: 0n, hours: 0, held: 'unresolved payout x' });
  assert.equal(new ReferralStore(f).get(R)?.held, 'unresolved payout x');
  s.release('0x' + '99'.repeat(20));
  assert.equal(s.get('0x' + '99'.repeat(20)), undefined);
});

test('store: bindHome keeps the first; setHome replaces and unbinds', () => {
  const s = new ReferralStore(file());
  const other = '0x' + 'cd'.repeat(20);
  assert.equal(s.bindHome('h1', R), true);
  assert.equal(s.bindHome('h1', other), false);
  assert.equal(s.homeReferrer('h1'), R);
  s.setHome('h1', other);
  assert.equal(s.homeReferrer('h1'), other);
  s.setHome('h1', undefined);
  assert.equal(s.homeReferrer('h1'), undefined);
  assert.equal(s.bindHome('h1', R), true);
});

test('store: a new store on the same file reads everything back', () => {
  const f = file();
  const s = new ReferralStore(f);
  s.accrue(R, 1234n, 5);
  s.markPaid(R, 34n, 'p1');
  s.hold(R, 'why');
  s.bindHome('h1', R);
  const t = new ReferralStore(f);
  assert.deepEqual(t.get(R), { earned: 1234n, paid: 34n, hours: 1, held: 'why', owedSince: 5, lastPayoutId: 'p1' });
  assert.equal(t.homeReferrer('h1'), R);
  assert.equal(t.totalOwed(), 1200n);
});

test('store: a missing file is empty; unparseable JSON throws', () => {
  const f = file();
  const s = new ReferralStore(f);
  assert.equal(s.totalOwed(), 0n);
  assert.deepEqual(s.all(), []);
  writeFileSync(f, '{');
  assert.throws(() => new ReferralStore(f));
});
