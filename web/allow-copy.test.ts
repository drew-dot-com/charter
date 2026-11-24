import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEFORE_YOU_START, clampAllowance, errorWords, formatUsdc, hoursFor, stateWords } from './allow-copy.js';

test('formatUsdc is exact decimal, no dollar sign', () => {
  assert.equal(formatUsdc(5208000n), '5.208');
  assert.equal(formatUsdc(168000n), '0.168');
  assert.equal(formatUsdc(5000000n), '5');
  assert.equal(formatUsdc(1n), '0.000001');
});

test('hoursFor counts whole hours the allowance buys', () => {
  assert.equal(hoursFor(5208000n, 7000n), 744);
  assert.equal(hoursFor(5000000n, 7000n), 714);
  assert.equal(hoursFor(1n, 0n), 0);
});

test('clampAllowance refuses outside the range and names the bound', () => {
  const low = clampAllowance('0.1', 168000n, 5208000n);
  assert.equal(typeof low, 'string');
  assert.match(low as string, /0\.168/);
  const high = clampAllowance('9', 168000n, 5208000n);
  assert.match(high as string, /5\.208/);
  assert.equal(clampAllowance('5', 168000n, 5208000n), 5000000n);
  assert.equal(clampAllowance(' 5.208 ', 168000n, 5208000n), 5208000n);
  assert.equal(clampAllowance('0.168', 168000n, 5208000n), 168000n);
});

test('clampAllowance rejects non-numbers and too many decimals', () => {
  for (const s of ['', 'abc', '-1', '1e3', '1.2345678', '1,5']) assert.equal(typeof clampAllowance(s, 168000n, 5208000n), 'string', s);
});

test('BEFORE_YOU_START names the email, the pop-up and one signature', () => {
  assert.match(BEFORE_YOU_START, /email/);
  assert.match(BEFORE_YOU_START, /pop-up/);
  assert.match(BEFORE_YOU_START, /one signature/);
});

test('no copy has an em dash', () => {
  const all = [BEFORE_YOU_START, ...['waiting', 'approved', 'active', 'short', 'spent_for_period', 'stopping', 'refused', 'ended', 'expired'].map((s) => stateWords(s)), ...['not_waiting', 'permission_in_use', 'not_found', 'x'].map((e) => errorWords(e))];
  for (const s of all) assert.ok(!s.includes(String.fromCharCode(0x2014)) && !s.includes(String.fromCharCode(0x2013)), s);
});
