import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OFFER } from '../tenant/test-host.js';
import { DoorLedger } from './ledger.js';
import { doorApp } from './server.js';
import { normalizeSshKeys } from '../jobs.js';
import { GrantStore, readFundPublic } from './grants.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@host';
const keyN = (i: number) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(i).padStart(6, '0')}`;
const PITCH_TEXT = 'a-very-distinctive-pitch-sentence';
const body = (over: Record<string, unknown> = {}) => ({ name: 'Ada', pitch: PITCH_TEXT, sshKeys: [KEY], image: 'charter-home', ...over });

async function start(over: { fundOpen?: () => boolean; noGrants?: boolean; fundToken?: string; fundAddress?: string; noFundOpen?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'));
  const clock = { t: 1_000_000 };
  const grants = new GrantStore(join(dir, 'grants.jsonl'), () => clock.t);
  const server = doorApp({
    offers: async () => [OFFER],
    api: () => { throw new Error('no host'); },
    hosts: new Map([[OFFER.hostPubkey, OFFER.ilpBase]]),
    ledger: new DoorLedger(join(dir, 'ledger.json')),
    x402: 'free-for-tests',
    now: () => clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
    ...(over.noGrants ? {} : { grants }),
    ...(over.fundOpen ? { fundOpen: over.fundOpen } : {}),
    ...(over.fundToken ? { fundToken: over.fundToken } : {}),
    ...(over.fundAddress ? { fundAddress: over.fundAddress } : {}),
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, dir, clock, grants, close: () => void server.close(),
    post: (b: unknown) => fetch(base + '/v1/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }),
  };
}

test('a valid pitch answers 201 with a token', async () => {
  const s = await start();
  const r = await s.post(body());
  assert.equal(r.status, 201);
  const j = (await r.json()) as { grantId: string; grantToken: string; state: string; next: string };
  assert.equal(j.state, 'queued');
  assert.match(j.grantToken, /^[0-9a-f]{64}$/);
  assert.equal(j.next, `/v1/grants/${j.grantId}`);
  assert.ok(s.grants.tokenOk(j.grantId, j.grantToken));
  s.close();
});

test('a pitch without image answers 201 and gets charter-home', async () => {
  const s = await start();
  const { image: _i, ...noImage } = body();
  const r = await s.post(noImage);
  assert.equal(r.status, 201);
  const j = (await r.json()) as { grantId: string };
  assert.equal(s.grants.get(j.grantId)!.image, 'charter-home');
  s.close();
});

test('a pitch with a lone surrogate answers 400', async () => {
  const s = await start();
  // JSON.stringify writes a lone surrogate as an escape, so it reaches the door as one.
  const r = await s.post(body({ pitch: 'bad \uD800 text' }));
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /well-formed/);
  assert.equal(s.grants.all().length, 0);
  s.close();
});

test('a bad pitch answers 400 with the validator error', async () => {
  const s = await start();
  const r = await s.post(body({ image: 'nope' }));
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /image/);
  s.close();
});

test('the routes are absent without a grant store', async () => {
  const s = await start({ noGrants: true });
  assert.equal((await s.post(body())).status, 404);
  s.close();
});

test('the sixth pitch from one IP in an hour answers 429', async () => {
  const s = await start();
  for (let i = 0; i < 5; i++) assert.equal((await s.post(body({ sshKeys: [keyN(i)] }))).status, 201);
  const r = await s.post(body({ sshKeys: [keyN(9)] }));
  assert.equal(r.status, 429);
  assert.equal(((await r.json()) as { error: string }).error, 'rate_limited');
  s.clock.t += 3_600_001;
  assert.equal((await s.post(body({ sshKeys: [keyN(9)] }))).status, 201);
  s.close();
});

test('the 51st queued pitch answers 503 full', async () => {
  const s = await start();
  for (let i = 0; i < 50; i++) s.grants.add({ name: 'n', pitch: 'p', sshKeys: [keyN(i)], image: 'charter-home' }, 't');
  const r = await s.post(body({ sshKeys: [keyN(100)] }));
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'full');
  s.close();
});

test('a pitch on a granted homeId answers 409', async () => {
  const s = await start();
  const g = s.grants.add({ name: 'n', pitch: 'p', sshKeys: normalizeSshKeys([KEY])!, image: 'charter-home' }, 't');
  s.grants.update(g.grantId, { state: 'approved_waiting' });
  const r = await s.post(body());
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'already_granted');
  s.close();
});

test('fundOpen false answers 503 fund_closed', async () => {
  const s = await start({ fundOpen: () => false });
  const r = await s.post(body());
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, 'fund_closed');
  s.close();
});

test('GET with the token shows the full leaseId, without it 8 characters, a wrong token 403', async () => {
  const s = await start();
  const g = s.grants.add({ name: 'n', pitch: 'p', sshKeys: [KEY], image: 'charter-home' }, 'tok');
  s.grants.update(g.grantId, { leaseId: 'f'.repeat(32) });
  const own = (await (await s.get(`/v1/grants/${g.grantId}`, { 'x-grant-token': 'tok' })).json()) as { leaseId: string };
  assert.equal(own.leaseId, 'f'.repeat(32));
  const r = await s.get(`/v1/grants/${g.grantId}`);
  assert.equal(r.status, 200);
  const pub = (await r.json()) as { leaseId: string; homeId?: string };
  assert.equal(pub.leaseId, 'f'.repeat(8));
  assert.equal(pub.homeId, undefined);
  const bad = await s.get(`/v1/grants/${g.grantId}`, { 'x-grant-token': 'wrong' });
  assert.equal(bad.status, 403);
  assert.deepEqual(await bad.json(), { error: 'bad_token' });
  assert.equal((await s.get('/v1/grants/' + 'e'.repeat(32))).status, 404);
  s.close();
});

test('GET /v1/grants never contains pitch text, lists newest first, and shows the fund when it has reported', async () => {
  const s = await start();
  assert.equal((await s.post(body())).status, 201);
  s.clock.t += 10;
  assert.equal((await s.post(body({ name: 'Bob', sshKeys: [keyN(1)] }))).status, 201);
  let r = await s.get('/v1/grants');
  let text = await r.text();
  assert.ok(!text.includes(PITCH_TEXT));
  let j = JSON.parse(text) as { grants: { name: string }[]; fund: unknown };
  assert.deepEqual(j.grants.map((g) => g.name), ['Bob', 'Ada']);
  assert.equal(j.fund, null);
  assert.ok(!text.includes('homeId'), 'no homeId in the public list');
  writeFileSync(join(s.dir, 'fund-public.json'), JSON.stringify({ address: '0xabc', balanceMicro: '5000000', grantsLeft: 3, open: true, reportedAt: s.clock.t, extra: 'x' }));
  r = await s.get('/v1/grants');
  text = await r.text();
  j = JSON.parse(text);
  assert.deepEqual(j.fund, { address: '0xabc', balanceMicro: '5000000', grantsLeft: 3, open: true });
  // closed: grants left reads 0 whatever the file says
  writeFileSync(join(s.dir, 'fund-public.json'), JSON.stringify({ address: '0xabc', balanceMicro: '5000000', grantsLeft: 3, open: false, reportedAt: s.clock.t }));
  j = JSON.parse(await (await s.get('/v1/grants')).text());
  assert.deepEqual(j.fund, { address: '0xabc', balanceMicro: '5000000', grantsLeft: 0, open: false });
  // a file with no address string is no report
  writeFileSync(join(s.dir, 'fund-public.json'), JSON.stringify({ balanceMicro: '5', grantsLeft: 1, open: true, reportedAt: s.clock.t }));
  j = JSON.parse(await (await s.get('/v1/grants')).text());
  assert.equal(j.fund, null);
  s.close();
});

test('a fund report older than 10 minutes reads closed: no pitches, open false, 0 grants left', async () => {
  const s = await start({ fundToken: TOKEN, fundOpen: () => readFundPublic(join(s.dir, 'fund-public.json'), s.clock.t)?.open === true });
  try {
    const pub = { address: '0x' + 'ab'.repeat(20), balanceMicro: '5000000', grantsLeft: 3, open: true };
    assert.equal((await jpost(s, '/v1/fund/public', pub, auth, 'PUT')).status, 200);
    s.clock.t += 10 * 60_000;
    assert.equal(((await (await s.get('/v1/grants')).json()) as { fund: { open: boolean } }).fund.open, true, 'exactly 10 minutes is still fresh');
    s.clock.t += 1;
    const j = (await (await s.get('/v1/grants')).json()) as { fund: Record<string, unknown> };
    assert.equal(j.fund.open, false);
    assert.equal(j.fund.grantsLeft, 0);
    assert.deepEqual(await (await s.post(body())).json(), { error: 'fund_closed' });
    // a fresh report opens it again
    assert.equal((await jpost(s, '/v1/fund/public', pub, auth, 'PUT')).status, 200);
    assert.equal((await s.post(body())).status, 201);
  } finally {
    s.close();
  }
});

const TOKEN = 'fund-secret-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const jpost = (s: { base: string }, path: string, b: unknown, h: Record<string, string> = auth, method = 'POST') =>
  fetch(s.base + path, { method, headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });

test('fund routes answer 401 without the bearer, 404 when no token is configured', async () => {
  const s = await start({ fundToken: TOKEN });
  const n = await start();
  try {
    assert.equal((await s.get('/v1/fund/queue')).status, 401);
    assert.equal((await s.get('/v1/fund/queue', { authorization: 'Bearer nope' })).status, 401);
    assert.deepEqual(await (await s.get('/v1/fund/grants', { authorization: 'Bearer x' })).json(), { error: 'unauthorized' });
    assert.equal((await jpost(s, '/v1/fund/public', {}, {}, 'PUT')).status, 401);
    assert.equal((await n.get('/v1/fund/queue', auth)).status, 404);
  } finally {
    s.close();
    n.close();
  }
});

test('queue returns the oldest queued grant with its pitch', async () => {
  const s = await start({ fundToken: TOKEN, fundOpen: () => true });
  try {
    assert.deepEqual(await (await s.get('/v1/fund/queue', auth)).json(), { grant: null, live: 0 });
    const a = s.grants.add({ name: 'Ada', pitch: 'first pitch', sshKeys: [KEY], image: 'charter-home' }, 't1');
    s.clock.t += 10;
    s.grants.add({ name: 'Bob', pitch: 'second pitch', sshKeys: [keyN(2)], image: 'charter-hermes' }, 't2');
    const j = (await (await s.get('/v1/fund/queue', auth)).json()) as { grant: Record<string, unknown>; live: number };
    assert.deepEqual(j.grant, { grantId: a.grantId, name: 'Ada', link: null, image: 'charter-home', pitch: 'first pitch', homeId: a.homeId });
    assert.equal(j.live, 0);
    s.grants.update(a.grantId, { state: 'approved_waiting' });
    assert.equal(((await (await s.get('/v1/fund/queue', auth)).json()) as { live: number }).live, 1);
  } finally {
    s.close();
  }
});

test('fund grants list filters by state, omits tokenHash, keeps sshKeys and pitch, rejects unknown state', async () => {
  const s = await start({ fundToken: TOKEN });
  try {
    s.grants.add({ name: 'Ada', pitch: 'p', sshKeys: [KEY], image: 'charter-home' }, 't1');
    const j = (await (await s.get('/v1/fund/grants?state=queued', auth)).json()) as { grants: Array<Record<string, unknown>> };
    assert.equal(j.grants.length, 1);
    assert.equal(j.grants[0]!.tokenHash, undefined);
    assert.deepEqual(j.grants[0]!.sshKeys, [KEY]);
    assert.equal(j.grants[0]!.pitch, 'p');
    assert.equal(((await (await s.get('/v1/fund/grants?state=active', auth)).json()) as { grants: unknown[] }).grants.length, 0);
    assert.equal((await s.get('/v1/fund/grants?state=bogus', auth)).status, 400);
    assert.equal(((await (await s.get('/v1/fund/grants', auth)).json()) as { grants: unknown[] }).grants.length, 1);
  } finally {
    s.close();
  }
});

test('a verdict moves queued to declined with summary and reason', async () => {
  const s = await start({ fundToken: TOKEN });
  try {
    const g = s.grants.add({ name: 'Ada', pitch: 'p', sshKeys: [KEY], image: 'charter-home' }, 't1');
    const r = await jpost(s, `/v1/fund/grants/${g.grantId}`, { state: 'declined', summary: 'thin', reason: 'no plan' });
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, unknown>;
    assert.equal(j.state, 'declined');
    assert.equal(j.summary, 'thin');
    assert.equal(j.reason, 'no plan');
    assert.equal(j.tokenHash, undefined);
    assert.equal(s.grants.get(g.grantId)!.state, 'declined');
  } finally {
    s.close();
  }
});

test('a bad move answers 409, an unknown id 404, a bad field 400', async () => {
  const s = await start({ fundToken: TOKEN });
  try {
    const g = s.grants.add({ name: 'Ada', pitch: 'p', sshKeys: [KEY], image: 'charter-home' }, 't1');
    const r = await jpost(s, `/v1/fund/grants/${g.grantId}`, { state: 'active' });
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'bad_move' });
    assert.equal((await jpost(s, '/v1/fund/grants/nope', { summary: 'x' })).status, 404);
    assert.equal((await jpost(s, `/v1/fund/grants/${g.grantId}`, { tokenHash: 'x' })).status, 400, 'unlisted fields are refused');
    assert.equal((await jpost(s, `/v1/fund/grants/${g.grantId}`, { paidHours: -1 })).status, 400);
    assert.equal((await jpost(s, `/v1/fund/grants/${g.grantId}`, { state: 'nonsense' })).status, 400);
    assert.equal((await jpost(s, `/v1/fund/grants/${g.grantId}`, { summary: 7 })).status, 400);
    assert.equal(s.grants.get(g.grantId)!.state, 'queued');
  } finally {
    s.close();
  }
});

test('PUT public with open false makes POST /v1/grants answer fund_closed, and open true reopens it without a restart', async () => {
  const { readFileSync, statSync, existsSync } = await import('node:fs');
  const s = await start({ fundToken: TOKEN, fundOpen: () => readFundPublic(join(s.dir, 'fund-public.json'), s.clock.t)?.open === true });
  try {
    assert.equal((await s.post(body())).status, 503);
    const pub = { address: '0x' + 'ab'.repeat(20), balanceMicro: '5000000', grantsLeft: 3, open: true };
    assert.equal((await jpost(s, '/v1/fund/public', pub, auth, 'PUT')).status, 200);
    const f = join(s.dir, 'fund-public.json');
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { ...pub, reportedAt: s.clock.t }, 'stamped with the door clock');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(existsSync(f + '.tmp'), false);
    assert.equal((await s.post(body())).status, 201);
    const pubJ = (await (await s.get('/v1/grants')).json()) as { fund: Record<string, unknown> };
    assert.equal(pubJ.fund.grantsLeft, 3);
    assert.equal((await jpost(s, '/v1/fund/public', { ...pub, open: false }, auth, 'PUT')).status, 200);
    assert.deepEqual(await (await s.post(body({ sshKeys: [keyN(3)] }))).json(), { error: 'fund_closed' });
  } finally {
    s.close();
  }
});

test('PUT public validates its body', async () => {
  const s = await start({ fundToken: TOKEN });
  const ok = { address: '0x' + 'ab'.repeat(20), balanceMicro: '5', grantsLeft: 0, open: false };
  try {
    for (const bad of [
      { ...ok, address: '0x123' }, { ...ok, address: 'ab'.repeat(20) }, { ...ok, balanceMicro: '-1' }, { ...ok, balanceMicro: 5 },
      { ...ok, grantsLeft: -1 }, { ...ok, grantsLeft: 1.5 }, { ...ok, open: 'yes' }, { address: ok.address },
    ]) assert.equal((await jpost(s, '/v1/fund/public', bad, auth, 'PUT')).status, 400, JSON.stringify(bad));
    assert.equal((await jpost(s, '/v1/fund/public', ok, auth, 'PUT')).status, 200);
  } finally {
    s.close();
  }
});
