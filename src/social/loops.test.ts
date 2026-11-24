import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, type SocialState } from './state.js';
import type { Mention } from './x.js';
import { handleCommand, type Telegram } from './telegram.js';
import type { Model } from './model.js';
import type { SocialConfig } from './config.js';
import { DEFAULT_BANNED, type ConfigFiles } from './files.js';
import { readSources } from './sources.js';
import type { LoopDeps } from './replies.js';
import { eventTick, isoWeekKey, mentionTick, weeklyTick } from './loops.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 12); // Tuesday
const RENTER = '0x1111111111111111111111111111111111111111';
const SELF = '999';

function lease(o: Record<string, unknown> = {}) {
  return {
    leaseId: 'L1',
    offerId: 'h1:o1',
    payer: RENTER,
    ticksPaidByRenter: 1,
    ticksPaidToHost: 1,
    losses: '0',
    stopped: false,
    createdAt: NOW - 2 * HOUR,
    nextIndex: 1,
    hostReads: 0,
    lastTickAt: NOW - 60_000,
    offer: { intervalSeconds: 3600, tickPrice: '7000' },
    ...o,
  };
}

function writeData(dir: string, o: { leases?: unknown[]; grants?: unknown[]; hosts?: unknown[]; raw?: string }): void {
  writeFileSync(join(dir, 'door-ledger.json'), o.raw ?? JSON.stringify(o.leases ?? []));
  writeFileSync(join(dir, 'grants.jsonl'), (o.grants ?? []).map((g) => JSON.stringify(g)).join('\n'));
  writeFileSync(join(dir, 'hosts.json'), JSON.stringify({ hosts: o.hosts ?? [] }));
}

function fakeTg(): Telegram & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send(text) {
      sent.push(text);
    },
    async updates() {
      return [];
    },
  };
}

function fakeX() {
  const posts: { text: string; replyTo?: string }[] = [];
  const reads: (string | undefined)[] = [];
  let next: { mentions: Mention[]; newestId?: string } = { mentions: [] };
  return {
    posts,
    reads,
    setMentions(m: { mentions: Mention[]; newestId?: string }) {
      next = m;
    },
    async post(text: string, replyTo?: string) {
      posts.push({ text, replyTo });
      return String(1900000000000000000n + BigInt(posts.length));
    },
    async delete() {},
    async mentions(sinceId?: string) {
      reads.push(sinceId);
      return next;
    },
  };
}

const POST = 'A renter came back for more.';
const SUMMARY = 'Weekly totals are in.';
const REPLY = 'A home is cheap.';

function fakeModel(o: { write?: unknown } = {}): Model & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async json<T>(_model: string, prompt: string): Promise<T> {
      prompts.push(prompt);
      if (prompt.startsWith('Label the mention')) return { label: 'question' } as T;
      if (prompt.startsWith('Draft three')) {
        if (o.write !== undefined) return o.write as T;
        const text = prompt.includes('Weekly summary') ? SUMMARY : prompt.includes('Task: a reply') ? REPLY : POST;
        return { candidates: [text] } as T;
      }
      if (prompt.startsWith('Check every claim')) return { claims: [{ claim: 'it', factId: 'totals:hosts' }] } as T;
      throw new Error(`unexpected prompt: ${prompt.slice(0, 30)}`);
    },
  };
}

const cfg: SocialConfig = {
  x: { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'u', userId: SELF },
  gemini: { apiKey: 'g', modelWrite: 'gemini-write', modelCheck: 'gemini-check' },
  telegram: { token: 'tok', chatId: '42' },
  firstParty: new Set(['0xfund']),
  probes: new Set(['0xprobe']),
  siteUrl: 'https://charter.example',
  doorUrl: 'http://door',
  dataDir: '/data',
  stateDir: '/state',
  configDir: '/config',
  dryRun: false,
  spendCapUsdDay: 2,
  geminiCallsCapDay: 200,
};

const files = (): ConfigFiles => ({ factsMd: '', rules: { banned: [...DEFAULT_BANNED] }, optins: { renters: {}, grants: {}, hosts: {} }, blocklist: new Set() });

function setup(o: { model?: Model; leases?: unknown[]; grants?: unknown[]; hosts?: unknown[]; files?: () => ConfigFiles } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'social-loops-data-'));
  writeData(dataDir, { leases: o.leases ?? [], grants: o.grants, hosts: o.hosts });
  const clock = { now: NOW };
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'social-loops-state-')), 'state.json'), () => clock.now);
  const x = fakeX();
  const tg = fakeTg();
  const model = (o.model ?? fakeModel()) as Model & { prompts: string[] };
  const deps: LoopDeps = {
    state,
    x,
    tg,
    cfg,
    now: () => clock.now,
    files: o.files ?? files,
    model,
    sources: () => readSources(dataDir),
    offers: async () => [],
  };
  const beat = () => state.update((s) => void (s.heartbeatAt = clock.now));
  beat();
  return { deps, x, tg, state, model, clock, dataDir, beat, write: (d: Parameters<typeof writeData>[1]) => writeData(dataDir, d) };
}

