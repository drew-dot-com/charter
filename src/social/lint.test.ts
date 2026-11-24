import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint, X_MAX_CHARS } from './lint.js';
import type { FactSheet } from './facts.js';
import type { Rules } from './files.js';

const HASH = '0x' + 'ab'.repeat(32);
const facts: FactSheet = {
  facts: [{ id: 'f1', text: 'Rate is 0.007 USDC per hour. 1,200 hours served.' }],
  txLinks: [`https://basescan.org/tx/${HASH}`],
  mentionable: ['alice'],
};
const rules: Rules = { banned: ['token', 'toon', 'airdrop'] };
const ctx = { facts, rules, siteHost: 'charter.example', selfHandle: 'charterhq' };
const run = (text: string, o: Partial<typeof ctx & { replyToHandle: string }> = {}) => lint(text, { ...ctx, ...o });

test('passes a clean post', () => {
  assert.deepEqual(run('A home costs 0.007 USDC per hour.'), []);
});

test('rejects every dash code point', () => {
  for (const d of ['‒', '–', '—', '―', '--']) {
    assert.ok(run(`a ${d} b`).length > 0, `dash ${JSON.stringify(d)}`);
  }
});

test('rejects $ followed by letters', () => {
  assert.ok(run('buy $USDC now').length > 0);
});

test('rejects any hashtag', () => {
  assert.ok(run('hello #base').length > 0);
});

test('rejects over 280 characters, counting any URL as 23', () => {
  assert.equal(X_MAX_CHARS, 280);
  assert.ok(run('a'.repeat(281)).length > 0);
  assert.deepEqual(run('a'.repeat(280)), []);
  const url = 'https://charter.example/some/very/long/path/that/is/longer/than/twenty-three/chars';
  assert.deepEqual(run('a'.repeat(256) + ' ' + url), []);
  assert.ok(run('a'.repeat(258) + ' ' + url).length > 0);
});

test('rejects two links', () => {
  assert.ok(run('https://charter.example/a https://charter.example/b').length > 0);
});

test('allows one link to siteHost, a listed basescan tx, or own x.com status', () => {
  assert.deepEqual(run('see https://charter.example/x'), []);
  assert.deepEqual(run('see https://www.charter.example'), []);
  assert.deepEqual(run(`tx https://basescan.org/tx/${HASH}`), []);
  assert.deepEqual(run('https://x.com/charterhq/status/1234567890'), []);
  assert.deepEqual(run('https://twitter.com/CharterHQ/status/1234567890'), []);
});

test('rejects basescan link whose hash is not in txLinks', () => {
  assert.ok(run(`https://basescan.org/tx/0x${'cd'.repeat(32)}`).length > 0);
  assert.ok(run('https://basescan.org/address/0x1').length > 0);
});

test('rejects x.com links without selfHandle or for another handle', () => {
  assert.ok(run('https://x.com/charterhq/status/1', { selfHandle: undefined }).length > 0);
  assert.ok(run('https://x.com/someoneelse/status/1').length > 0);
  assert.ok(run('https://x.com/charterhq').length > 0);
});

test('rejects any other host, including bare domains', () => {
  assert.ok(run('https://evil.com/x').length > 0);
  assert.ok(run('go to evil.com/x').length > 0);
  assert.ok(run('go to charter.example.evil.com').length > 0);
  assert.ok(run('charter.example/a and evil.com').length > 0);
  assert.deepEqual(run('go to charter.example/a'), []);
});

test('rejects @handles not in mentionable and not replyToHandle', () => {
  assert.deepEqual(run('thanks @alice'), []);
  assert.deepEqual(run('thanks @ALICE'), []);
  assert.ok(run('thanks @bob').length > 0);
  assert.deepEqual(run('thanks @bob', { replyToHandle: 'Bob' }), []);
  assert.ok(run('mail me@evil.com').length > 0);
});

test('rejects banned words case-insensitively as whole words', () => {
  assert.ok(run('a Token here').length > 0);
  assert.ok(run('a TOKEN here').length > 0);
  assert.ok(run('a token-gated door').length > 0);
  assert.ok(run('TOON rules').length > 0);
  assert.deepEqual(run('a tokenizer here'), []);
});

test('rejects spaced-out banned words', () => {
  assert.ok(run('a t o k e n here').length > 0);
  assert.ok(run('a t.o.k.e.n here').length > 0);
  assert.ok(run('a t​o​k​e​n here').length > 0);
});

test('rejects a number not in any fact', () => {
  assert.ok(run('I hold 12 homes').length > 0);
});

test('ignores digits inside allowed links', () => {
  assert.deepEqual(run(`tx https://basescan.org/tx/${HASH}`), []);
  assert.deepEqual(run('https://x.com/charterhq/status/98765'), []);
});

test('accepts numbers present in facts, comparing without thousands commas', () => {
  assert.deepEqual(run('0.007 per hour'), []);
  assert.deepEqual(run('1200 hours'), []);
  assert.deepEqual(run('1,200 hours'), []);
  assert.ok(run('0.008 per hour').length > 0);
});

test('fails closed on empty output', () => {
  assert.ok(run('').length > 0);
  assert.ok(run('   ').length > 0);
});
