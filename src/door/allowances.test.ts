import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllowanceStore, BadMove, EXPIRE_MS, billerView, ownerView, pageView, permissionKey, validatePermission, validateRequest } from './allowances.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@host';
const SPENDER = '0x1111111111111111111111111111111111aAaAaA';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ACCOUNT = '0xCAa32aC8bD59741Fd6Aab2432Cc4802fd0DCa334';

function store(now = { t: 1_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'allowances-'));
  const file = join(dir, 'sub', 'allowances.jsonl');
  return { file, now, s: new AllowanceStore(file, () => now.t) };
}
function req() {
  const v = validateRequest({ sshKeys: [KEY] });
  assert.equal(v.ok, true);
  const r = v as Extract<typeof v, { ok: true }>;
  return { sshKeys: r.sshKeys, image: r.image, tickMicro: 7000n };
}
const perm = () => ({
  signature: '0x' + 'ab'.repeat(65),
  chainId: 8453,
  permissionHash: '0x' + 'cd'.repeat(32),
  permission: {
    account: ACCOUNT,
    spender: SPENDER,
    token: USDC,
    allowance: '5208000',
    period: 2592000,
    start: 1_700_000_000,
    end: 281474976710655,
    salt: '0x' + '00'.repeat(31) + '01',
    extraData: '0x',
  },
});
const NOW_MS = 1_700_000_000_000;
const o = () => ({ spender: SPENDER, tickMicro: 7000n, now: NOW_MS });
function withPerm(patch: Record<string, unknown>, top: Record<string, unknown> = {}) {
  const p = perm();
  return { ...p, ...top, permission: { ...p.permission, ...patch } };
}

test('add makes a waiting allowance with a 32-hex id and hashed token', () => {
  const { s } = store();
  const a = s.add(req(), 'tok');
  assert.equal(a.state, 'waiting');
  assert.match(a.allowanceId, /^[0-9a-f]{32}$/);
  assert.notEqual(a.tokenHash, 'tok');
  assert.equal(s.tokenOk(a.allowanceId, 'tok'), true);
  assert.equal(s.tokenOk(a.allowanceId, 'x'), false);
  assert.equal(s.tokenOk('nope', 'tok'), false);
});

test('the store reloads from its file and survives a torn last line', () => {
  const { s, file, now } = store();
  const a = s.add(req(), 'tok');
  s.update(a.allowanceId, { state: 'approved' });
  appendFileSync(file, '{"allowanceId":"torn","sta');
  const s2 = new AllowanceStore(file, () => now.t);
  assert.equal(s2.get(a.allowanceId)?.state, 'approved');
  assert.equal(s2.tokenOk(a.allowanceId, 'tok'), true);
  const b = s2.add(req(), 'tok2');
  const s3 = new AllowanceStore(file, () => now.t);
  assert.equal(s3.get(b.allowanceId)?.state, 'waiting');
  assert.equal(s3.all().length, 2);
});

test('liveForHome expires a waiting allowance after 7 days', () => {
  const { s, now } = store();
  const a = s.add(req(), 'tok');
  assert.equal(s.liveForHome(a.homeId)?.allowanceId, a.allowanceId);
  now.t += EXPIRE_MS + 1;
  assert.equal(s.liveForHome(a.homeId), undefined);
  assert.equal(s.get(a.allowanceId)?.state, 'expired');
});

test('liveForHome does not expire an approved allowance', () => {
  const { s, now } = store();
  const a = s.add(req(), 'tok');
  s.update(a.allowanceId, { state: 'approved' });
  now.t += EXPIRE_MS + 1;
  assert.equal(s.liveForHome(a.homeId)?.state, 'approved');
});

