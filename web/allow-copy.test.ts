import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BEFORE_YOU_START, clampAllowance, errorWords, formatUsdc, hoursFor, stateWords, stopWords } from './allow-copy.js';

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
  // The minimum is 720 ticks (30 days of the home) at 7000: 5.04 USDC.
  const low = clampAllowance('5.039999', 5040000n, 5208000n);
  assert.equal(typeof low, 'string');
  assert.match(low as string, /5\.04 USDC \(30 days of the home\)/);
  const high = clampAllowance('9', 5040000n, 5208000n);
  assert.match(high as string, /5\.208/);
  assert.equal(clampAllowance('5.1', 5040000n, 5208000n), 5100000n);
  assert.equal(clampAllowance(' 5.208 ', 5040000n, 5208000n), 5208000n);
  assert.equal(clampAllowance('5.04', 5040000n, 5208000n), 5040000n);
});

test('clampAllowance rejects non-numbers and too many decimals', () => {
  for (const s of ['', 'abc', '-1', '1e3', '1.2345678', '1,5']) assert.equal(typeof clampAllowance(s, 5040000n, 5208000n), 'string', s);
});

test('BEFORE_YOU_START names the email, the pop-up and one signature', () => {
  assert.match(BEFORE_YOU_START, /email/);
  assert.match(BEFORE_YOU_START, /pop-up/);
  assert.match(BEFORE_YOU_START, /one signature/);
});

test('stopWords names the Base Account cancel only once it is tested', () => {
  assert.doesNotMatch(stopWords(false), /Base Account|cancel/i);
  assert.match(stopWords(false), /ask the agent to stop it, or contact the operator/);
  assert.match(stopWords(true), /Base Account/);
});

test('the page passes a start an hour back and gates its cancel words', () => {
  const src = readFileSync(new URL('./allow.ts', import.meta.url), 'utf8');
  assert.match(src, /start: new Date\(Date\.now\(\) - START_BACK_MS\)/);
  assert.match(src, /START_BACK_MS = 3_600_000/);
  assert.match(src, /stopWords\(CANCEL_TESTED\)/);
  assert.doesNotMatch(src, /and only to pay for this home/);
  assert.match(src, /Charter uses it only to pay for this home/);
});

test('no copy has an em dash', () => {
  const all = [BEFORE_YOU_START, stopWords(false), stopWords(true), ...['waiting', 'approved', 'active', 'short', 'spent_for_period', 'stopping', 'refused', 'ended', 'expired'].map((s) => stateWords(s)), ...['not_waiting', 'permission_in_use', 'not_found', 'x'].map((e) => errorWords(e))];
  for (const s of all) assert.ok(!s.includes(String.fromCharCode(0x2014)) && !s.includes(String.fromCharCode(0x2013)), s);
});
