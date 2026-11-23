import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorReason } from './redact.js';

test('errorReason: one short line, viem\'s shortMessage first, every http(s) URL removed', () => {
  assert.equal(errorReason(new Error('boom at https://rpc.example/v2/KEY?x=1\n  more')), 'boom at <url> more');
  assert.equal(errorReason(Object.assign(new Error('long'), { shortMessage: 'short http://x.example/KEY' })), 'short <url>');
  assert.equal(errorReason('plain'), 'plain');
  assert.equal(errorReason(new Error('x'.repeat(300))).length, 200);
});
