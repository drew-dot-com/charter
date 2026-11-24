import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BASE, BASE_USDC, CapError } from './core.js';
import { build, fileSpendBook, loadKey, optionsFromEnv, type Options } from './server.js';

const ID = 'c'.repeat(32);
const DOOR = 'https://door.test';
const PAY_TO = '0xbD87E8Ff0691f0A924e5ce2A06821db818B62385';
const OFFER = { offerId: 'host:one', cpu: 1, memoryMiB: 1024, tickPrice: '7000', intervalSeconds: 3600, images: ['charter-job-python', 'charter-home'], home: { diskGiB: 2, retentionDays: 7, slots: 2 } };
const today = (): string => new Date().toISOString().slice(0, 10);

function options(over: Partial<Options> = {}): Options {
  const dir = mkdtempSync(join(tmpdir(), 'charter-mcp-'));
  return { door: DOOR, keyFile: join(dir, 'mcp.key'), spendFile: join(dir, 'spend.json'), maxHour: 10_000n, maxDay: 250_000n, makeKey: true, ...over };
}

interface Signed {
  path: string;
  scheme: string;
  to: string;
  value: string;
}

interface DoorOpts {
  /** What the 402 asks for, micro-USDC. */
  ask?: string;
  payTo?: string;
  /** The answer to a POST that carries a signed payment. */
  onPaid?: (path: string) => Response;
  /** Answer every POST with this instead of the x402 exchange. */
  post?: () => Response;
}

/**
 * A door that speaks x402 as the live one does: a POST with no payment gets a 402 naming the price in
 * its PAYMENT-REQUIRED header; a POST carrying PAYMENT-SIGNATURE is recorded with what was signed.
 */
function door(routes: Record<string, unknown>, o: DoorOpts = {}) {
  const seen = { urls: [] as string[], unpaidPosts: [] as string[], signed: [] as Signed[] };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers });
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    seen.urls.push(req.url);
    assert.equal(req.redirect, 'error', 'every request refuses redirects');
    assert.ok(req.signal, 'every request has a timeout');
    if (req.method === 'GET') {
      if (url.pathname === '/v1/door') return json({ payTo: o.payTo ?? PAY_TO, network: BASE });
      const hit = routes[url.pathname];
      return hit === undefined ? json({ error: 'not_found' }, 404) : json(hit);
    }
    if (o.post) return o.post();
    const payment = req.headers.get('payment-signature');
    if (!payment) {
      seen.unpaidPosts.push(url.pathname);
      const required = {
        x402Version: 2,
        error: 'Payment required',
        resource: { url: req.url, description: 'test', mimeType: 'application/json' },
        accepts: [
          { scheme: 'batch-settlement', network: BASE, amount: o.ask ?? '7000', asset: BASE_USDC, payTo: o.payTo ?? PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
          { scheme: 'exact', network: BASE, amount: o.ask ?? '7000', asset: BASE_USDC, payTo: o.payTo ?? PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
        ],
      };
      return json({}, 402, { 'payment-required': Buffer.from(JSON.stringify(required)).toString('base64') });
    }
    const p = JSON.parse(Buffer.from(payment, 'base64').toString('utf8'));
    seen.signed.push({ path: url.pathname, scheme: p.accepted.scheme, to: p.payload.authorization.to, value: p.payload.authorization.value });
    return o.onPaid ? o.onPaid(url.pathname) : json({ leaseId: ID, state: 'running', paidIntervals: 1, paidThrough: Date.now() + 3_600_000 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

async function connect(o: Options, fetchFn: typeof fetch) {
  const { server, address } = build(o, () => {}, fetchFn);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content[0]!.text, isError: r.isError === true };
  };
  return { client, call, address };
}

const done = (stdout: string) => ({
  [`/v1/leases/${ID}`]: { lease: { state: 'done', paidIntervals: 1, paidThrough: 1, outputParts: 1 }, stopped: false },
  [`/v1/leases/${ID}/output/0`]: { part: 0, parts: 1, data: Buffer.from(JSON.stringify({ kind: 'python', exitCode: 0, stdout, stderr: '' })).toString('base64') },
});

test('the server lists its twelve tools, and every paid one says PAID first', async () => {
  const { client } = await connect(options(), door({}).fetchFn);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['charter_allowance_link', 'charter_allowance_status', 'charter_allowance_stop', 'charter_extend', 'charter_fetch_pages', 'charter_grant_pitch', 'charter_grant_status', 'charter_lease', 'charter_offers', 'charter_rent_home', 'charter_run_python', 'charter_wallet']);
  for (const t of tools) {
    const paid = ['charter_extend', 'charter_fetch_pages', 'charter_rent_home', 'charter_run_python'].includes(t.name);
    assert.equal(t.description!.startsWith('PAID.'), paid, t.name);
    assert.equal(t.description!.startsWith('Free.'), !paid, t.name);
    assert.equal(t.annotations?.readOnlyHint, ['charter_grant_pitch', 'charter_allowance_link', 'charter_allowance_stop'].includes(t.name) ? false : !paid, t.name);
    assert.ok(!t.description!.includes(String.fromCharCode(0x2014)), `${t.name} has an em dash`);
  }
});

test('a paid python run signs one exact payment for the price, to the door payee, and returns the output', async () => {
  const o = options();
  const d = door({ '/v1/offers': [OFFER], ...done('4\n') });
  const { call, address } = await connect(o, d.fetchFn);
  const r = await call('charter_run_python', { script: 'print(2 + 2)', waitSeconds: 10 });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.output.stdout, '4\n');
  assert.equal(out.rented.paidUsdc, '0.007');
  assert.deepEqual(d.seen.signed, [{ path: '/v1/rent', scheme: 'exact', to: PAY_TO, value: '7000' }]);
  assert.equal(fileSpendBook(o.spendFile, o.maxDay).spent(today()), 7000n);
  // The key is nowhere in what the agent sees.
  const key = readFileSync(o.keyFile, 'utf8').trim();
  assert.ok(!r.text.includes(key) && !r.text.includes(key.slice(2)));
  assert.ok(!(await call('charter_wallet')).text.includes(key.slice(2)));
  assert.match(address!, /^0x/);
});

