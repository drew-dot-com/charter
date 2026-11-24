import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state.js';
import { geminiAllowance, schedule, statusText, timedFetch } from './main.js';

const NOW = Date.UTC(2026, 10, 24, 12);
const store = () => new StateStore(join(mkdtempSync(join(tmpdir(), 'social-main-')), 'state.json'), () => NOW);

test('geminiAllowance counts each call and refuses past the cap', () => {
  const state = store();
  const allow = geminiAllowance(state, 2);
  assert.deepEqual([allow(), allow(), allow()], [true, true, false]);
  assert.equal(state.get().geminiCallsToday, 2);
});

test('timedFetch aborts a call that outlasts its limit', async () => {
  const hang: typeof fetch = (_i, init) =>
    new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  await assert.rejects(timedFetch(20, hang)('https://example.invalid'), (e: Error) => e.name === 'TimeoutError');
});

test('timedFetch keeps a caller signal', async () => {
  const hang: typeof fetch = (_i, init) =>
    new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller'))));
  const ac = new AbortController();
  const p = timedFetch(60_000, hang)('https://example.invalid', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /aborted by caller/);
});

test('statusText says paused or live, DRY_RUN, last post and reply, spend and missing settings', () => {
  const state = store();
  const s = state.update((st) => {
    st.paused = true;
    st.spendUsdToday = 0.25;
    st.heartbeatAt = NOW - 60_000;
    st.log.push({ at: NOW - 1000, kind: 'post', text: 'hello', id: '123' }, { at: NOW - 500, kind: 'reply', text: 'dry run: hi' });
  });
  const text = statusText(s, { dryRun: true, missing: ['X_USER_ID'], spendCapUsdDay: 2, geminiCallsCapDay: 200, now: NOW });
  assert.match(text, /PAUSED/);
  assert.match(text, /DRY_RUN on/);
  assert.match(text, /last post: .*https:\/\/x\.com\/i\/status\/123/);
  assert.match(text, /last reply: .*dry run: hi/);
  assert.match(text, /spend today: 0\.250 of 2 USD/);
  assert.match(text, /missing settings: X_USER_ID/);
  assert.match(statusText(state.update((st) => void (st.paused = false)), { dryRun: false, missing: [], now: NOW }), /live, DRY_RUN off/);
});

test('schedule never overlaps a slow tick and reports a throw', async () => {
  const ac = new AbortController();
  let running = 0;
  let overlap = false;
  let runs = 0;
  const errors: string[] = [];
  schedule('t', 1, 0, async () => {
    running += 1;
    if (running > 1) overlap = true;
    runs += 1;
    await new Promise((r) => setTimeout(r, 15));
    running -= 1;
    if (runs === 2) throw new Error('boom');
  }, async (name, e) => void errors.push(`${name}: ${(e as Error).message}`), ac.signal);
  await new Promise((r) => setTimeout(r, 80));
  ac.abort();
  assert.ok(runs >= 3, `ran ${runs} times`);
  assert.equal(overlap, false);
  assert.deepEqual(errors, ['t: boom']);
});