// eventTick

test('the first eventTick posts nothing and marks everything seen', async () => {
  const t = setup({ leases: [lease({ ticksPaidByRenter: 30 })] });
  await eventTick(t.deps);
  const s = t.state.get();
  assert.equal(s.initialized, true);
  assert.ok(s.seen.includes('returned:L1'));
  assert.ok(s.seen.includes('milestone:L1:24'));
  assert.equal(t.x.posts.length, 0);
  assert.equal(t.model.prompts.length, 0);
});

test('a new second-hour lease produces one post', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 2 })] });
  await eventTick(t.deps);
  assert.deepEqual(t.x.posts, [{ text: POST, replyTo: undefined }]);
  assert.ok(t.state.get().seen.includes('returned:L1'));
  assert.ok(t.model.prompts.some((p) => p.startsWith('Draft three') && p.includes('renter_returned')));
});

test('running eventTick twice posts once', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 2 })] });
  await eventTick(t.deps);
  await eventTick(t.deps);
  assert.equal(t.x.posts.length, 1);
});

test('an event older than 6 hours is marked seen, not posted', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 120, lastTickAt: NOW - 7 * HOUR })] });
  await eventTick(t.deps);
  const s = t.state.get();
  assert.equal(t.x.posts.length, 0);
  assert.equal(t.model.prompts.length, 0);
  assert.ok(s.seen.includes('returned:L1'));
  assert.ok(s.seen.includes('milestone:L1:100'));
  assert.ok(s.seen.includes('milestone:L1:24'), 'the implied lower milestone is seen too');
  assert.ok(s.log.some((r) => r.kind === 'skip' && /stale/.test(r.text)));
});

test('a paused state leaves the event unseen and posts it after /resume', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 2 })] });
  t.state.update((s) => void (s.paused = true));
  await eventTick(t.deps);
  assert.equal(t.x.posts.length, 0);
  assert.equal(t.model.prompts.length, 0, 'no Gemini call while paused');
  assert.ok(!t.state.get().seen.includes('returned:L1'));

  const reply = await handleCommand({ text: '/resume', chatId: '42', date: Math.floor(NOW / 1000) }, { state: t.state, x: t.x, chatId: '42', now: NOW, status: () => '' });
  assert.equal(reply, 'Resumed.');
  await eventTick(t.deps);
  assert.equal(t.x.posts.length, 1);
  assert.ok(t.state.get().seen.includes('returned:L1'));
});

test('a stale heartbeat leaves the event unseen, spends no Gemini call and alerts once an hour', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 2 })] });
  t.state.update((s) => void (s.heartbeatAt = NOW - 20 * 60_000));
  await eventTick(t.deps);
  await eventTick(t.deps);
  assert.equal(t.model.prompts.length, 0);
  assert.ok(!t.state.get().seen.includes('returned:L1'));
  assert.equal(t.tg.sent.filter((m) => m.startsWith('kill switch offline')).length, 1);
});

test('a truncated ledger skips the tick and changes no state', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  const before = t.state.get();
  t.write({ raw: '[{"leaseId":"L1","payer":' });
  await eventTick(t.deps);
  await eventTick(t.deps);
  const after = t.state.get();
  const strip = (s: SocialState) => ({ ...s, alertedAt: {} });
  assert.deepEqual(strip(after), strip(before));
  assert.equal(t.x.posts.length, 0);
  assert.equal(t.tg.sent.length, 1, 'one note per hour at most');
  assert.match(t.tg.sent[0]!, /^event loop skipped: /);
});

test('an event refused for the daily cap is marked seen without a Gemini call', async () => {
  const t = setup({ leases: [lease()] });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 2 })] });
  t.state.update((s) => void (s.postsToday = 4));
  await eventTick(t.deps);
  assert.equal(t.x.posts.length, 0);
  assert.equal(t.model.prompts.length, 0);
  assert.ok(t.state.get().seen.includes('returned:L1'));
});

test('a dropped composition tells Drew and marks the event seen', async () => {
  const t = setup({ leases: [lease()], model: fakeModel({ write: { candidates: [] } }) });
  await eventTick(t.deps);
  t.write({ leases: [lease({ ticksPaidByRenter: 2 })] });
  await eventTick(t.deps);
  assert.equal(t.x.posts.length, 0);
  assert.ok(t.tg.sent.some((m) => m.startsWith('post dropped: returned:L1: ')));
  assert.ok(t.state.get().seen.includes('returned:L1'));
});

