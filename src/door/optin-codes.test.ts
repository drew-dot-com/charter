import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPTIN_CODES_FILE, OptinCodes, optinCodeOf, optinHash, optinKey, parseXHandle, socialView } from './optin-codes.js';

const KEY = optinKey('0x' + '11'.repeat(32));
const lines = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; id: string; hash: string });

test('a code is the prefix and 32 hex characters, the same on every call', () => {
  const c = optinCodeOf(KEY, 'lease', 'L1');
  assert.match(c, /^charter-optin-[0-9a-f]{32}$/);
  assert.equal(optinCodeOf(KEY, 'lease', 'L1'), c);
});

test('a code differs by subject, by kind and by key', () => {
  const c = optinCodeOf(KEY, 'lease', 'L1');
  assert.notEqual(optinCodeOf(KEY, 'lease', 'L2'), c);
  assert.notEqual(optinCodeOf(KEY, 'grant', 'L1'), c);
  assert.notEqual(optinCodeOf(optinKey('0x' + '22'.repeat(32)), 'lease', 'L1'), c);
});

test('the derived key is not the payer key', () => {
  assert.equal(KEY.length, 32);
  assert.notEqual(KEY.toString('hex'), '11'.repeat(32));
});

test('the hash of a code ignores case and outer spaces', () => {
  const c = optinCodeOf(KEY, 'grant', 'G1');
  assert.match(optinHash(c), /^[0-9a-f]{64}$/);
  assert.equal(optinHash(` ${c.toUpperCase()} `), optinHash(c));
});

test('the first serve of a code appends its hash, and only the hash, once, across restarts', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'optin-')), OPTIN_CODES_FILE);
  const a = new OptinCodes(file, KEY);
  const code = a.codeFor('lease', 'L1');
  a.codeFor('lease', 'L1');
  a.codeFor('grant', 'G1');
  assert.deepEqual(lines(file), [
    { kind: 'lease', id: 'L1', hash: optinHash(code) },
    { kind: 'grant', id: 'G1', hash: optinHash(optinCodeOf(KEY, 'grant', 'G1')) },
  ]);
  assert.ok(!readFileSync(file, 'utf8').includes(code), 'the code itself is never written');
  const b = new OptinCodes(file, KEY);
  assert.equal(b.codeFor('lease', 'L1'), code);
  assert.equal(lines(file).length, 2);
});

test('a hash file that cannot be written never fails the read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optin-'));
  mkdirSync(join(dir, OPTIN_CODES_FILE));
  const c = new OptinCodes(join(dir, OPTIN_CODES_FILE), KEY);
  assert.equal(c.codeFor('lease', 'L1'), optinCodeOf(KEY, 'lease', 'L1'));
});

test('the owner view carries the code and the exact text to post', () => {
  const codes = new OptinCodes(join(mkdtempSync(join(tmpdir(), 'optin-')), OPTIN_CODES_FILE), KEY);
  const v = socialView({ handle: 'charterbox', codes }, 'lease', 'L1');
  assert.equal(v.post, `@charterbox ${v.optinCode}`);
  assert.match(v.how, /stop/);
  assert.ok(!/[–—]/.test(v.how));
});

test('a handle setting drops a leading @, and refuses anything that is not a handle', () => {
  assert.equal(parseXHandle(undefined, 'X'), undefined);
  assert.equal(parseXHandle('  ', 'X'), undefined);
  assert.equal(parseXHandle('@charterhomedev', 'X'), 'charterhomedev');
  assert.throws(() => parseXHandle('not a handle', 'X'), /X must be an X handle/);
  assert.throws(() => parseXHandle('a'.repeat(16), 'X'), /X must be an X handle/);
});
