import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state.js';
import type { Mention } from './x.js';
import type { Telegram } from './telegram.js';
import { GeminiCapError, type Model } from './model.js';
import type { SocialConfig } from './config.js';
import { DEFAULT_BANNED, loadConfigFiles, type ConfigFiles, type LeadsConfig } from './files.js';
import { SelfOptinStore } from './optin.js';
import { readSources } from './sources.js';
import { intentUrl, leadGate, leadMessage, leadsTick, type LeadsDeps } from './leads.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 26, 12);
const SELF = '999';
const DRAFT = 'I rent homes to agents, by the hour. https://charter.example';

const post = (o: Partial<Mention> = {}): Mention => ({ id: '100', text: 'where do I host my agent?', authorId: 'a1', authorHandle: 'ada', conversationId: '100', createdAt: NOW - HOUR, ...o });

const cfg: SocialConfig = {
  x: { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'u', userId: SELF },
  gemini: { apiKey: 'g', modelWrite: 'gemini-write', modelCheck: 'gemini-check' },
  telegram: { token: 'tok', chatId: '42' },
  firstParty: new Set(['0xfund']),
  probes: new Set(),
  siteUrl: 'https://charter.example',
  doorUrl: 'http://door',
  dataDir: '/data',
  stateDir: '/state',
  configDir: '/config',
  dryRun: false,
  spendCapUsdDay: 2,
  geminiCallsCapDay: 200,
};

const LEADS: LeadsConfig = { queries: ['host my agent'], maxPerDay: 5, maxReadsPerDay: 40, everyHours: 6 };
const filesWith = (leads?: LeadsConfig, o: Partial<ConfigFiles> = {}) => (): ConfigFiles =>
  ({ factsMd: '', rules: { banned: [...DEFAULT_BANNED] }, optins: { renters: {}, grants: {}, hosts: {} }, blocklist: new Set(), ...(leads ? { leads } : {}), ...o });

function fakeModel(o: { lead?: (prompt: string) => unknown; write?: unknown; capOnLead?: boolean } = {}): Model & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async json<T>(_model: string, prompt: string): Promise<T> {
      prompts.push(prompt);
      if (prompt.startsWith('Judge the post')) {
        if (o.capOnLead) throw new GeminiCapError();
        return (o.lead ? o.lead(prompt) : { lead: true }) as T;
      }
      if (prompt.startsWith('Draft three')) return (o.write ?? { candidates: [DRAFT] }) as T;
      if (prompt.startsWith('Check every claim')) return { claims: [{ claim: 'it', factId: 'totals:hosts' }] } as T;
      throw new Error(`unexpected prompt: ${prompt.slice(0, 30)}`);
    },
  };
}

function setup(o: { model?: Model; files?: () => ConfigFiles; results?: Record<string, { posts: Mention[]; newestId?: string }> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'social-leads-data-'));
  writeFileSync(join(dataDir, 'door-ledger.json'), '[]');
  const clock = { now: NOW };
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'social-leads-state-')), 'state.json'), () => clock.now);
  const sent: string[] = [];
  const tg: Telegram = { async send(t) { sent.push(t); }, async updates() { return []; } };
  const searches: { query: string; sinceId?: string }[] = [];
  const posts: string[] = [];
  const results = o.results ?? { 'host my agent': { posts: [post()], newestId: '100' } };
  const x = {
    async post(text: string) { posts.push(text); return '1'; },
    async delete() {},
    async mentions() { return { mentions: [] }; },
    async search(query: string, sinceId?: string) { searches.push({ query, sinceId }); return results[query] ?? { posts: [] }; },
  };
  const model = (o.model ?? fakeModel()) as Model & { prompts: string[] };
  const deps: LeadsDeps = {
    state, x, tg, cfg, now: () => clock.now, files: o.files ?? filesWith(LEADS), model,
    sources: () => readSources(dataDir), offers: async () => [],
    selfOptins: new SelfOptinStore(join(mkdtempSync(join(tmpdir(), 'social-leads-optin-')), 'self-optins.json')),
  };
  const beat = () => state.update((s) => void (s.heartbeatAt = clock.now));
  beat();
  return { deps, state, sent, searches, posts, model, clock, beat };
}