test('a first listing of a host that is now dropped or hidden is marked seen, not posted', async () => {
  const host = (id: string, state: string) => ({ hostId: id, url: 'https://h', state, registeredAt: NOW - HOUR, probes: { passed: 1, failed: 0, consecutiveFailed: 0, lastAt: NOW - 60_000 }, leases: { opened: 0, finished: 0, hostFailed: 0, consecutiveHostFailed: 0 }, intervalsPaid: 0, homeTested: false });
  const t = setup({});
  await eventTick(t.deps);
  t.write({ hosts: [host('H1', 'dropped'), host('H2', 'hidden'), host('H3', 'listed')] });
  await eventTick(t.deps);
  const s = t.state.get();
  assert.ok(s.seen.includes('host:H1') && s.seen.includes('host:H2') && s.seen.includes('host:H3'));
  assert.equal(t.x.posts.length, 1, 'only the listed host is posted');
});

test('config files that do not load skip the event tick with one hourly alert', async () => {
  const t = setup({ leases: [lease()], files: () => { throw new SyntaxError('Unexpected token in optins.json'); } });
  await eventTick(t.deps);
  await eventTick(t.deps);
  assert.equal(t.state.get().initialized, false);
  assert.equal(t.tg.sent.length, 1);
  assert.match(t.tg.sent[0]!, /config files do not load/);
});

// mentionTick

const mention = (id: string, o: Partial<Mention> = {}): Mention => ({ id, text: '@charterbox how much is a home?', authorId: `a${id}`, authorHandle: `user${id}`, conversationId: `c${id}`, createdAt: NOW - 60_000, ...o });

test('the first mentionTick replies to nothing and stores newestId', async () => {
  const t = setup({});
  t.x.setMentions({ mentions: [mention('150'), mention('200')], newestId: '200' });
  await mentionTick(t.deps);
  const s = t.state.get();
  assert.equal(s.mentionSinceId, '200');
  assert.equal(t.model.prompts.length, 0);
  assert.equal(t.x.posts.length, 0);
  assert.ok(Math.abs(s.spendUsdToday - 0.01) < 1e-9, 'two returned mentions are paid reads');
});

test('a later mentionTick replies oldest first and advances the since id', async () => {
  const t = setup({});
  t.state.update((s) => {
    s.mentionsInitialized = true;
    s.mentionSinceId = '100';
  });
  t.x.setMentions({ mentions: [mention('300'), mention('200')], newestId: '300' });
  await mentionTick(t.deps);
  assert.deepEqual(t.x.reads, ['100']);
  assert.deepEqual(t.x.posts.map((p) => p.replyTo), ['200', '300']);
  assert.equal(t.state.get().mentionSinceId, '300');
});

test('an empty first mentions read still initializes, so the next mention is answered', async () => {
  const t = setup({});
  await mentionTick(t.deps);
  const s = t.state.get();
  assert.equal(s.mentionsInitialized, true);
  assert.equal(s.mentionSinceId, undefined);
  t.x.setMentions({ mentions: [mention('500')], newestId: '500' });
  await mentionTick(t.deps);
  assert.deepEqual(t.x.reads, [undefined, undefined]);
  assert.deepEqual(t.x.posts, [{ text: REPLY, replyTo: '500' }]);
  assert.equal(t.state.get().mentionSinceId, '500');
});

test('a pause that lands during a compose keeps the cursor before that mention', async () => {
  const base = fakeModel();
  let state: StateStore | undefined;
  let pausedOnce = false;
  const model: Model & { prompts: string[] } = {
    prompts: base.prompts,
    async json<T>(m: string, prompt: string, system?: string): Promise<T> {
      if (!pausedOnce && prompt.startsWith('Draft three') && prompt.includes('From: @user202')) {
        pausedOnce = true;
        state!.update((s) => void (s.paused = true));
      }
      return base.json<T>(m, prompt, system);
    },
  };
  const t = setup({ model });
  state = t.state;
  t.state.update((s) => {
    s.mentionsInitialized = true;
    s.mentionSinceId = '100';
  });
  t.x.setMentions({ mentions: [mention('201'), mention('202'), mention('203')], newestId: '203' });
  await mentionTick(t.deps);
  assert.deepEqual(t.x.posts.map((p) => p.replyTo), ['201']);
  assert.equal(t.state.get().mentionSinceId, '201');

  await handleCommand({ text: '/resume', chatId: '42', date: Math.floor(NOW / 1000) }, { state: t.state, x: t.x, chatId: '42', now: NOW, status: () => '' });
  t.x.setMentions({ mentions: [mention('203'), mention('202')], newestId: '203' });
  await mentionTick(t.deps);
  assert.deepEqual(t.x.reads, ['100', '201']);
  assert.deepEqual(t.x.posts.map((p) => p.replyTo), ['201', '202', '203']);
  assert.equal(t.state.get().mentionSinceId, '203');
});