test('a 402 that asks more than the price read beforehand is never signed, even under the hourly cap', async () => {
  const o = options();
  const d = door({ '/v1/offers': [OFFER] }, { ask: '9000' });
  const { call } = await connect(o, d.fetchFn);
  const r = await call('charter_run_python', { script: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /No payment was signed/);
  assert.deepEqual(d.seen.signed, []);
  assert.equal(fileSpendBook(o.spendFile, o.maxDay).spent(today()), 0n);
});

test('a 402 that names another payee is never signed', async () => {
  // The door says one payee at /v1/door and asks for another in the 402.
  const d = door({ '/v1/offers': [OFFER] });
  const real = d.fetchFn;
  const lying = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await real(input, init);
    const h = res.headers.get('payment-required');
    if (!h) return res;
    const req = JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
    for (const a of req.accepts) a.payTo = '0x000000000000000000000000000000000000dEaD';
    return new Response('{}', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(req)).toString('base64') } });
  }) as typeof fetch;
  const { call } = await connect(options(), lying);
  const r = await call('charter_rent_home', { sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake me'] });
  assert.equal(r.isError, true);
  assert.deepEqual(d.seen.signed, []);
});

test('a signed payment the facilitator refuses is not counted; any other answer after signing is', async () => {
  const refused = options();
  const a = door({ '/v1/offers': [OFFER] }, { onPaid: () => new Response('{}', { status: 402 }) });
  const r1 = await (await connect(refused, a.fetchFn)).call('charter_run_python', { script: 'x' });
  assert.match(r1.text, /turned down.*charter_wallet/s);
  assert.equal(a.seen.signed.length, 1);
  assert.equal(fileSpendBook(refused.spendFile, refused.maxDay).spent(today()), 0n);

  const busy = options();
  const b = door({ '/v1/offers': [OFFER] }, { onPaid: () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 }) });
  const r2 = await (await connect(busy, b.fetchFn)).call('charter_run_python', { script: 'x' });
  assert.match(r2.text, /busy/);
  assert.equal(fileSpendBook(busy.spendFile, busy.maxDay).spent(today()), 7000n);
});

test('an answer that comes before any payment is signed is not counted', async () => {
  const o = options();
  const d = door({ '/v1/offers': [OFFER] }, { post: () => new Response(JSON.stringify({ error: 'busy' }), { status: 409 }) });
  const r = await (await connect(o, d.fetchFn)).call('charter_run_python', { script: 'x' });
  assert.match(r.text, /busy/);
  assert.equal(fileSpendBook(o.spendFile, o.maxDay).spent(today()), 0n);
});

