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
});

test('StateStore survives a corrupt file', () => {
  const f = join(dir(), 'state.json');
  writeFileSync(f, '{nope');
  assert.equal(new StateStore(f, () => D1).get().initialized, false);
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
    s.alertedAt = { loop: 99 }; s.mentionSinceId = '55';
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