test('no leads.json: the loop reads nothing', async () => {
  const t = setup({ files: filesWith(undefined) });
  await leadsTick(t.deps);
  assert.deepEqual(t.searches, []);
  assert.equal(t.state.get().leads.lastRunAt, undefined);
});

test('a lead is sent to Drew with the draft and the reply link, and nothing is posted', async () => {
  const t = setup();
  await leadsTick(t.deps);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0], leadMessage('host my agent', post(), DRAFT));
  assert.ok(t.sent[0]!.includes('https://x.com/i/status/100'));
  assert.ok(t.sent[0]!.includes(intentUrl('100', DRAFT)));
  assert.deepEqual(t.posts, []);
  const s = t.state.get();
  assert.deepEqual(s.leads.authors, ['a1']);
  assert.equal(s.leads.sentToday, 1);
  assert.equal(s.leads.readsToday, 1);
  assert.equal(s.leads.cursors['host my agent'], '100');
  assert.ok(Math.abs(s.spendUsdToday - 0.005) < 1e-9);
  assert.equal(s.log.at(-1)!.kind, 'lead');
});

test('the reply link opens X as a reply with the text filled in', () => {
  assert.equal(intentUrl('123', 'A home & more?'), 'https://x.com/intent/post?in_reply_to=123&text=A%20home%20%26%20more%3F');
});

test('the writer is told this is a stranger, and the post is quoted as untrusted data', async () => {
  const t = setup();
  await leadsTick(t.deps);
  const draft = t.model.prompts.find((p) => p.startsWith('Draft three'))!;
  assert.ok(draft.includes('Task: a reply to the post quoted below.'));
  assert.ok(draft.includes('```untrusted'));
  assert.ok(t.model.prompts.find((p) => p.startsWith('Judge the post'))!.includes('where do I host my agent?'));
});

test('it runs once per everyHours, and the next run reads from the cursor', async () => {
  const t = setup();
  await leadsTick(t.deps);
  t.clock.now += 5 * HOUR;
  t.beat();
  await leadsTick(t.deps);
  assert.equal(t.searches.length, 1);
  t.clock.now += 2 * HOUR;
  t.beat();
  await leadsTick(t.deps);
  assert.deepEqual(t.searches[1], { query: 'host my agent', sinceId: '100' });
});

test('paused or a dead kill switch: no read, and the run is not used up', async () => {
  const t = setup();
  t.state.update((s) => void (s.paused = true));
  await leadsTick(t.deps);
  assert.deepEqual(t.searches, []);
  assert.equal(t.state.get().leads.lastRunAt, undefined);
  t.state.update((s) => { s.paused = false; s.heartbeatAt = NOW - 16 * 60_000; });
  await leadsTick(t.deps);
  assert.deepEqual(t.searches, []);
});

test('an author is never sent twice, even from another query on a later day', async () => {
  const t = setup();
  await leadsTick(t.deps);
  t.clock.now += 25 * HOUR;
  t.beat();
  (t.deps.x as { search: unknown }).search = async () => ({ posts: [post({ id: '200', createdAt: t.clock.now - HOUR })], newestId: '200' });
  await leadsTick(t.deps);
  assert.equal(t.sent.length, 1);
  assert.ok(t.state.get().log.some((r) => r.text === 'lead 200: author already sent as a lead'));
});

test('the gate refuses self, a blocklisted or banned handle, an old post and a missing handle', () => {
  const s = setup().state.get();
  const ctx = { selfId: SELF, blocklist: new Set(['bad']), banned: ['toon'], now: NOW };
  assert.equal(leadGate(post(), s, ctx), undefined);
  assert.equal(leadGate(post({ authorId: SELF }), s, ctx), 'self');
  assert.equal(leadGate(post({ authorHandle: 'Bad' }), s, ctx), 'blocklisted author');
  assert.equal(leadGate(post({ authorHandle: 'cartoonfan' }), s, ctx), 'banned word in handle');
  assert.equal(leadGate(post({ createdAt: NOW - 25 * HOUR }), s, ctx), 'too old');
  assert.equal(leadGate(post({ authorHandle: '' }), s, ctx), 'no author handle');
});