test('the daily cap stops the paid call that would cross it, with nothing sent', async () => {
  const o = options({ maxDay: 10_000n });
  const d = door({ '/v1/offers': [OFFER], ...done('ok\n') });
  const { call } = await connect(o, d.fetchFn);
  assert.equal((await call('charter_run_python', { script: 'x', waitSeconds: 10 })).isError, false);
  const second = await call('charter_run_python', { script: 'x', waitSeconds: 10 });
  assert.match(second.text, /day's cap is reached: 0.007 of 0.01/);
  assert.equal(d.seen.signed.length, 1);
  assert.equal(d.seen.unpaidPosts.length, 1);
});

test('the server talks to the door origin only and follows no redirect', async () => {
  const o = options();
  const d = door({ '/v1/offers': [OFFER] });
  // A fetch that honours `redirect: 'error'` the way the platform does.
  const redirecting = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === 'POST') {
      assert.equal(req.redirect, 'error');
      throw new TypeError('fetch failed: unexpected redirect');
    }
    return d.fetchFn(input, init);
  }) as typeof fetch;
  const r = await (await connect(o, redirecting)).call('charter_run_python', { script: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /No payment was signed; nothing was charged/);
  assert.ok(d.seen.urls.every((u) => u.startsWith(`${DOOR}/`)));
  assert.equal(fileSpendBook(o.spendFile, o.maxDay).spent(today()), 0n);
});

test('when the door cannot say where payments go, nothing is signed and nothing is counted', async () => {
  const o = options();
  const d = door({ '/v1/offers': [OFFER] }, { payTo: 'not an address' });
  const r = await (await connect(o, d.fetchFn)).call('charter_run_python', { script: 'x' });
  assert.match(r.text, /cannot tell where payments go.*No payment was signed/s);
  assert.deepEqual(d.seen.signed, []);
  assert.equal(fileSpendBook(o.spendFile, o.maxDay).spent(today()), 0n);
});

