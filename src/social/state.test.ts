import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'social-state-'));
const D1 = Date.UTC(2026, 10, 24, 12);
const D2 = Date.UTC(2026, 10, 25, 1);

test('StateStore survives a missing file', () => {
  const s = new StateStore(join(dir(), 'state.json'), () => D1).get();
  assert.equal(s.initialized, false);
  assert.deepEqual(s.seen, []);
  assert.equal(s.day, '2026-11-24');
  assert.equal(s.postsToday, 0);
  assert.equal(s.paused, false);
  assert.equal(s.mentionsInitialized, false);
});

test('a missing file is a fresh, unpaused state', () => {
  assert.equal(new StateStore(join(dir(), 'state.json'), () => D1).get().paused, false);
});

test('a corrupt file is set aside and the bot comes up paused', () => {
  const d = dir();
  const f = join(d, 'state.json');
  writeFileSync(f, '{nope');
  const s = new StateStore(f, () => D1).get();
  assert.equal(s.paused, true);
  assert.equal(s.initialized, false);
  assert.ok(readdirSync(d).some((n) => n.startsWith('state.json.corrupt-')));
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).paused, true);
});

test('a wrong root type is treated as corrupt', () => {
  const d = dir();
  const f = join(d, 'state.json');
  writeFileSync(f, '[1,2]');
  assert.equal(new StateStore(f, () => D1).get().paused, true);
  assert.ok(readdirSync(d).some((n) => n.startsWith('state.json.corrupt-')));
});

test('wrong-typed fields fall back to fresh defaults; a bad paused falls back to true', () => {
  const f = join(dir(), 'state.json');
  writeFileSync(f, JSON.stringify({
    initialized: true, day: '2026-11-24', seen: 5, repliedConversations: [1], week: null, log: 'x',
    attempts: { a: 'x' }, postsToday: 'many', paused: 'no', alertedAt: [], authorRepliesToday: null,
  }));
  const s = new StateStore(f, () => D1).get();
  assert.equal(s.initialized, true);
  assert.deepEqual(s.seen, []);
  assert.deepEqual(s.repliedConversations, []);
  assert.deepEqual(s.week, { key: '', hoursPaidAtStart: 0, summaryPosted: false, reportSent: false });
  assert.deepEqual(s.log, []);
  assert.deepEqual(s.attempts, {});
  assert.deepEqual(s.alertedAt, {});
  assert.deepEqual(s.authorRepliesToday, {});
  assert.equal(s.postsToday, 0);
  assert.equal(s.paused, true);
});

test('an absent paused stays false and well-typed fields are kept', () => {
  const f = join(dir(), 'state.json');
  writeFileSync(f, JSON.stringify({ seen: ['a'], attempts: { a: 2 }, log: [{ at: 1, kind: 'post', text: 't' }] }));
  const s = new StateStore(f, () => D1).get();
  assert.equal(s.paused, false);
  assert.deepEqual(s.seen, ['a']);
  assert.deepEqual(s.attempts, { a: 2 });
  assert.equal(s.log.length, 1);
});

test('StateStore rewrites atomically: a temp file then a rename, nothing left behind', () => {
  const d = dir();
  const f = join(d, 'state.json');
  const st = new StateStore(f, () => D1);
  const out = st.update((s) => { s.initialized = true; s.seen.push('e1'); });
  assert.equal(out.initialized, true);
  assert.deepEqual(readdirSync(d), ['state.json']);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).seen[0], 'e1');
  assert.equal(existsSync(`${f}.tmp`), false);
  assert.equal(new StateStore(f, () => D1).get().seen[0], 'e1');
});

test('update re-reads the file, so two stores sharing it do not lose writes', () => {
  const f = join(dir(), 'state.json');
  const a = new StateStore(f, () => D1);
  const b = new StateStore(f, () => D1);
  a.update((s) => { s.seen.push('a'); });
  b.update((s) => { s.seen.push('b'); });
  assert.deepEqual(a.get().seen, ['a', 'b']);
});

test('StateStore resets day counters on a new UTC day but keeps the long-lived fields', () => {
  const f = join(dir(), 'state.json');
  let now = D1;
  const st = new StateStore(f, () => now);
  st.update((s) => {
    s.postsToday = 4; s.repliesToday = 9; s.authorRepliesToday = { a: 2 };
    s.spendUsdToday = 1.5; s.geminiCallsToday = 77; s.capAlerted = true;
    s.paused = true; s.heartbeatAt = 123; s.seen = ['x']; s.repliedConversations = ['c1'];
    s.alertedAt = { loop: 99 }; s.mentionSinceId = '55'; s.mentionsInitialized = true;
    s.week = { key: '2026-W48', hoursPaidAtStart: 10, summaryPosted: true, reportSent: true };
  });
  now = D2;
  const s = st.get();
  assert.equal(s.day, '2026-11-25');
  assert.equal(s.postsToday, 0);
  assert.equal(s.repliesToday, 0);
  assert.deepEqual(s.authorRepliesToday, {});
  assert.equal(s.spendUsdToday, 0);
  assert.equal(s.geminiCallsToday, 0);
  assert.equal(s.capAlerted, false);
  assert.equal(s.paused, true);
  assert.equal(s.heartbeatAt, 123);
  assert.deepEqual(s.seen, ['x']);
  assert.deepEqual(s.repliedConversations, ['c1']);
  assert.deepEqual(s.alertedAt, { loop: 99 });
  assert.equal(s.mentionSinceId, '55');
  assert.equal(s.mentionsInitialized, true);
  assert.deepEqual(s.week, { key: '2026-W48', hoursPaidAtStart: 10, summaryPosted: true, reportSent: true });
});

test('StateStore keeps only the last 500 log rows', () => {
  const st = new StateStore(join(dir(), 'state.json'), () => D1);
  st.update((s) => { for (let i = 0; i < 520; i++) s.log.push({ at: i, kind: 'post', text: `t${i}` }); });
  const s = st.get();
  assert.equal(s.log.length, 500);
  assert.equal(s.log[0]?.text, 't20');
  assert.equal(s.log[499]?.text, 't519');
});

test('the paused state written after a corrupt file survives further reads and new stores', () => {
  const d = dir();
  const f = join(d, 'state.json');
  writeFileSync(f, '{nope');
  const st = new StateStore(f, () => D1);
  assert.equal(st.get().paused, true);
  assert.equal(st.get().paused, true);
  assert.equal(new StateStore(f, () => D1).get().paused, true);
  assert.ok(readdirSync(d).some((n) => n.startsWith('state.json.corrupt-')));
});

test('mentionsInitialized: a wrong type falls back, and a file from before the field counts a stored since id as initialized', () => {
  const d = dir();
  const f = join(d, 'state.json');
  writeFileSync(f, JSON.stringify({ mentionsInitialized: 'yes', day: '2026-11-24' }));
  assert.equal(new StateStore(f, () => D1).get().mentionsInitialized, false);
  writeFileSync(f, JSON.stringify({ mentionSinceId: '55', day: '2026-11-24' }));
  assert.equal(new StateStore(f, () => D1).get().mentionsInitialized, true);
  writeFileSync(f, JSON.stringify({ mentionsInitialized: false, mentionSinceId: '55', day: '2026-11-24' }));
  assert.equal(new StateStore(f, () => D1).get().mentionsInitialized, false);
});
