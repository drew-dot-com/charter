import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { listedRegistry, OFFER } from '../tenant/test-host.js';
import { DoorLedger, snapshotOffer } from './ledger.js';
import { doorApp } from './server.js';
import { homeIdOf, normalizeSshKeys } from '../jobs.js';
import { GrantStore } from './grants.js';
import { AllowanceStore, USDC_BASE } from './allowances.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@host';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA other@host';
const SPENDER = '0x' + 'a1'.repeat(20);
const BILLER_TOKEN = 'biller-secret-token';
const NKEY = normalizeSshKeys([KEY])!;
const HOME = homeIdOf(NKEY);
const LEASE = 'c'.repeat(32);
const PAGE = 'https://charterhome.dev/allow';

async function start(over: { noBiller?: boolean; noAllowances?: boolean; paid?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'allow-'));
  const clock = { t: 1_000_000 };
  const allowances = new AllowanceStore(join(dir, 'allowances.jsonl'), () => clock.t);
  const ledger = new DoorLedger(join(dir, 'ledger.json'));
  const registry = listedRegistry(dir);
  if (over.paid !== false) {
    ledger.open({ leaseId: LEASE, offerId: `${OFFER.hostId}:${OFFER.id}`, createdAt: 5, offer: snapshotOffer(OFFER), fee: '100', homeId: HOME });
    ledger.renterTick(LEASE, '0xpayer');
    registry.setHomeHost(HOME, OFFER.hostId);
  }
  const grants = new GrantStore(join(dir, 'grants.jsonl'), () => clock.t);
  const server = doorApp({
    offers: async () => [OFFER],
    api: () => { throw new Error('no host'); },
    registry,
    ledger,
    x402: 'free-for-tests',
    now: () => clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
    grants,
    ...(over.noAllowances ? {} : { allowances, allowAddress: SPENDER }),
    ...(over.noBiller ? {} : { allowToken: BILLER_TOKEN }),
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, b?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
  return {
    base, dir, clock, allowances, ledger, registry, grants, close: () => void server.close(), call,
    create: (b: unknown = { sshKeys: [KEY] }) => call('POST', '/v1/allowances', b),
    bill: (method: string, path: string, b?: unknown) => call(method, path, b, { authorization: `Bearer ${BILLER_TOKEN}` }),
  };
}

type Made = { allowanceId: string; ownerToken: string; approveUrl: string; state: string; next: string };
async function made(s: Awaited<ReturnType<typeof start>>): Promise<Made> {
  const r = await s.create();
  assert.equal(r.status, 201);
  return (await r.json()) as Made;
}

const permission = (over: Record<string, unknown> = {}) => ({
  signature: '0x' + 'ab'.repeat(65),
  chainId: 8453,
  permission: {
    account: '0x' + '11'.repeat(20), spender: SPENDER, token: USDC_BASE, allowance: String(744n * 5100n),
    period: 2_592_000, start: 1, end: 4_000_000_000, salt: '0x01', extraData: '0x', ...over,
  },
});

test('POST /v1/allowances: 201 for a home with a paid tick, with token and approve url', async () => {
  const s = await start();
  const j = await made(s);
  assert.match(j.allowanceId, /^[0-9a-f]{32}$/);
  assert.match(j.ownerToken, /^[0-9a-f]{64}$/);
  assert.equal(j.approveUrl, `${PAGE}?id=${j.allowanceId}`);
  assert.equal(j.state, 'waiting');
  assert.equal(j.next, `/v1/allowances/${j.allowanceId}`);
  assert.equal(s.allowances.get(j.allowanceId)!.tickMicro, '5100', 'tick price plus fee');
  assert.ok(s.allowances.tokenOk(j.allowanceId, j.ownerToken));
  s.close();
});

test('no_home for keys that never paid a tick', async () => {
  const s = await start({ paid: false });
  const r = await s.create();
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'no_home' });
  s.close();
});

test('no_home when the lease has no paid tick or no host holds the home', async () => {
  const s = await start();
  const r = await s.create({ sshKeys: [KEY2] });
  assert.equal(r.status, 404);
  s.close();
  const t = await start({ paid: false });
  t.ledger.open({ leaseId: LEASE, offerId: `${OFFER.hostId}:${OFFER.id}`, createdAt: 5, offer: snapshotOffer(OFFER), homeId: HOME });
  t.registry.setHomeHost(HOME, OFFER.hostId);
  assert.equal((await t.create()).status, 404, 'zero paid ticks');
  t.close();
});

test('a bad body is 400', async () => {
  const s = await start();
  assert.equal((await s.create({ sshKeys: [] })).status, 400);
  assert.equal((await s.create({ sshKeys: [KEY], image: 'nope' })).status, 400);
  s.close();
});