test('the first run makes a wallet key file only the owner can read, and the next run reuses it', async () => {
  const o = options();
  const first = await connect(o, door({}).fetchFn);
  assert.match(first.address!, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(statSync(o.keyFile).mode & 0o777, 0o600);
  const second = await connect(o, door({}).fetchFn);
  assert.equal(second.address, first.address);
});

test('a key file that is not a key stops the server instead of being replaced', () => {
  const o = options();
  writeFileSync(o.keyFile, 'not a key\n');
  assert.throws(() => loadKey(o.keyFile, true), /must hold one private key/);
  assert.equal(readFileSync(o.keyFile, 'utf8'), 'not a key\n');
});

test('with no key and key making off, the free tools work and the paid ones refuse without sending', async () => {
  const d = door({ '/v1/offers': [OFFER] });
  const { call, address } = await connect(options({ makeKey: false }), d.fetchFn);
  assert.equal(address, undefined);
  const offers = JSON.parse((await call('charter_offers')).text);
  assert.equal(offers.offers[0].usdcPerInterval, '0.007');
  assert.equal(offers.maxUsdcPerDay, '0.25');
  const wallet = JSON.parse((await call('charter_wallet')).text);
  assert.equal(wallet.paidTools, 'off');
  const run = await call('charter_run_python', { script: 'print(1)' });
  assert.equal(run.isError, true);
  assert.match(run.text, /no wallet key/);
  assert.deepEqual(d.seen.unpaidPosts, []);
});

test('charter_offers passes each host\'s operator and record through', async () => {
  const record = { probesPassed: 3, leasesFinished: 12, successRate: 0.92, new: false };
  const d = door({ '/v1/offers': [{ ...OFFER, operator: 'independent', record }] });
  const { call } = await connect(options({ makeKey: false }), d.fetchFn);
  const offers = JSON.parse((await call('charter_offers')).text);
  assert.equal(offers.offers[0].operator, 'independent');
  assert.deepEqual(offers.offers[0].record, record);
});

test('a private key handed to charter_rent_home is refused before anything is sent', async () => {
  const d = door({ '/v1/offers': [OFFER] });
  const { call } = await connect(options(), d.fetchFn);
  const priv = await call('charter_rent_home', { sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----'] });
  assert.equal(priv.isError, true);
  assert.match(priv.text, /private key.*PUBLIC/s);
  const junk = await call('charter_rent_home', { sshKeys: ['hello'] });
  assert.match(junk.text, /one public key line/);
  assert.deepEqual(d.seen.urls, []);
});

test('the free tools never send a POST', async () => {
  const d = door({ '/v1/offers': [OFFER], ...done('4\n') });
  const { call } = await connect(options(), d.fetchFn);
  await call('charter_offers');
  const r = JSON.parse((await call('charter_lease', { leaseId: ID })).text);
  assert.equal(r.lease.state, 'done');
  assert.equal(r.output.stdout, '4\n');
  assert.equal((await call('charter_lease', { leaseId: 'd'.repeat(32) })).isError, true);
  assert.deepEqual(d.seen.unpaidPosts, []);
  assert.deepEqual(d.seen.signed, []);
});

test('the spend book reserves within the cap as one step and survives a restart', () => {
  const o = options();
  const a = fileSpendBook(o.spendFile, 20_000n);
  assert.equal(a.spent('2026-11-18'), 0n);
  assert.equal(a.reserve('2026-11-18', 7000n), true);
  assert.equal(a.reserve('2026-11-18', 7000n), true);
  // A second server on the same file sees the first one's spend.
  const b = fileSpendBook(o.spendFile, 20_000n);
  assert.equal(b.spent('2026-11-18'), 14_000n);
  assert.equal(b.reserve('2026-11-18', 7000n), false);
  assert.equal(b.spent('2026-11-18'), 14_000n);
  assert.equal(b.reserve('2026-11-18', -1n), false);
  a.release('2026-11-18', 50_000n);
  assert.equal(a.spent('2026-11-18'), 0n);
  assert.equal(a.reserve('2026-11-19', 7000n), true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(o.spendFile, 'utf8'))), ['2026-11-19']);
  assert.equal(existsSync(`${o.spendFile}.lock`), false);
});

test('a damaged spend book stops payments instead of counting as nothing spent', async () => {
  const o = options();
  for (const bad of ['garbage', '[]', '{"2026-11-18":7000}', '{"2026-11-18":"-5"}']) {
    writeFileSync(o.spendFile, bad);
    const book = fileSpendBook(o.spendFile, 250_000n);
    assert.throws(() => book.spent('2026-11-18'), CapError, bad);
    assert.throws(() => book.reserve('2026-11-18', 7000n), /damaged.*nothing is paid/, bad);
    assert.equal(existsSync(`${o.spendFile}.lock`), false, 'the lock is released after a refusal');
  }
  const d = door({ '/v1/offers': [OFFER] });
  const r = await (await connect(o, d.fetchFn)).call('charter_run_python', { script: 'x' });
  assert.match(r.text, /damaged/);
  assert.deepEqual(d.seen.signed, []);
});

test('a lock left by a dead server is cleared; a live one is waited for and then refused', () => {
  const o = options();
  const book = fileSpendBook(o.spendFile, 250_000n);
  mkdirSync(`${o.spendFile}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${o.spendFile}.lock`, old, old);
  assert.equal(book.reserve('2026-11-18', 7000n), true);
  mkdirSync(`${o.spendFile}.lock`);
  assert.throws(() => book.reserve('2026-11-18', 7000n), /locked by another server; nothing was paid/);
  assert.equal(JSON.parse(readFileSync(o.spendFile, 'utf8'))['2026-11-18'], '7000');
});

test('options come from the environment with safe defaults and refuse a cap that is not a number', () => {
  const d = optionsFromEnv({});
  assert.equal(d.door, 'https://charterhome.dev');
  assert.equal(d.maxHour, 10_000n);
  assert.equal(d.maxDay, 250_000n);
  assert.equal(d.makeKey, true);
  const o = optionsFromEnv({ CHARTER_DOOR_URL: 'http://127.0.0.1:8787/', CHARTER_MAX_USDC_PER_DAY: '1', CHARTER_MCP_NO_NEW_KEY: '1' });
  assert.equal(o.door, 'http://127.0.0.1:8787');
  assert.equal(o.maxDay, 1_000_000n);
  assert.equal(o.makeKey, false);
  assert.throws(() => optionsFromEnv({ CHARTER_MAX_USDC_PER_HOUR: 'lots' }), /not a USDC amount/);
});

const PITCH = { name: 'Ada', pitch: 'I run a small bot', sshKeys: ['ssh-ed25519 AAAA one'] };

test('the pitch tool lists as free and passes the door error through', async () => {
  const { client, call } = await connect(options(), door({}, { post: () => new Response(JSON.stringify({ error: 'fund_closed' }), { status: 503 }) }).fetchFn);
  const t = (await client.listTools()).tools.find((x) => x.name === 'charter_grant_pitch')!;
  assert.ok(t.description!.startsWith('Free.'));
  for (const w of [/ask your operator/i, /model/, /\/grants/, /30 days/, /Anyone/, /grantToken/, /operator can read the home's disk/]) assert.match(t.description!, w);
  assert.equal(t.annotations?.readOnlyHint, false);
  const r = await call('charter_grant_pitch', PITCH);
  assert.equal(r.isError, true);
  assert.match(r.text, /the fund is closed right now \(fund_closed\)/);
});

test('a pitch is a plain POST to the door: no payment, no key made use of, and the token comes back', async () => {
  let posted: any;
  const d = door({}, { post: () => new Response(JSON.stringify({ grantId: 'g9', grantToken: 'secret-token', state: 'queued', next: 'read /grants' }), { status: 201 }) });
  const o = options();
  const inner = d.fetchFn;
  const spy = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(i, init);
    if (req.method === 'POST') {
      posted = { url: req.url, pay: req.headers.has('payment-signature') || req.headers.has('x-payment'), body: await req.clone().json() };
    }
    return inner(req);
  }) as typeof fetch;
  const { call } = await connect(o, spy);
  const r = await call('charter_grant_pitch', PITCH);
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).grantToken, 'secret-token');
  assert.deepEqual(posted, { url: `${DOOR}/v1/grants`, pay: false, body: PITCH });
  assert.deepEqual(d.seen.signed, []);
});

