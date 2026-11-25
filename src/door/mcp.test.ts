import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { HostApi } from '../tenant/host-api.js';
import { listedRegistry, OFFER } from '../tenant/test-host.js';
import type { Lease } from '../types.js';
import { GrantStore } from './grants.js';
import { DoorLedger } from './ledger.js';
import { MCP_POSTS_PER_MINUTE, MCP_TOOLS } from './mcp.js';
import { doorApp, type DoorDeps } from './server.js';

const LEASE = 'ab'.repeat(16);
const OFFER_ID = `${OFFER.hostId}:${OFFER.id}`;
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGtq0V1nJ0Qd3T6mQmWmYp1r0k0oH5oR1dQ0H0l0e0aB test';

function host(over: Partial<HostApi> = {}): HostApi {
  const lease: Lease = { leaseId: LEASE, state: 'running', createdAt: 1_000, paidIntervals: 1, paidThrough: 31_000 } as Lease;
  return {
    open: async () => ({ leaseId: LEASE, state: 'awaiting_first_tick' }),
    tick: async (_id, index) => ({ paidIntervals: index + 1, paidThrough: 31_000, duplicate: false }),
    status: async () => lease,
    output: async () => Buffer.alloc(0),
    outputPart: async (_id, part) => ({ part, parts: 1, data: Buffer.from(JSON.stringify({ stdout: '45\n', stderr: '', exitCode: 0 })).toString('base64') }),
    spent: () => 0n,
    ...over,
  };
}

async function start(over: Partial<DoorDeps> = {}, api: HostApi = host()) {
  const dir = mkdtempSync(join(tmpdir(), 'door-mcp-'));
  const clock = { t: 1_000_000 };
  const deps: DoorDeps = {
    offers: async () => [OFFER],
    api: () => api,
    registry: listedRegistry(dir),
    ledger: new DoorLedger(join(dir, 'ledger.json')),
    x402: 'free-for-tests',
    now: () => clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
    grants: new GrantStore(join(dir, 'grants.jsonl'), () => clock.t),
    ...over,
  };
  const server = doorApp(deps).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  return {
    base, clock,
    /** A real MCP client over streamable HTTP; `headers` ride on every request it makes. */
    client: async (headers: Record<string, string> = {}) => {
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
      clients.push(c);
      return c;
    },
    post: (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    close: async () => {
      for (const c of clients) await c.close().catch(() => undefined);
      server.closeAllConnections();
      server.close();
    },
  };
}

const textOf = (r: unknown): string => ((r as { content: Array<{ type: string; text: string }> }).content ?? []).map((c) => c.text).join('\n');
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true;

test('POST /mcp speaks MCP: it initializes and lists exactly the free tools', async () => {
  const d = await start();
  try {
    const c = await d.client();
    assert.equal(c.getServerVersion()?.name, 'charter');
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOLS].sort());
    assert.deepEqual([...MCP_TOOLS].sort(), ['charter_grant_pitch', 'charter_grant_status', 'charter_how_to_rent', 'charter_lease', 'charter_offers', 'charter_referral_status']);
    // No tool here pays or holds a wallet, and every description says it is free.
    for (const t of tools) {
      assert.match(t.description ?? '', /^Free\./, t.name);
      assert.doesNotMatch(t.description ?? '', /—/, `${t.name}: no em dash`);
    }
    assert.match(c.getInstructions() ?? '', /charter-mcp/);
  } finally {
    await d.close();
  }
});

test('charter_offers returns what GET /v1/offers returns', async () => {
  const d = await start();
  try {
    const c = await d.client();
    const r = await c.callTool({ name: 'charter_offers', arguments: {} });
    assert.equal(isError(r), false);
    assert.match(textOf(r), new RegExp(OFFER_ID));
  } finally {
    await d.close();
  }
});

test('charter_lease reads a lease the door knows, with a finished job\'s output decoded, and refuses one it does not', async () => {
  const done: Lease = { leaseId: LEASE, state: 'done', createdAt: 1_000, paidIntervals: 1, paidThrough: 31_000, outputParts: 1 } as Lease;
  const d = await start({}, host({ status: async () => done }));
  try {
    assert.equal((await d.post('/v1/leases', { offerId: OFFER_ID, urls: ['https://example.com'] })).status, 200);
    const c = await d.client();
    const r = await c.callTool({ name: 'charter_lease', arguments: { leaseId: LEASE } });
    assert.equal(isError(r), false, textOf(r));
    const body = JSON.parse(textOf(r));
    assert.equal(body.lease.state, 'done');
    assert.deepEqual(body.output, { exitCode: 0, stdout: '45\n', stderr: '' });

    const unknown = await c.callTool({ name: 'charter_lease', arguments: { leaseId: 'cd'.repeat(16) } });
    assert.equal(isError(unknown), true);
    assert.match(textOf(unknown), /does not know this lease/);
  } finally {
    await d.close();
  }
});

