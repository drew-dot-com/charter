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
import { GrantStore } from './grants.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@host';
const keyN = (i: number) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(i).padStart(6, '0')}`;
const PITCH_TEXT = 'a-very-distinctive-pitch-sentence';
const body = (over: Record<string, unknown> = {}) => ({ name: 'Ada', pitch: PITCH_TEXT, sshKeys: [KEY], image: 'charter-home', ...over });

async function start(over: { fundOpen?: () => boolean; noGrants?: boolean } = {}) {
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

test('GET with the token shows the full leaseId, without it 8 characters', async () => {
  const s = await start();
  const g = s.grants.add({ name: 'n', pitch: 'p', sshKeys: [KEY], image: 'charter-home' }, 'tok');
  s.grants.update(g.grantId, { leaseId: 'f'.repeat(32) });
  const own = (await (await s.get(`/v1/grants/${g.grantId}`, { 'x-grant-token': 'tok' })).json()) as { leaseId: string };
  assert.equal(own.leaseId, 'f'.repeat(32));
  for (const h of [{}, { 'x-grant-token': 'wrong' }]) {
    const r = await s.get(`/v1/grants/${g.grantId}`, h);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { leaseId: string }).leaseId, 'f'.repeat(8));
  }
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
  writeFileSync(join(s.dir, 'fund-public.json'), JSON.stringify({ address: '0xabc', balanceMicro: '5000000', grantsLeft: 3, open: true, extra: 'x' }));
  r = await s.get('/v1/grants');
  text = await r.text();
  j = JSON.parse(text);
  assert.deepEqual(j.fund, { address: '0xabc', balanceMicro: '5000000', grantsLeft: 3 });
  s.close();
});