test('update refuses a move the table does not allow', () => {
  const { s } = store();
  const a = s.add(req(), 'tok');
  assert.throws(() => s.update(a.allowanceId, { state: 'active' }), BadMove);
  s.update(a.allowanceId, { state: 'approved' });
  s.update(a.allowanceId, { state: 'active' });
  s.update(a.allowanceId, { state: 'short' });
  s.update(a.allowanceId, { state: 'stopping' });
  s.update(a.allowanceId, { state: 'ended' });
  assert.throws(() => s.update(a.allowanceId, { state: 'active' }), BadMove);
});

test('validateRequest takes keys and defaults the image', () => {
  const v = validateRequest({ sshKeys: [KEY] });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.image, 'charter-home');
  assert.equal(validateRequest({ sshKeys: [KEY], image: 'x' }).ok, false);
  assert.equal(validateRequest({ sshKeys: [KEY], image: 'charter-hermes' }).ok, true);
  const keys = Array.from({ length: 9 }, (_, i) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(i).repeat(5)}`);
  assert.equal(validateRequest({ sshKeys: keys }).ok, false);
  assert.equal(validateRequest(null).ok, false);
});

test("validatePermission accepts the spike's shape", () => {
  const v = validatePermission(perm(), o());
  assert.equal(v.ok, true);
});

test('validatePermission refuses', () => {
  const bad = (b: unknown, field: string) => {
    const v = validatePermission(b, o());
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.error, new RegExp(field));
  };
  assert.equal(validatePermission(withPerm({ spender: SPENDER.toLowerCase() }), o()).ok, true);
  bad(withPerm({ spender: '0x2222222222222222222222222222222222222222' }), 'spender');
  bad(withPerm({ token: '0x2222222222222222222222222222222222222222' }), 'token');
  bad(withPerm({}, { chainId: 1 }), 'chainId');
  bad(withPerm({ period: 86400 }), 'period');
  // At least 720 ticks (30 days of the home), so a smaller allowance never loses the home every month.
  bad(withPerm({ allowance: '5039999' }), 'allowance');
  assert.equal(validatePermission(withPerm({ allowance: '5040000' }), o()).ok, true);
  bad(withPerm({ end: 1000 }), 'end');
  bad(withPerm({}, { signature: 'zz' }), 'signature');
  bad(withPerm({}, { signature: '0x' }), 'signature');
  bad(withPerm({ account: 'nope' }), 'account');
  bad(null, 'body');
});

test('validatePermission bounds every field to its Solidity type', () => {
  const bad = (b: unknown, field: string) => {
    const v = validatePermission(b, o());
    assert.equal(v.ok, false, field);
    if (!v.ok) assert.match(v.error, new RegExp(field));
  };
  const ok = (b: unknown) => assert.equal(validatePermission(b, o()).ok, true);
  // allowance: uint160
  ok(withPerm({ allowance: (2n ** 160n - 1n).toString() }));
  bad(withPerm({ allowance: (2n ** 160n).toString() }), 'allowance');
  bad(withPerm({ allowance: '9'.repeat(78) }), 'allowance');
  // start and end: uint48
  ok(withPerm({ end: 2 ** 48 - 1 }));
  bad(withPerm({ end: 2 ** 48 }), 'end');
  bad(withPerm({ end: Number.MAX_SAFE_INTEGER }), 'end');
  bad(withPerm({ start: 2 ** 48 }), 'start');
  // salt: uint256
  ok(withPerm({ salt: '0x' + 'ff'.repeat(32) }));
  bad(withPerm({ salt: '0x1' + '00'.repeat(32) }), 'salt');
  bad(withPerm({ salt: '0x' + '0'.repeat(200) }), 'salt');
  // extraData: bytes, even-length hex, capped
  ok(withPerm({ extraData: '0x' }));
  ok(withPerm({ extraData: '0xabcd' }));
  bad(withPerm({ extraData: '0xabc' }), 'extraData');
  bad(withPerm({ extraData: '0x' + 'ab'.repeat(1025) }), 'extraData');
  // signature: bytes, even-length, up to 20000 characters (an ERC-6492 wrapped passkey signature is long)
  ok(withPerm({}, { signature: '0x' + 'ab'.repeat(4000) }));
  ok(withPerm({}, { signature: '0x' + 'ab'.repeat(9999) }));
  bad(withPerm({}, { signature: '0x' + 'ab'.repeat(10000) }), 'signature');
  bad(withPerm({}, { signature: '0xabc' }), 'signature');
});

test('validatePermission refuses a start more than 10 minutes ahead of the door clock', () => {
  const nowSec = NOW_MS / 1000;
  assert.equal(validatePermission(withPerm({ start: nowSec + 600 }), o()).ok, true);
  const v = validatePermission(withPerm({ start: nowSec + 601 }), o());
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /start/);
  // A start in the past (the page passes an hour ago) is fine.
  assert.equal(validatePermission(withPerm({ start: nowSec - 3600 }), o()).ok, true);
});

test('pageView hides keys, homeId, token hash, signature and leaseId; ownerView adds homeId and leaseId', () => {
  const { s } = store();
  const a0 = s.add(req(), 'tok');
  const v = validatePermission(perm(), o());
  assert.equal(v.ok, true);
  const a = s.update(a0.allowanceId, { state: 'approved', signed: (v as { signed: never }).signed, account: ACCOUNT, leaseId: 'lease-1' });
  const pv = pageView(a, SPENDER);
  const text = JSON.stringify(pv);
  for (const k of ['sshKeys', 'homeId', 'tokenHash', 'signature', 'leaseId']) assert.equal(k in pv, false, k);
  assert.equal(text.includes('ab'.repeat(65)), false);
  assert.equal(pv.allowanceId, a.allowanceId);
  assert.equal(pv.suggestedMicro, '5208000');
  assert.equal(pv.minMicro, '5040000');
  assert.equal(pv.periodDays, 30);
  assert.equal(pv.spender, SPENDER);
  assert.equal(pv.account, ACCOUNT);
  const ov = ownerView(a, SPENDER);
  assert.equal(ov.homeId, a.homeId);
  assert.equal(ov.leaseId, 'lease-1');
  assert.equal('sshKeys' in ov, false);
  assert.equal('tokenHash' in ov, false);
  const bv = billerView(a);
  assert.equal('tokenHash' in bv, false);
  assert.ok('signed' in bv && 'sshKeys' in bv);
});

test('permissionHolder finds the allowance that ever stored a permission, by account and salt', () => {
  const { s, file } = store();
  const a = s.add(req(), 'tok');
  const v = validatePermission(perm(), o());
  assert.equal(v.ok, true);
  const signed = (v as Extract<typeof v, { ok: true }>).signed;
  assert.equal(s.permissionHolder(ACCOUNT, signed.permission.salt), undefined);
  s.update(a.allowanceId, { state: 'approved', signed, account: ACCOUNT });
  // Any case of the account, any hex spelling of the salt: the same permission.
  assert.equal(s.permissionHolder(ACCOUNT.toLowerCase(), '0x1'), a.allowanceId);
  assert.equal(s.permissionHolder(ACCOUNT.toUpperCase().replace('0X', '0x'), '0x' + '00'.repeat(31) + '01'), a.allowanceId);
  assert.equal(s.permissionHolder(ACCOUNT, '0x2'), undefined);
  assert.equal(s.permissionHolder('0x' + '22'.repeat(20), '0x1'), undefined);
  // Still held once the allowance is over, and after a reload.
  s.update(a.allowanceId, { state: 'stopping' });
  s.update(a.allowanceId, { state: 'ended', endReason: 'stopped' });
  assert.equal(s.permissionHolder(ACCOUNT, '0x1'), a.allowanceId);
  assert.equal(new AllowanceStore(file, () => 1).permissionHolder(ACCOUNT, '0x1'), a.allowanceId);
  assert.equal(permissionKey('0xAB', '0x0a'), permissionKey('0xab', '0xA'));
});
