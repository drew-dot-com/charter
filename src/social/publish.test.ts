import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state.js';
import { XError, X_PRICE_USD } from './x.js';
import type { Telegram } from './telegram.js';
import {
  publish,
  hasLink,
  MAX_ATTEMPTS,
  MAX_EVENT_POSTS_DAY,
  MAX_REPLIES_AUTHOR_DAY,
  MAX_REPLIES_DAY,
  type PublishDeps,
} from './publish.js';

const NOW = Date.UTC(2026, 10, 24, 12);
const HOUR = 3_600_000;

function fakeTg(opts: { fail?: boolean } = {}): Telegram & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send(text) {
      sent.push(text);
      if (opts.fail) throw new Error('telegram down');
    },
    async updates() {
      return [];
    },
  };
}

function fakeX(opts: { fail?: Error | (() => Error | undefined) } = {}) {
  const posts: { text: string; replyTo?: string }[] = [];
  let n = 0;
  return {
    posts,
    async post(text: string, replyTo?: string): Promise<string> {
      const f = typeof opts.fail === 'function' ? opts.fail() : opts.fail;
      if (f) throw f;
      posts.push({ text, replyTo });
      n += 1;
      return `1900000000000000${n}`;
    },
  };
}

function setup(o: { dryRun?: boolean; cap?: number; heartbeatAgoMs?: number | null; fail?: Error | (() => Error | undefined); tgFail?: boolean; now?: () => number } = {}) {
  let clock = NOW;
  const now = o.now ?? (() => clock);
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'social-pub-')), 'state.json'), now);
  if (o.heartbeatAgoMs !== null) state.update((s) => void (s.heartbeatAt = NOW - (o.heartbeatAgoMs ?? 60_000)));
  const x = fakeX({ fail: o.fail });
  const tg = fakeTg({ fail: o.tgFail });
  const deps: PublishDeps = { state, x, tg, cfg: { dryRun: o.dryRun ?? false, spendCapUsdDay: o.cap ?? 2 }, now };
  return { state, x, tg, deps, setClock: (ms: number) => (clock = ms) };
}

const event = (key: string, text = 'Two leases are running.') => ({ kind: 'event' as const, key, text });
const reply = (n: number, author = 'a1', conversationId = `c${n}`) => ({
  kind: 'reply' as const,
  key: `reply:m${n}`,
  text: 'A home is 0.007 USDC an hour.',
  replyTo: `m${n}`,
  author,
  conversationId,
});