test('a paused mentionTick reads nothing and keeps the since id', async () => {
  const t = setup({});
  t.state.update((s) => {
    s.mentionSinceId = '100';
    s.paused = true;
  });
  t.x.setMentions({ mentions: [mention('200')], newestId: '200' });
  await mentionTick(t.deps);
  assert.deepEqual(t.x.reads, []);
  assert.equal(t.state.get().mentionSinceId, '100');
});

test('a mentionTick at the spend cap reads nothing and alerts once', async () => {
  const t = setup({});
  t.state.update((s) => {
    s.mentionSinceId = '100';
    s.spendUsdToday = 2;
  });
  await mentionTick(t.deps);
  await mentionTick(t.deps);
  assert.deepEqual(t.x.reads, []);
  assert.equal(t.tg.sent.filter((m) => m.startsWith('spend cap reached')).length, 1);
});

// weeklyTick

test('isoWeekKey follows ISO 8601', () => {
  assert.equal(isoWeekKey(Date.UTC(2026, 10, 23, 15)), '2026-W48');
  assert.equal(isoWeekKey(Date.UTC(2026, 10, 22, 23)), '2026-W47');
  assert.equal(isoWeekKey(Date.UTC(2027, 0, 1)), '2026-W53');
  assert.equal(isoWeekKey(Date.UTC(2025, 11, 29)), '2026-W01');
});

test('weeklyTick posts one summary per ISO week and sends one report', async () => {
  const t = setup({ leases: [lease({ ticksPaidByRenter: 5 }), lease({ leaseId: 'LF', payer: '0xfund', ticksPaidByRenter: 50 })] });
  const at = async (ms: number) => {
    t.clock.now = ms;
    t.beat();
    await weeklyTick(t.deps);
  };
  const reports = () => t.tg.sent.filter((m) => m.startsWith('Weekly report')).length;

  await at(Date.UTC(2026, 10, 22, 12)); // Sunday: first run takes the snapshot
  assert.equal(t.state.get().week.hoursPaidAtStart, 5, 'first-party hours are left out');
  t.write({ leases: [lease({ ticksPaidByRenter: 9 }), lease({ leaseId: 'LF', payer: '0xfund', ticksPaidByRenter: 80 })] });

  await at(Date.UTC(2026, 10, 23, 12));
  assert.equal(reports(), 0);
  assert.equal(t.x.posts.length, 0);
  await at(Date.UTC(2026, 10, 23, 13, 5));
  assert.equal(reports(), 1);
  assert.equal(t.x.posts.length, 0);
  await at(Date.UTC(2026, 10, 23, 15, 5));
  assert.deepEqual(t.x.posts, [{ text: SUMMARY, replyTo: undefined }]);
  assert.ok(t.model.prompts.some((p) => p.includes('Hours paid by outside renters this week: 4.')));
  await at(Date.UTC(2026, 10, 23, 15, 10));
  await at(Date.UTC(2026, 10, 24, 15, 10));
  assert.equal(reports(), 1);
  assert.equal(t.x.posts.length, 1);
  assert.equal(t.state.get().week.hoursPaidAtStart, 9);

  await at(Date.UTC(2026, 10, 30, 16));
  assert.equal(reports(), 2);
  assert.equal(t.x.posts.length, 2);
});

test('the weekly report counts posts, replies and mention skips by reason from the log', async () => {
  const t = setup({});
  const monday = Date.UTC(2026, 10, 23, 13, 5);
  t.state.update((s) => {
    s.week = { key: '2026-W48', hoursPaidAtStart: 0, summaryPosted: true, reportSent: false };
    s.log.push(
      { at: monday - HOUR, kind: 'post', text: 'a post', id: '1' },
      { at: monday - HOUR, kind: 'reply', text: 'dry run: a reply' },
      { at: monday - HOUR, kind: 'skip', text: 'mention 5: too old', id: '5' },
      { at: monday - HOUR, kind: 'skip', text: 'mention 6: pre-filter: token', id: '6' },
      { at: monday - HOUR, kind: 'skip', text: 'mention 7: pre-filter: airdrop', id: '7' },
      { at: monday - 8 * 24 * HOUR, kind: 'post', text: 'last week', id: '0' },
    );
  });
  t.clock.now = monday;
  t.beat();
  await weeklyTick(t.deps);
  const report = t.tg.sent.find((m) => m.startsWith('Weekly report'));
  assert.ok(report);
  assert.match(report, /posts: 1/);
  assert.match(report, /replies: 1/);
  assert.match(report, /mentions seen: 4/);
  assert.match(report, /pre-filter 2/);
  assert.match(report, /too old 1/);
  assert.match(report, /spend today: 0\.000 of 2 USD/);
});