test('a second request for the same home is 409 already_live naming the first', async () => {
  const s = await start();
  const a = await made(s);
  const r = await s.create();
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'already_live', allowanceId: a.allowanceId });
  s.close();
});

test('requests are rate limited like pitches', async () => {
  const s = await start({ paid: false });
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await s.create()).status);
  assert.equal(codes[5], 429);
  s.close();
});

test('the routes are absent without the store and address', async () => {
  const s = await start({ noAllowances: true });
  assert.equal((await s.create()).status, 404);
  assert.equal((await s.bill('GET', '/v1/biller/allowances')).status, 404);
  s.close();
});

test('GET: the page view never carries sshKeys or homeId; the owner view does carry homeId', async () => {
  const s = await start();
  const a = await made(s);
  const pub = await s.call('GET', `/v1/allowances/${a.allowanceId}`);
  assert.equal(pub.status, 200);
  const text = await pub.text();
  assert.ok(!text.includes('sshKeys') && !text.includes('homeId') && !text.includes(HOME) && !text.includes('ssh-ed25519'));
  assert.equal((JSON.parse(text) as { spender: string }).spender, SPENDER);
  const own = await s.call('GET', `/v1/allowances/${a.allowanceId}`, undefined, { 'x-allowance-token': a.ownerToken });
  assert.equal(((await own.json()) as { homeId: string }).homeId, HOME);
  assert.equal((await s.call('GET', `/v1/allowances/${a.allowanceId}`, undefined, { 'x-allowance-token': 'nope' })).status, 403);
  assert.equal((await s.call('GET', `/v1/allowances/${'0'.repeat(32)}`)).status, 404);
  s.close();
});

test('POST permission: approves a waiting allowance, then 409 not_waiting', async () => {
  const s = await start();
  const a = await made(s);
  const r = await s.call('POST', `/v1/allowances/${a.allowanceId}/permission`, permission());
  assert.equal(r.status, 200);
  const j = (await r.json()) as { state: string; account: string };
  assert.equal(j.state, 'approved');
  assert.equal(j.account, '0x' + '11'.repeat(20));
  assert.ok(s.allowances.get(a.allowanceId)!.signed);
  const again = await s.call('POST', `/v1/allowances/${a.allowanceId}/permission`, permission());
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'not_waiting' });
  s.close();
});

test('POST permission: a bad permission is 400 with the validator error; unknown id 404', async () => {
  const s = await start();
  const a = await made(s);
  const r = await s.call('POST', `/v1/allowances/${a.allowanceId}/permission`, permission({ period: 5 }));
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /period/);
  assert.equal(s.allowances.get(a.allowanceId)!.state, 'waiting');
  assert.equal((await s.call('POST', `/v1/allowances/${'0'.repeat(32)}/permission`, permission())).status, 404);
  s.close();
});

test('POST stop: waiting goes to expired, an active one to stopping, bad token 403, ended 409', async () => {
  const s = await start();
  const a = await made(s);
  const h = { 'x-allowance-token': a.ownerToken };
  assert.equal((await s.call('POST', `/v1/allowances/${a.allowanceId}/stop`, {}, { 'x-allowance-token': 'bad' })).status, 403);
  const w = await s.call('POST', `/v1/allowances/${a.allowanceId}/stop`, {}, h);
  assert.equal(w.status, 200);
  assert.equal(((await w.json()) as { state: string }).state, 'expired');
  assert.equal((await s.call('POST', `/v1/allowances/${a.allowanceId}/stop`, {}, h)).status, 409);

  const b = await made(s);
  s.allowances.update(b.allowanceId, { state: 'approved' });
  s.allowances.update(b.allowanceId, { state: 'active' });
  const r = await s.call('POST', `/v1/allowances/${b.allowanceId}/stop`, {}, { 'x-allowance-token': b.ownerToken });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { state: string; homeId: string };
  assert.equal(j.state, 'stopping');
  assert.equal(j.homeId, HOME);
  s.close();
});

test('biller routes are 401 without the token', async () => {
  const s = await start();
  for (const [m, p] of [['GET', '/v1/biller/allowances'], ['POST', '/v1/biller/allowances/x'], ['GET', `/v1/biller/homes/${HOME}`]] as const) {
    assert.equal((await s.call(m, p, m === 'POST' ? {} : undefined)).status, 401, p);
    assert.equal((await s.call(m, p, m === 'POST' ? {} : undefined, { authorization: 'Bearer wrong' })).status, 401, p);
  }
  s.close();
});

test('biller routes do not exist without a token', async () => {
  const s = await start({ noBiller: true });
  assert.equal((await s.call('GET', '/v1/biller/allowances', undefined, { authorization: 'Bearer x' })).status, 404);
  s.close();
});