test('constants', () => {
  assert.equal(MAX_EVENT_POSTS_DAY, 4);
  assert.equal(MAX_REPLIES_DAY, 20);
  assert.equal(MAX_REPLIES_AUTHOR_DAY, 2);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('a live event post calls X, records spend and log, and tells Telegram the url', async () => {
  const { deps, x, tg, state } = setup();
  assert.equal(await publish(deps, event('e1')), 'posted');
  assert.deepEqual(x.posts, [{ text: 'Two leases are running.', replyTo: undefined }]);
  const s = state.get();
  assert.equal(s.postsToday, 1);
  assert.equal(s.spendUsdToday, X_PRICE_USD.post);
  assert.equal(s.log.at(-1)?.kind, 'post');
  assert.equal(s.log.at(-1)?.id, '19000000000000001');
  assert.ok(tg.sent.some((m) => m.startsWith('Posted https://x.com/i/status/19000000000000001')));
});

test('publish does nothing when paused', async () => {
  const { deps, x, state } = setup();
  state.update((s) => void (s.paused = true));
  assert.equal(await publish(deps, event('e1')), 'paused');
  assert.equal(await publish(deps, reply(1)), 'paused');
  assert.equal(x.posts.length, 0);
  const s = state.get();
  assert.equal(s.postsToday, 0);
  assert.deepEqual(s.repliedConversations, []);
});

test('publish does nothing when heartbeat is older than 15 minutes, and alerts "kill switch offline" once per hour', async () => {
  const { deps, x, tg, setClock } = setup({ heartbeatAgoMs: 16 * 60_000 });
  assert.equal(await publish(deps, event('e1')), 'kill_switch_offline');
  assert.equal(await publish(deps, reply(1)), 'kill_switch_offline');
  assert.equal(x.posts.length, 0);
  assert.equal(tg.sent.filter((m) => m.includes('kill switch offline')).length, 1);
  setClock(NOW + HOUR + 1);
  assert.equal(await publish(deps, event('e1')), 'kill_switch_offline');
  assert.equal(tg.sent.filter((m) => m.includes('kill switch offline')).length, 2);
});

test('publish does nothing when no heartbeat was ever written', async () => {
  const { deps, x } = setup({ heartbeatAgoMs: null });
  assert.equal(await publish(deps, event('e1')), 'kill_switch_offline');
  assert.equal(x.posts.length, 0);
});

test('a heartbeat at exactly 15 minutes still allows a post', async () => {
  const { deps } = setup({ heartbeatAgoMs: 15 * 60_000 });
  assert.equal(await publish(deps, event('e1')), 'posted');
});

test('the fifth event post of a day is refused', async () => {
  const { deps, x } = setup();
  for (let i = 1; i <= 4; i++) assert.equal(await publish(deps, event(`e${i}`)), 'posted');
  assert.equal(await publish(deps, event('e5')), 'cap');
  assert.equal(x.posts.length, 4);
});

test('a summary is allowed past four', async () => {
  const { deps, state } = setup();
  for (let i = 1; i <= 4; i++) await publish(deps, event(`e${i}`));
  assert.equal(await publish(deps, { kind: 'summary', key: 'summary:2026-W48', text: 'This week: two leases.' }), 'posted');
  assert.equal(state.get().postsToday, 4);
});

test('the spend cap refuses and alerts once', async () => {
  const { deps, x, tg, state } = setup({ cap: 0.02 });
  assert.equal(await publish(deps, event('e1')), 'posted');
  assert.equal(await publish(deps, event('e2')), 'spend_cap');
  assert.equal(await publish(deps, reply(1)), 'spend_cap');
  assert.equal(x.posts.length, 1);
  assert.equal(tg.sent.filter((m) => /spend cap/i.test(m)).length, 1);
  const s = state.get();
  assert.equal(s.capAlerted, true);
  assert.deepEqual(s.repliedConversations, []);
});

test('a post with a link is priced as a URL post', async () => {
  const { deps, x } = setup({ cap: 0.1 });
  assert.equal(await publish(deps, event('e1', 'Receipt: https://basescan.org/tx/0xabc')), 'spend_cap');
  assert.equal(x.posts.length, 0);
});

test('hasLink is conservative', () => {
  assert.equal(hasLink('see https://charter.example'), true);
  assert.equal(hasLink('basescan.org/tx/0x1'), true);
  assert.equal(hasLink('x.com/charter/status/1'), true);
  assert.equal(hasLink('charter.example is up'), true);
  assert.equal(hasLink('Two leases at 0.007 USDC an hour.'), false);
});

test('DRY_RUN never calls x.post', async () => {
  const { deps, x, tg, state } = setup({ dryRun: true });
  assert.equal(await publish(deps, event('e1')), 'dry_run');
  assert.equal(await publish(deps, reply(1)), 'dry_run');
  assert.equal(x.posts.length, 0);
  assert.ok(tg.sent.some((m) => m.startsWith('would post: Two leases are running.')));
  assert.ok(tg.sent.some((m) => m.startsWith('would reply: A home is 0.007 USDC an hour.')));
  const s = state.get();
  assert.equal(s.postsToday, 1, 'a dry-run post counts as done');
  assert.equal(s.repliesToday, 1);
  assert.equal(s.spendUsdToday, 0);
});

test('only dryRun === false posts live', async () => {
  const { deps, x } = setup();
  const loose = { ...deps, cfg: { ...deps.cfg, dryRun: undefined as unknown as boolean } };
  assert.equal(await publish(loose, event('e1')), 'dry_run');
  assert.equal(x.posts.length, 0);
});

test('a reply reserves its conversation and counters before the X call, and keeps them when X fails', async () => {
  let seen: unknown;
  const { deps, state } = setup({
    fail: () => {
      const s = state.get();
      seen = { conv: s.repliedConversations, replies: s.repliesToday, author: s.authorRepliesToday.a1 };
      return new XError('X POST /2/tweets failed with 503', 503);
    },
  });
  assert.equal(await publish(deps, reply(1)), 'failed');
  assert.deepEqual(seen, { conv: ['c1'], replies: 1, author: 1 });
  const s = state.get();
  assert.deepEqual(s.repliedConversations, ['c1']);
  assert.equal(s.repliesToday, 1);
  assert.equal(s.spendUsdToday, 0, 'a failed call is not spend');
});

test('a reply into a reserved conversation, a 21st reply and a third reply to one author are refused', async () => {
  const { deps, x, state } = setup({ cap: 100 });
  assert.equal(await publish(deps, reply(1, 'a1', 'c1')), 'posted');
  assert.equal(await publish(deps, { ...reply(2, 'a2', 'c1') }), 'cap');
  assert.equal(await publish(deps, reply(3, 'a1', 'c3')), 'posted');
  assert.equal(await publish(deps, reply(4, 'a1', 'c4')), 'cap');
  state.update((s) => void (s.repliesToday = 20));
  assert.equal(await publish(deps, reply(5, 'a5', 'c5')), 'cap');
  assert.equal(x.posts.length, 2);
});

test('a reply missing its conversation, author or target is refused', async () => {
  const { deps, x } = setup();
  assert.equal(await publish(deps, { ...reply(1), conversationId: '' }), 'failed');
  assert.equal(await publish(deps, { ...reply(1), author: undefined }), 'failed');
  assert.equal(await publish(deps, { ...reply(1), replyTo: undefined }), 'failed');
  assert.equal(x.posts.length, 0);
});

test('an XError retries up to 3 attempts then alerts and stops', async () => {
  const { deps, x, tg, state } = setup({ fail: new XError('X POST /2/tweets failed with 429', 429) });
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    assert.equal(await publish(deps, event('e1')), 'failed');
    assert.equal(state.get().attempts.e1, i);
  }
  assert.equal(tg.sent.filter((m) => m.startsWith('gave up')).length, 1);
  assert.match(tg.sent.find((m) => m.startsWith('gave up')) ?? '', /e1.*429/);
  // Done: a later call never reaches X, even once X recovers.
  const calls = x.posts.length;
  assert.equal(await publish({ ...deps, x: fakeX() }, event('e1')), 'failed');
  assert.equal(x.posts.length, calls);
  assert.equal(state.get().attempts.e1, MAX_ATTEMPTS);
  assert.equal(state.get().postsToday, 0, 'a failed event post is not counted');
});

test('a network error counts as an attempt too', async () => {
  const { deps, state } = setup({ fail: new TypeError('fetch failed') });
  assert.equal(await publish(deps, event('e1')), 'failed');
  assert.equal(state.get().attempts.e1, 1);
});

test('a throwing Telegram never changes the result', async () => {
  const live = setup({ tgFail: true });
  assert.equal(await publish(live.deps, event('e1')), 'posted');
  const stale = setup({ tgFail: true, heartbeatAgoMs: HOUR });
  assert.equal(await publish(stale.deps, event('e1')), 'kill_switch_offline');
  const dry = setup({ tgFail: true, dryRun: true });
  assert.equal(await publish(dry.deps, event('e1')), 'dry_run');
  const bad = setup({ tgFail: true, fail: new XError('nope', 500) });
  assert.equal(await publish(bad.deps, event('e1')), 'failed');
});

test('a state write that fails posts nothing', async () => {
  const { deps, x } = setup();
  const broken = { ...deps, state: { get: deps.state.get.bind(deps.state), update: () => { throw new Error('disk full'); } } as unknown as StateStore };
  assert.equal(await publish(broken, event('e1')), 'failed');
  assert.equal(x.posts.length, 0);
});