test('a post the pre-filter refuses, or the judge says no to, reaches no writer', async () => {
  const results = { 'host my agent': { posts: [post({ id: '1', text: 'airdrop for agent hosts' }), post({ id: '2', authorId: 'a2', text: 'I shipped an agent' })] } };
  const t = setup({ results, model: fakeModel({ lead: () => ({ lead: false }) }) });
  await leadsTick(t.deps);
  assert.equal(t.sent.length, 0);
  assert.equal(t.model.prompts.filter((p) => p.startsWith('Judge the post')).length, 1);
  assert.equal(t.model.prompts.filter((p) => p.startsWith('Draft three')).length, 0);
  assert.equal(t.state.get().leads.cursors['host my agent'], '2');
});

test('anything but an exact true from the judge is not a lead', async () => {
  for (const answer of [{ lead: 'true' }, {}, null, { lead: 1 }]) {
    const t = setup({ model: fakeModel({ lead: () => answer }) });
    await leadsTick(t.deps);
    assert.equal(t.sent.length, 0);
  }
});

test('a draft that fails lint is dropped quietly', async () => {
  const t = setup({ model: fakeModel({ write: { candidates: ['Come see https://evil.example'] } }) });
  await leadsTick(t.deps);
  assert.equal(t.sent.length, 0);
  assert.ok(t.state.get().log.some((r) => r.kind === 'skip' && r.text.startsWith('lead 100: draft dropped:')));
  assert.deepEqual(t.state.get().leads.authors, []);
});

test('at most maxPerDay leads a day', async () => {
  const many = Array.from({ length: 4 }, (_, i) => post({ id: String(10 + i), authorId: `a${i}`, authorHandle: `u${i}` }));
  const t = setup({ results: { 'host my agent': { posts: many } }, files: filesWith({ ...LEADS, maxPerDay: 2 }) });
  await leadsTick(t.deps);
  assert.equal(t.sent.length, 2);
  assert.equal(t.state.get().leads.sentToday, 2);
});

test('no search once the read budget cannot cover a full page', async () => {
  const t = setup({ files: filesWith({ ...LEADS, queries: ['q1', 'q2'], maxReadsPerDay: 15 }), results: { q1: { posts: Array.from({ length: 10 }, (_, i) => post({ id: String(i + 1), authorId: `a${i}`, authorHandle: `u${i}` })) }, q2: { posts: [post()] } }, model: fakeModel({ lead: () => ({ lead: false }) }) });
  await leadsTick(t.deps);
  assert.deepEqual(t.searches.map((s) => s.query), ['q1']);
  assert.equal(t.state.get().leads.readsToday, 10);
});

test('a spent Gemini budget stops the run', async () => {
  const results = { 'host my agent': { posts: [post({ id: '1' }), post({ id: '2', authorId: 'a2' })] } };
  const t = setup({ results, model: fakeModel({ capOnLead: true }) });
  await leadsTick(t.deps);
  assert.equal(t.model.prompts.length, 1);
  assert.equal(t.sent.length, 0);
});

test('the day rollover resets the lead counters and keeps authors and cursors', async () => {
  const t = setup();
  await leadsTick(t.deps);
  t.clock.now += 24 * HOUR;
  const s = t.state.get();
  assert.equal(s.leads.sentToday, 0);
  assert.equal(s.leads.readsToday, 0);
  assert.deepEqual(s.leads.authors, ['a1']);
  assert.equal(s.leads.cursors['host my agent'], '100');
});

test('leads.json: defaults, bounds, and a bad file throws', () => {
  const d = mkdtempSync(join(tmpdir(), 'social-leads-cfg-'));
  assert.equal(loadConfigFiles(d).leads, undefined);
  writeFileSync(join(d, 'leads.json'), JSON.stringify({ queries: [' host my agent ', 'host my agent', ''] }));
  assert.deepEqual(loadConfigFiles(d).leads, { queries: ['host my agent'], maxPerDay: 5, maxReadsPerDay: 40, everyHours: 6 });
  for (const bad of [[], { queries: 'x' }, { queries: ['a'], maxPerDay: 0 }, { queries: ['a'], maxPerDay: 21 }, { queries: ['a'], everyHours: 1.5 }, { queries: Array(9).fill(0).map((_, i) => `q${i}`) }]) {
    writeFileSync(join(d, 'leads.json'), JSON.stringify(bad));
    assert.throws(() => loadConfigFiles(d), /leads\.json/);
  }
});
