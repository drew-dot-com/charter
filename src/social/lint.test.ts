import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint, X_MAX_CHARS } from './lint.js';
import type { FactSheet } from './facts.js';
import { DEFAULT_BANNED, type Rules } from './files.js';

const HASH = '0x' + 'ab'.repeat(32);
const facts: FactSheet = {
  facts: [{ id: 'f1', text: 'Rate is 0.007 USDC per hour. 1,200 hours served.' }],
  txLinks: [`https://basescan.org/tx/${HASH}`],
  mentionable: ['alice'],
};
const rules: Rules = { banned: ['token', 'toon', 'airdrop'] };
const ctx = { facts, rules, siteHost: 'charter.example', selfHandle: 'charterhq' };
const run = (text: string, o: Partial<typeof ctx & { replyToHandle: string }> = {}) => lint(text, { ...ctx, ...o });
/** The text must be rejected and some reason must name the expected rule. */
const rej = (text: string, reason: string, o: Partial<typeof ctx & { replyToHandle: string }> = {}) => {
  const r = run(text, o);
  assert.ok(r.some((x) => x.includes(reason)), `${JSON.stringify(text)} expected "${reason}", got ${JSON.stringify(r)}`);
};

test('passes a clean post', () => {
  assert.deepEqual(run('A home costs 0.007 USDC per hour.'), []);
  assert.deepEqual(run('line one\nline two'), []);
});

test('rejects every dash code point and --', () => {
  for (const d of ['\u2012', '\u2013', '\u2014', '\u2015', '--']) rej(`a ${d} b`, 'contains a dash');
});

test('rejects $ followed by letters', () => {
  rej('buy $USDC now', '$ticker');
});

test('rejects any hashtag', () => {
  rej('hello #base', 'hashtag');
});

test('rejects over 280 characters, counting any URL as 23', () => {
  assert.equal(X_MAX_CHARS, 280);
  rej('a'.repeat(281), 'over 280');
  assert.deepEqual(run('a'.repeat(280)), []);
  const url = 'https://charter.example/some/very/long/path/that/is/longer/than/twenty-three/chars';
  assert.deepEqual(run('a'.repeat(256) + ' ' + url), []);
  rej('a'.repeat(258) + ' ' + url, 'over 280');
});

test('rejects two links', () => {
  rej('https://charter.example/a https://charter.example/b', 'more than one link');
});

test('allows one link to siteHost, a listed basescan tx, or own x.com status', () => {
  assert.deepEqual(run('see https://charter.example/x'), []);
  assert.deepEqual(run('see https://www.charter.example'), []);
  assert.deepEqual(run('see https://charter.example/x.'), []);
  assert.deepEqual(run('(https://charter.example/x)'), []);
  assert.deepEqual(run(`tx https://basescan.org/tx/${HASH}`), []);
  assert.deepEqual(run('https://x.com/charterhq/status/1234567890'), []);
  assert.deepEqual(run('https://twitter.com/CharterHQ/status/1234567890'), []);
});

test('rejects basescan link whose hash is not in txLinks', () => {
  rej(`https://basescan.org/tx/0x${'cd'.repeat(32)}`, 'basescan link not in the fact sheet');
  rej('https://basescan.org/address/0x1', 'basescan link not in the fact sheet');
});

test('rejects x.com links without selfHandle or for another handle', () => {
  rej('https://x.com/charterhq/status/1', 'x.com link', { selfHandle: undefined });
  rej('https://x.com/someoneelse/status/1', 'x.com link');
  rej('https://x.com/charterhq', 'x.com link');
});

test('rejects any other host, including bare domains', () => {
  rej('https://evil.com/x', 'host that is not allowed');
  rej('go to evil.com/x', 'host that is not allowed');
  rej('go to charter.example.evil.com', 'host that is not allowed');
  rej('charter.example/a and evil.com', 'more than one link');
  assert.deepEqual(run('go to charter.example/a'), []);
});

test('rejects a second link hidden inside a link token', () => {
  for (const t of [
    'https://charter.example/a<evil.com',
    'https://charter.example/a"evil.com',
    'https://charter.example/a`evil.com',
    'https://charter.example/a>https://evil.com',
    'charter.example/a<evil.com',
    'charter.example/a"evil.com',
  ]) {
    const r = run(t);
    assert.ok(r.length > 0 && r.some((x) => /link followed by text|more than one link|forbidden character/.test(x)), t);
  }
  rej('https://charter.example/a"evil.com', 'link followed by text');
  rej('https://charter.example/a<evil.com', 'forbidden character');
});

test('rejects userinfo and a nested scheme inside a link', () => {
  rej('https://charter.example@evil.com/x', 'malformed link');
  rej('https://charter.example/x?u=https://evil.com', 'malformed link');
});

test('rejects a domain hidden after punctuation inside a link path', () => {
  for (const t of ["https://charter.example/a!evil.com", "https://charter.example/a'evil.com", 'https://charter.example/?u=evil.com']) rej(t, 'malformed link');
  assert.deepEqual(run('https://charter.example/a/b.html?x=1'), []);
});

test('rejects forbidden characters anywhere', () => {
  for (const c of ['<', '>', '`', '{', '}', '|', '\\', '^']) rej(`a ${c} b`, 'forbidden character');
});

