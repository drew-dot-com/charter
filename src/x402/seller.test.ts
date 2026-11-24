import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { settleTxOf } from './seller.js';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const res = (h: unknown) => ({ getHeader: () => h }) as unknown as Response;
const TX = '0x' + 'ab'.repeat(32);

test('settleTxOf returns the hash from a successful PAYMENT-RESPONSE', () => {
  assert.equal(settleTxOf(res(b64({ success: true, transaction: TX, network: 'eip155:8453' }))), TX);
});

test('settleTxOf ignores a failed or malformed response', () => {
  assert.equal(settleTxOf(res(b64({ success: false, transaction: TX }))), undefined);
  assert.equal(settleTxOf(res(b64({ success: true, transaction: '' }))), undefined);
  assert.equal(settleTxOf(res(b64({ success: true, transaction: '0x1234' }))), undefined);
  assert.equal(settleTxOf(res(b64({ success: true }))), undefined);
  assert.equal(settleTxOf(res('not base64!')), undefined);
  assert.equal(settleTxOf(res(['a'])), undefined);
  assert.equal(settleTxOf(res(undefined)), undefined);
});