test('charter_grant_pitch and charter_grant_status go through the grant routes', async () => {
  const d = await start();
  try {
    const c = await d.client();
    const pitched = await c.callTool({ name: 'charter_grant_pitch', arguments: { name: 'tester', pitch: 'a box to run a nightly job', sshKeys: [KEY] } });
    assert.equal(isError(pitched), false, textOf(pitched));
    const { grantId, grantToken } = JSON.parse(textOf(pitched));
    assert.ok(grantId && grantToken);
    const status = await c.callTool({ name: 'charter_grant_status', arguments: { grantId, grantToken } });
    assert.equal(isError(status), false, textOf(status));
    assert.equal(JSON.parse(textOf(status)).state, 'queued');
    const wrong = await c.callTool({ name: 'charter_grant_status', arguments: { grantId, grantToken: 'nope' } });
    assert.equal(isError(wrong), true);

    // A refused pitch is an error that names the door's reason and says nothing was paid.
    const bad = await c.callTool({ name: 'charter_grant_pitch', arguments: { name: 'tester', pitch: 'x', sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----'] } });
    assert.equal(isError(bad), true);
    assert.match(textOf(bad), /nothing was paid/);
  } finally {
    await d.close();
  }
});

test('a pitch through /mcp counts against the caller\'s own hourly pitch limit, not the door\'s', async () => {
  // Behind one proxy the caller's address is the last X-Forwarded-For entry; the tool must hand it on.
  const d = await start({ trustProxy: 1 });
  try {
    const a = await d.client({ 'x-forwarded-for': '203.0.113.7' });
    const b = await d.client({ 'x-forwarded-for': '203.0.113.8' });
    const pitch = (c: Client, n: number) => c.callTool({ name: 'charter_grant_pitch', arguments: { name: 'tester', pitch: `pitch ${n}`, sshKeys: [`${KEY}${n}`] } });
    for (let n = 0; n < 5; n++) assert.equal(isError(await pitch(a, n)), false, `pitch ${n}`);
    const sixth = await pitch(a, 5);
    assert.equal(isError(sixth), true);
    assert.match(textOf(sixth), /rate_limited/);
    // Another caller is not held by the first one's pitches.
    assert.equal(isError(await pitch(b, 6)), false);
  } finally {
    await d.close();
  }
});

test('charter_referral_status and charter_how_to_rent answer without a wallet', async () => {
  const d = await start();
  try {
    const c = await d.client();
    const how = await c.callTool({ name: 'charter_how_to_rent', arguments: {} });
    assert.equal(isError(how), false);
    assert.match(textOf(how), /POST https:\/\/charterhome\.dev\/v1\/rent/);
    assert.match(textOf(how), /npx -y charter-mcp/);
    assert.doesNotMatch(textOf(how), /—/);
    // A door that pays no referrals answers with a share of 0, not an error.
    const ref = await c.callTool({ name: 'charter_referral_status', arguments: { address: `0x${'1'.repeat(40)}` } });
    assert.equal(isError(ref), false, textOf(ref));
    assert.equal(JSON.parse(textOf(ref)).bps, 0);
  } finally {
    await d.close();
  }
});

test('/mcp is POST only, stateless, and rate limited per caller', async () => {
  const d = await start();
  try {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${d.base}/mcp`, { method, headers: { accept: 'text/event-stream' } });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('allow'), 'POST');
    }
    const pre = await fetch(`${d.base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');

    const ping = () => fetch(`${d.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    const first = await ping();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('mcp-session-id'), null, 'no session is kept');
    assert.deepEqual(await first.json(), { jsonrpc: '2.0', id: 1, result: {} });
    for (let n = 1; n < MCP_POSTS_PER_MINUTE; n++) assert.equal((await ping()).status, 200);
    const over = await ping();
    assert.equal(over.status, 429);
    d.clock.t += 61_000;
    assert.equal((await ping()).status, 200);
  } finally {
    await d.close();
  }
});
