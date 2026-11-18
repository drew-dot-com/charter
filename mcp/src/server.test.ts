import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { build, fileSpendBook, loadKey, optionsFromEnv, type Options } from './server.js';

const ID = 'c'.repeat(32);
const OFFER = { offerId: 'host:one', cpu: 1, memoryMiB: 1024, tickPrice: '7000', intervalSeconds: 3600, images: ['charter-job-python', 'charter-home'], home: { diskGiB: 2, retentionDays: 7, slots: 2 } };

function options(over: Partial<Options> = {}): Options {
  const dir = mkdtempSync(join(tmpdir(), 'charter-mcp-'));
  return { door: 'https://door.test', keyFile: join(dir, 'mcp.key'), spendFile: join(dir, 'spend.json'), maxHour: 10_000n, maxDay: 250_000n, makeKey: true, ...over };
}

/** A door that answers only free reads; any POST fails the test, so a tool that should not pay is caught paying. */
function door(routes: Record<string, unknown>, posts: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? 'GET') !== 'GET') {
      posts.push(url.pathname);
      return new Response('{}', { status: 500 });
    }
    const hit = routes[url.pathname];
    return hit === undefined ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }) : new Response(JSON.stringify(hit), { status: 200 });
  }) as typeof fetch;
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

test('the server lists its seven tools, and every paid one says PAID first', async () => {
  const { client } = await connect(options(), door({}));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['charter_extend', 'charter_fetch_pages', 'charter_lease', 'charter_offers', 'charter_rent_home', 'charter_run_python', 'charter_wallet']);
  for (const t of tools) {
    const paid = ['charter_extend', 'charter_fetch_pages', 'charter_rent_home', 'charter_run_python'].includes(t.name);
    assert.equal(t.description!.startsWith('PAID.'), paid, t.name);
    assert.equal(t.description!.startsWith('Free.'), !paid, t.name);
    assert.equal(t.annotations?.readOnlyHint, !paid, t.name);
    assert.ok(!t.description!.includes(String.fromCharCode(0x2014)), `${t.name} has an em dash`);
  }
});

test('the first run makes a wallet key file only the owner can read, and the next run reuses it', async () => {
  const o = options();
  const first = await connect(o, door({}));
  assert.match(first.address!, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(statSync(o.keyFile).mode & 0o777, 0o600);
  const second = await connect(o, door({}));
  assert.equal(second.address, first.address);
});

test('a key file that is not a key stops the server instead of being replaced', () => {
  const o = options();
  writeFileSync(o.keyFile, 'not a key\n');
  assert.throws(() => loadKey(o.keyFile, true), /must hold one private key/);
  assert.equal(readFileSync(o.keyFile, 'utf8'), 'not a key\n');
});

test('with no key and key making off, the free tools work and the paid ones refuse without sending', async () => {
  const posts: string[] = [];
  const { call, address } = await connect(options({ makeKey: false }), door({ '/v1/offers': [OFFER] }, posts));
  assert.equal(address, undefined);
  const offers = JSON.parse((await call('charter_offers')).text);
  assert.equal(offers.offers[0].usdcPerInterval, '0.007');
  assert.equal(offers.maxUsdcPerDay, '0.25');
  const wallet = JSON.parse((await call('charter_wallet')).text);
  assert.equal(wallet.paidTools, 'off');
  const run = await call('charter_run_python', { script: 'print(1)' });
  assert.equal(run.isError, true);
  assert.match(run.text, /no wallet key/);
  assert.deepEqual(posts, []);
});

test('a private key handed to charter_rent_home is refused before anything is sent', async () => {
  const posts: string[] = [];
  const { call } = await connect(options(), door({ '/v1/offers': [OFFER] }, posts));
  const priv = await call('charter_rent_home', { sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----'] });
  assert.equal(priv.isError, true);
  assert.match(priv.text, /private key.*PUBLIC/s);
  const junk = await call('charter_rent_home', { sshKeys: ['hello'] });
  assert.match(junk.text, /one public key line/);
  assert.deepEqual(posts, []);
});

test('charter_lease reads a finished job and decodes its output', async () => {
  const data = Buffer.from(JSON.stringify({ kind: 'python', exitCode: 0, stdout: '4\n', stderr: '' })).toString('base64');
  const { call } = await connect(
    options(),
    door({ [`/v1/leases/${ID}`]: { lease: { state: 'done', paidIntervals: 1, paidThrough: 1, outputParts: 1 }, stopped: false }, [`/v1/leases/${ID}/output/0`]: { part: 0, parts: 1, data } }),
  );
  const r = JSON.parse((await call('charter_lease', { leaseId: ID })).text);
  assert.equal(r.lease.state, 'done');
  assert.equal(r.output.stdout, '4\n');
  const unknown = await call('charter_lease', { leaseId: 'd'.repeat(32) });
  assert.equal(unknown.isError, true);
});

test('the spend book survives a restart, keeps only today and never goes below zero', () => {
  const o = options();
  const a = fileSpendBook(o.spendFile, 250_000n);
  assert.equal(a.spent('2026-11-18'), 0n);
  a.add('2026-11-18', 7000n);
  a.add('2026-11-18', 7000n);
  assert.equal(fileSpendBook(o.spendFile, 250_000n).spent('2026-11-18'), 14_000n);
  a.add('2026-11-18', -20_000n);
  assert.equal(a.spent('2026-11-18'), 0n);
  a.add('2026-11-19', 7000n);
  assert.equal(a.spent('2026-11-18'), 0n);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(o.spendFile, 'utf8'))), ['2026-11-19']);
  writeFileSync(o.spendFile, 'garbage');
  assert.equal(a.spent('2026-11-19'), 0n);
});

test('options come from the environment with safe defaults and refuse a cap that is not a number', () => {
  const d = optionsFromEnv({});
  assert.equal(d.door, 'https://charter.mainnet.toonprotocol.dev');
  assert.equal(d.maxHour, 10_000n);
  assert.equal(d.maxDay, 250_000n);
  assert.equal(d.makeKey, true);
  const o = optionsFromEnv({ CHARTER_DOOR_URL: 'http://127.0.0.1:8787/', CHARTER_MAX_USDC_PER_DAY: '1', CHARTER_MCP_NO_NEW_KEY: '1' });
  assert.equal(o.door, 'http://127.0.0.1:8787');
  assert.equal(o.maxDay, 1_000_000n);
  assert.equal(o.makeKey, false);
  assert.throws(() => optionsFromEnv({ CHARTER_MAX_USDC_PER_HOUR: 'lots' }), /not a USDC amount/);
});