test('GET /v1/biller/allowances lists live allowances with keys, not the token hash', async () => {
  const s = await start();
  const a = await made(s);
  const r = await s.bill('GET', '/v1/biller/allowances');
  const j = (await r.json()) as { allowances: Array<Record<string, unknown>> };
  assert.equal(j.allowances.length, 1);
  assert.equal(j.allowances[0]!.allowanceId, a.allowanceId);
  assert.deepEqual(j.allowances[0]!.sshKeys, NKEY);
  assert.ok(!('tokenHash' in j.allowances[0]!));
  s.allowances.update(a.allowanceId, { state: 'expired' });
  assert.equal(((await (await s.bill('GET', '/v1/biller/allowances')).json()) as { allowances: unknown[] }).allowances.length, 0);
  s.close();
});

test('POST /v1/biller/allowances/:id patches typed fields and enforces the move table', async () => {
  const s = await start();
  const a = await made(s);
  const p = `/v1/biller/allowances/${a.allowanceId}`;
  assert.equal((await s.bill('POST', p, { state: 'active' })).status, 409, 'waiting -> active is not allowed');
  s.allowances.update(a.allowanceId, { state: 'approved' });
  const r = await s.bill('POST', p, {
    state: 'active', reason: 'ok', account: '0x' + '11'.repeat(20), remainingMicro: '1000', periodEndsAt: 123, creditMicro: '5', hoursPaid: 3, lastPullTx: '0xabc', leaseId: LEASE,
  });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, unknown>;
  assert.equal(j.state, 'active');
  assert.equal(j.hoursPaid, 3);
  assert.equal(j.leaseId, LEASE);
  assert.ok(!('tokenHash' in j));
  assert.equal((await s.bill('POST', p, { state: 'ended', endReason: 'stopped' })).status, 200);
  assert.equal(s.allowances.get(a.allowanceId)!.endReason, 'stopped');
  assert.equal((await s.bill('POST', p, { hoursPaid: -1 })).status, 400);
  assert.equal((await s.bill('POST', p, { hoursPaid: 1.5 })).status, 400);
  assert.equal((await s.bill('POST', p, { remainingMicro: 5 })).status, 400);
  assert.equal((await s.bill('POST', p, { endReason: 'whatever' })).status, 400);
  assert.equal((await s.bill('POST', p, { state: 'bogus' })).status, 400);
  assert.equal((await s.bill('POST', p, { sshKeys: [] })).status, 400);
  assert.equal((await s.bill('POST', `/v1/biller/allowances/${'0'.repeat(32)}`, {})).status, 404);
  s.close();
});

test('GET /v1/biller/homes/:homeId reports newest lease, its offer, host and live grant', async () => {
  const s = await start();
  const offerId = `${OFFER.hostId}:${OFFER.id}`;
  const url = `/v1/biller/homes/${HOME}`;
  let j = (await (await s.bill('GET', url)).json()) as Record<string, unknown>;
  assert.deepEqual(j, { leaseId: LEASE, offerId, hostKnown: true, grantLive: false });
  const newer = 'd'.repeat(32);
  s.ledger.open({ leaseId: newer, offerId: 'z:z', createdAt: 99, offer: snapshotOffer(OFFER), homeId: HOME });
  j = (await (await s.bill('GET', url)).json()) as Record<string, unknown>;
  assert.equal(j.leaseId, newer);
  assert.equal(j.offerId, offerId);
  const g = s.grants.add({ name: 'Ada', pitch: 'p', sshKeys: NKEY, image: 'charter-home' } as never, 't');
  s.grants.update(g.grantId, { state: 'approved_waiting' });
  j = (await (await s.bill('GET', url)).json()) as Record<string, unknown>;
  assert.equal(j.grantLive, true);
  const none = (await (await s.bill('GET', `/v1/biller/homes/${homeIdOf(normalizeSshKeys([KEY2])!)}`)).json()) as Record<string, unknown>;
  assert.deepEqual(none, { leaseId: null, offerId: null, hostKnown: false, grantLive: false });
  s.close();
});