test('rejects @handles not in mentionable and not replyToHandle', () => {
  assert.deepEqual(run('thanks @alice'), []);
  assert.deepEqual(run('thanks @ALICE'), []);
  rej('thanks @bob', 'not allowed to be mentioned');
  assert.deepEqual(run('thanks @bob', { replyToHandle: 'Bob' }), []);
  rej('mail me@evil.com', 'not allowed to be mentioned');
});

test('rejects banned words case-insensitively as whole words', () => {
  rej('a Token here', 'banned word');
  rej('a TOKEN here', 'banned word');
  rej('a token-gated door', 'banned word');
  rej('TOON rules', 'banned word');
  assert.deepEqual(run('a tokenizer here'), []);
});

test('rejects inflected banned words: plural, past and -ing forms', () => {
  const all = { rules: { banned: [...DEFAULT_BANNED] } };
  for (const t of ['tokens', 'escaped', 'escapes', 'jailbreaking', 'toons', 'airdrops', 'guaranteed']) rej(`a ${t} here`, 'banned word', all);
  for (const ok of ['tokenizer', 'cartoon', 'cartoons']) assert.deepEqual(run(`a ${ok} here`, all), [], ok);
});

test('rejects spaced-out and split banned words', () => {
  const forms = ['t o k e n', 't.o.k.e.n', 't  o  k  e  n', 't-o-k-e-n', 't_o_k_e_n', 't/o/k/e/n', 't*o*k*e*n',
    't,o,k,e,n', 't+o+k+e+n', 't~o~k~e~n', "t'o'k'e'n", 't:o:k:e:n', 't;o;k;e;n', 't=o=k=e=n', 't!o!k!e!n',
    't(o)k(e)n', 't"o"k"e"n', 't&o&k&e&n', 't%o%k%e%n', 'to ken', 't oken', 'to-ken', 'token_x'];
  for (const t of forms) rej(`a ${t} here`, 'banned word');
  for (const ok of ['tokenizer', 'go to kensington', 'cartoon']) assert.deepEqual(run(ok), [], ok);
});

test('rejects a second link hidden behind a bracket or parenthesis', () => {
  for (const t of [
    'https://charter.example/a)evil.com',
    'https://charter.example/a(evil.com',
    'charter.example/a)evil.com',
    'charter.example/a(evil.com',
    'see https://charter.example/a)evil.com/x now',
    'https://charter.example/x]',
    'https://charter.example/x[y',
  ]) rej(t, 'link followed by text');
});

test('rejects non-ASCII look-alike and fullwidth characters in domains and sigils', () => {
  rej('go to \u0430charter.example', 'non-ASCII character');
  rej('go to charter.example.\u0440\u0444', 'non-ASCII character');
  rej('go to \u043F\u0440\u0438\u043C\u0435\u0440.\u0440\u0444', 'non-ASCII character');
  for (const c of ['\uFF20', '\uFF03', '\uFF04', '\uFE69']) rej(`a ${c}x b`, 'non-ASCII character');
});

test('rejects non-ASCII digits', () => {
  for (const d of ['\u0661\u0662', '\uFF11\uFF12', '\u00B9\u00B2', '\u246B']) rej(`I hold ${d} homes`, 'non-ASCII character');
});

test('rejects look-alike and accented banned words', () => {
  rej('a t\u043Eken here', 'non-ASCII character');
  rej('a a\u0131rdrop here', 'non-ASCII character');
  rej('a t\u00F3ken here', 'non-ASCII character');
});

test('rejects invisible characters, including invisible-only text', () => {
  for (const c of ['\u200B', '\u034F', '\uFE0F', '\u2061', '\u{E0041}']) {
    rej(`a${c}b`, 'non-ASCII character');
    rej(c, 'non-ASCII character');
  }
});

test('rejects all non-ASCII dash look-alikes', () => {
  for (const c of ['\uFE58', '\uFE31', '\uFE32', '\u2E3A', '\u2E3B', '\u2212', '\uFF0D']) rej(`a ${c} b`, 'non-ASCII character');
});

test('rejects a number not in any fact', () => {
  rej('I hold 12 homes', 'number not in the facts');
});

test('ignores digits inside allowed links', () => {
  assert.deepEqual(run(`tx https://basescan.org/tx/${HASH}`), []);
  assert.deepEqual(run('https://x.com/charterhq/status/98765'), []);
});

test('numbers: thousands commas only in proper groups', () => {
  assert.deepEqual(run('0.007 per hour'), []);
  assert.deepEqual(run('1200 hours'), []);
  assert.deepEqual(run('1,200 hours'), []);
  rej('0.008 per hour', 'number not in the facts');
  rej('only 12,00 hours', 'number not in the facts');
  rej('only 1,2 hours', 'number not in the facts');
  const sheet: FactSheet = { ...facts, facts: [{ id: 'f', text: '1200 hours' }] };
  assert.deepEqual(lint('1,200 hours', { ...ctx, facts: sheet }), []);
  const sheet2: FactSheet = { ...facts, facts: [{ id: 'f', text: '1,200 hours' }] };
  const r = lint('only 12,00 hours', { ...ctx, facts: sheet2 });
  assert.ok(r.some((x) => x.includes('number not in the facts')));
});

test('fails closed on empty output', () => {
  rej('', 'empty text');
  rej('   ', 'empty text');
});