test('charter_grant_status sends the token as a header and shows the owner view', async () => {
  let token: string | null = null;
  const fetchFn = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(i, init);
    token = req.headers.get('x-grant-token');
    return new Response(JSON.stringify({ grantId: 'g9', state: 'approved', leaseId: ID }), { status: 200 });
  }) as typeof fetch;
  const { call } = await connect(options(), fetchFn);
  const r = await call('charter_grant_status', { grantId: 'g9', grantToken: 'secret-token' });
  assert.equal(token, 'secret-token');
  assert.equal(JSON.parse(r.text).leaseId, ID);
});

test('charter_grant_status with a token the door refuses says the token does not match', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ error: 'bad_token' }), { status: 403 })) as typeof fetch;
  const { call } = await connect(options(), fetchFn);
  const r = await call('charter_grant_status', { grantId: 'g9', grantToken: 'wrong-token' });
  assert.equal(r.isError, true);
  assert.match(r.text, /the token does not match this grant/);
});

const AKEY = 'ssh-ed25519 AAAA one';
const AID = 'b'.repeat(32);

test('charter_allowance_link is a free POST and hands back the message and token', async () => {
  let posted: any;
  const fetchFn = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(i, init);
    posted = { url: req.url, pay: req.headers.has('payment-signature'), body: await req.clone().json() };
    return new Response(JSON.stringify({ allowanceId: AID, ownerToken: 'tok9', approveUrl: 'https://charterhome.dev/allow/' + AID, state: 'waiting', next: 'x' }), { status: 201 });
  }) as typeof fetch;
  const { client, call } = await connect(options(), fetchFn);
  const t = (await client.listTools()).tools.find((x) => x.name === 'charter_allowance_link')!;
  assert.ok(t.description!.startsWith('Free.'));
  const r = await call('charter_allowance_link', { sshKeys: [AKEY] });
  assert.equal(r.isError, false, r.text);
  const b = JSON.parse(r.text);
  assert.equal(b.ownerToken, 'tok9');
  assert.match(b.message, /Coinbase/);
  assert.deepEqual(posted, { url: `${DOOR}/v1/allowances`, pay: false, body: { sshKeys: [AKEY] } });
});

test('charter_allowance_link says to open the home first when the door has none', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ error: 'no_home' }), { status: 404 })) as typeof fetch;
  const { call } = await connect(options(), fetchFn);
  const r = await call('charter_allowance_link', { sshKeys: [AKEY] });
  assert.equal(r.isError, true);
  assert.match(r.text, /open the home and pay its first hour first/);
});

test('charter_allowance_status and stop send the owner token as a header', async () => {
  const seen: { method: string; url: string; token: string | null }[] = [];
  const fetchFn = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(i, init);
    seen.push({ method: req.method, url: req.url, token: req.headers.get('x-allowance-token') });
    return new Response(JSON.stringify({ allowanceId: AID, state: req.method === 'POST' ? 'stopping' : 'active' }), { status: 200 });
  }) as typeof fetch;
  const { call } = await connect(options(), fetchFn);
  const s = await call('charter_allowance_status', { allowanceId: AID, ownerToken: 'tok9' });
  assert.equal(JSON.parse(s.text).state, 'active');
  const p = await call('charter_allowance_stop', { allowanceId: AID, ownerToken: 'tok9' });
  assert.equal(JSON.parse(p.text).state, 'stopping');
  assert.deepEqual(seen, [
    { method: 'GET', url: `${DOOR}/v1/allowances/${AID}`, token: 'tok9' },
    { method: 'POST', url: `${DOOR}/v1/allowances/${AID}/stop`, token: 'tok9' },
  ]);
});