test('GET /v1/biller/homes/:homeId names the home host\'s own offer when a newer lease is on another host', async () => {
  const s = await start();
  try {
    // The home's host holds an older lease and the fixture's lease (createdAt 5) on offer OFFER.
    const own = `${OFFER.hostId}:${OFFER.id}`;
    const url = `/v1/biller/homes/${HOME}`;
    s.ledger.open({ leaseId: 'a'.repeat(32), offerId: `${OFFER.hostId}:older`, createdAt: 1, offer: snapshotOffer(OFFER), homeId: HOME });
    const elsewhere = 'b'.repeat(32);
    s.ledger.open({ leaseId: elsewhere, offerId: 'otherhost:offer9', createdAt: 999, offer: snapshotOffer(OFFER), homeId: HOME });
    const j = (await (await s.bill('GET', url)).json()) as Record<string, unknown>;
    assert.equal(j.leaseId, elsewhere);
    assert.equal(j.offerId, own);
    assert.equal(j.hostKnown, true);
  } finally {
    s.close();
  }
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const hex = (s: string, n: number) => '0x' + s.padStart(n, '0');
const pay = (from: string, nonce: string) =>
  b64({ x402Version: 2, payload: { authorization: { from, to: '0x' + '2'.repeat(40), value: '5100', validAfter: '0', validBefore: '9999999999', nonce: hex(nonce, 64) }, signature: '0xsig' } });

test('the biller address is never payer_blocked', async () => {
  const s = await start();
  const open = (id: string) => s.ledger.open({ leaseId: id, offerId: `${OFFER.hostId}:${OFFER.id}`, createdAt: 6, offer: snapshotOffer(OFFER) });
  const [lossLease, a, b] = ['e', 'f', '9'].map((c) => c.repeat(32));
  for (const id of [lossLease!, a!, b!]) open(id);
  s.ledger.loss(lossLease!, 5000n, 'settle_failed', s.clock.t, SPENDER);
  s.ledger.loss(lossLease!, 5000n, 'settle_failed', s.clock.t, hex('dead', 40));
  assert.equal(s.ledger.payerHasLoss(SPENDER, s.clock.t), true);
  const tick = (id: string, payer: string, nonce: string) =>
    s.call('POST', `/v1/leases/${id}/ticks`, { index: 0 }, { 'x-test-payer': payer, 'payment-signature': pay(payer, nonce) });
  assert.equal((await tick(b!, hex('dead', 40), '2')).status, 403, 'any other payer with a loss is blocked');
  assert.notEqual((await tick(a!, SPENDER, '1')).status, 403);
  s.close();
});

async function activeGrant(s: Awaited<ReturnType<typeof start>>, paidHours: number, leaseId: string | null = LEASE) {
  const g = s.grants.add({ name: 'Ada', pitch: 'p', sshKeys: NKEY, image: 'charter-home' } as never, 'tok');
  s.grants.update(g.grantId, { state: 'approved_waiting' });
  s.grants.update(g.grantId, { state: 'active', paidHours, ...(leaseId ? { leaseId } : {}) });
  return g;
}
const owner = async (s: Awaited<ReturnType<typeof start>>, id: string) =>
  (await (await s.call('GET', `/v1/grants/${id}`, undefined, { 'x-grant-token': 'tok' })).json()) as { keepHome?: { allowanceId: string; ownerToken?: string; approveUrl: string; state: string; message: string } };

test('no keepHome before hour 672', async () => {
  const s = await start();
  const g = await activeGrant(s, 671);
  assert.equal((await owner(s, g.grantId)).keepHome, undefined);
  assert.equal(s.allowances.all().length, 0);
  s.close();
});

test('keepHome at hour 672 with a new allowance and its token', async () => {
  const s = await start();
  const g = await activeGrant(s, 672);
  const k = (await owner(s, g.grantId)).keepHome!;
  assert.match(k.ownerToken!, /^[0-9a-f]{64}$/);
  assert.equal(k.approveUrl, `${PAGE}?id=${k.allowanceId}`);
  assert.equal(k.state, 'waiting');
  assert.equal(k.message, `Your grant ends soon. To keep this home after it, send your person this link to approve a monthly allowance: ${k.approveUrl}`);
  assert.ok(s.allowances.tokenOk(k.allowanceId, k.ownerToken!));
  assert.ok(s.allowances.get(k.allowanceId)!.tickMicro > 0n);
  s.close();
});

test('a second read reuses it and omits the token', async () => {
  const s = await start();
  const g = await activeGrant(s, 700);
  const a = (await owner(s, g.grantId)).keepHome!;
  const b = (await owner(s, g.grantId)).keepHome!;
  assert.equal(b.allowanceId, a.allowanceId);
  assert.equal(b.ownerToken, undefined);
  assert.equal(s.allowances.all().length, 1);
  s.close();
});

test('the public grant view never has keepHome', async () => {
  const s = await start();
  const g = await activeGrant(s, 700);
  await owner(s, g.grantId);
  const pub = (await (await s.call('GET', `/v1/grants/${g.grantId}`)).json()) as Record<string, unknown>;
  assert.equal(pub.keepHome, undefined);
  s.close();
});

test('no keepHome without a lease, or when allowance routes are not mounted', async () => {
  const s = await start();
  const g = await activeGrant(s, 700, null);
  assert.equal((await owner(s, g.grantId)).keepHome, undefined);
  s.close();
  const n = await start({ noAllowances: true });
  const g2 = await activeGrant(n, 700);
  assert.equal((await owner(n, g2.grantId)).keepHome, undefined);
  n.close();
});
