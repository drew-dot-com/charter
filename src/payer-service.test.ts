import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSelfDescription } from '@toon-protocol/client';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { DeadlinePassedError, PacketRefusedError, type PacketAnswer, type Payer } from './payer.js';
import { DailyBudget, loadNostrKey, payerService, receiptOf, type NostrEvent, type PayerServiceDeps } from './payer-service.js';
import { UrlPayer } from './payer-url.js';

const SEAL = '0x04' + 'cd'.repeat(64);
const CONNECTOR = 'https://edge.example/ilp';
const DESC = parseSelfDescription(
  {
    ilpAddresses: ['g.drew'],
    httpEndpoint: CONNECTOR,
    peerCarriages: ['http'],
    edgeIdentity: { keyId: 'connector-signer', publicKey: SEAL },
    batchSettlements: [],
    voucherSigners: [],
    routes: [
      { prefix: 'g.drew.anon', price: '1000' },
      { prefix: 'g.drew.relay', price: '1000' },
      { prefix: 'g.drew.ario', price: '1000', pricePerKib: '30' },
    ],
    supportedVersions: [1],
    defaultVersion: 1,
  },
  CONNECTOR,
);

type Sent = { dest: string; req: { method: string; path: string; body?: unknown }; opts: { sealKey: string; sealUrl: string; amount: bigint; priority?: string; deadline?: number } };

function start(answer: (s: Sent) => PacketAnswer | Promise<PacketAnswer>, extra: Partial<PayerServiceDeps> = {}) {
  const sent: Sent[] = [];
  const payer: Payer = {
    async send(dest, req, opts) {
      const s = { dest, req, opts } as Sent;
      sent.push(s);
      return answer(s);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'charter-payer-service-'));
  const key = loadNostrKey(join(dir, 'nostr.key'));
  const logs: string[] = [];
  const budget = extra.budget ?? new DailyBudget(join(dir, 'budget.json'), 100_000n);
  const handler = payerService({
    payer,
    describe: async () => DESC,
    connectorUrl: CONNECTOR,
    channel: async () => ({ chain: 'evm', headroom: '1800000' }),
    nostrKey: () => key,
    log: (l) => logs.push(l),
    version: 'test',
    ...extra,
    budget,
  });
  const server: Server = createServer(handler);
  return new Promise<{ url: string; sent: Sent[]; logs: string[]; key: Uint8Array; dir: string; budget: DailyBudget; close: () => void }>((r) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      r({ url: `http://127.0.0.1:${port}`, sent, logs, key, dir, budget, close: () => server.close() });
    }),
  );
}

const ok = (status: number, body: unknown, paid: bigint): PacketAnswer => ({ status, body, paid });
const get = async (url: string) => {
  const r = await fetch(url);
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

test('/send is the Payer interface over HTTP: the UrlPayer round trip hands the inner payer the same call', async () => {
  const s = await start((x) => ok(200, { lease: { id: 'L', state: 'running' } }, x.opts.amount));
  try {
    const p = new UrlPayer(s.url);
    const a = await p.send('g.h.charter-status', { method: 'GET', path: '/leases/L' }, { sealKey: SEAL, sealUrl: 'https://h.example/ilp', amount: 100n, priority: 'high', deadline: 5_000_000 });
    assert.deepEqual(a, { status: 200, body: { lease: { id: 'L', state: 'running' } }, paid: 100n });
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0]!.req, { method: 'GET', path: '/leases/L' });
    assert.deepEqual(s.sent[0]!.opts, { sealKey: SEAL, sealUrl: 'https://h.example/ilp', amount: 100n, priority: 'high', deadline: 5_000_000 });
    assert.match(s.logs.join('\n'), /send g\.h\.charter-status GET \/leases\/L -> 200 paid=100/);
  } finally {
    s.close();
  }
});

test('/send passes a body through untouched and refuses a malformed request before any send', async () => {
  const s = await start((x) => ok(200, { paidIntervals: 1 }, x.opts.amount));
  try {
    const good = await post(`${s.url}/send`, { dest: 'g.h.charter-tick', method: 'POST', path: '/tick', body: { leaseId: 'L', index: 0, nested: [1, 'two'] }, sealKey: SEAL, sealUrl: 'u', amount: '7000' });
    assert.equal(good.status, 200);
    assert.deepEqual(good.json, { status: 200, body: { paidIntervals: 1 }, paid: '7000' });
    assert.deepEqual(s.sent[0]!.req.body, { leaseId: 'L', index: 0, nested: [1, 'two'] });
    const bad = [
      { method: 'POST', path: '/', sealKey: SEAL, sealUrl: 'u', amount: '1' },
      { dest: 'g.h', method: 'PUT', path: '/', sealKey: SEAL, sealUrl: 'u', amount: '1' },
      { dest: 'g.h', method: 'GET', path: '/', sealKey: '0x04ab', sealUrl: 'u', amount: '1' },
      { dest: 'g.h', method: 'GET', path: '/', sealKey: SEAL, sealUrl: 'u', amount: '1.5' },
      { dest: 'g.h', method: 'GET', path: '/', sealKey: SEAL, sealUrl: 'u', amount: 7 },
      { dest: 'g.h', method: 'GET', path: '/', sealKey: SEAL, sealUrl: 'u', amount: '1', priority: 'low' },
    ];
    for (const b of bad) {
      const r = await post(`${s.url}/send`, b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.code, 'bad_request');
    }
    const notJson = await fetch(`${s.url}/send`, { method: 'POST', body: '{nope' });
    assert.equal(notJson.status, 400);
    assert.equal(s.sent.length, 1);
  } finally {
    s.close();
  }
});

test('/send carries a send failure back as the error the local payer threw', async () => {
  let n = 0;
  const s = await start(() => {
    n++;
    if (n === 1) throw new PacketRefusedError('F03', 'g.edge', 'amount above price');
    if (n === 2) throw new DeadlinePassedError();
    throw new Error('channel store unreadable');
  });
  try {
    const p = new UrlPayer(s.url);
    const opts = { sealKey: SEAL, sealUrl: 'u', amount: 1n };
    await assert.rejects(p.send('g.h', { method: 'GET', path: '/' }, opts), (e: unknown) => e instanceof PacketRefusedError && e.code === 'F03' && e.refusedBy === 'g.edge');
    await assert.rejects(p.send('g.h', { method: 'GET', path: '/' }, opts), (e: unknown) => e instanceof DeadlinePassedError);
    const r = await post(`${s.url}/send`, { dest: 'g.h', method: 'GET', path: '/', sealKey: SEAL, sealUrl: 'u', amount: '1' });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: 'send_failed', message: 'channel store unreadable' });
  } finally {
    s.close();
  }
});

test('/extract pays the extract route a signed kind 5301 job sealed to the connector and answers the sidecar shape', async () => {
  const receipt = { url: 'https://example.com/', final_url: 'https://example.com/', status: 200, title: 'Example', content: '# Example', content_hash: 'c'.repeat(64), raw_hash: 'r'.repeat(64), protocol: 'wuzzy/crawl', protocol_version: 1, format: 'markdown', thin: false, truncated: false, content_bytes: 9, returned_bytes: 9, bytes: 1256, via: 'anyone', fetched_at: '2026-11-05T10:00:00Z', elapsed_ms: 1200, job_id: 'J1' };
  const s = await start((x) => ok(200, { accept: true, result: receipt, data: Buffer.from(JSON.stringify(receipt)).toString('base64'), payer: '0xB', amount: '1000', chain: 'evm' }, x.opts.amount));
  try {
    const r = await get(`${s.url}/extract?url=${encodeURIComponent('https://example.com')}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.content, '# Example');
    assert.equal(r.json.content_hash, 'c'.repeat(64));
    assert.equal(r.json.exit, 'anyone');
    assert.equal(r.json.job_id, 'J1');
    assert.deepEqual(r.json.price, { units: '1000', asset: 'USDC', decimals: 6, chain: 'evm' });
    assert.deepEqual(r.json.node, { edge: CONNECTOR, destination: 'g.drew.anon' });
    assert.equal((r.json.budget as { spent: string }).spent, '1000');
    const sent = s.sent[0]!;
    assert.equal(sent.dest, 'g.drew.anon');
    assert.equal(sent.req.method, 'POST');
    assert.equal(sent.req.path, '/');
    assert.deepEqual(sent.opts, { sealKey: SEAL, sealUrl: CONNECTOR, amount: 1000n });
    const ev = (sent.req.body as { event: NostrEvent }).event;
    assert.equal(ev.kind, 5301);
    assert.ok(verifyEvent(ev));
    assert.deepEqual(ev.tags, [
      ['param', 'url', 'https://example.com/'],
      ['param', 'method', 'GET'],
      ['param', 'mode', 'extract'],
    ]);
  } finally {
    s.close();
  }
});

test('/extract refuses a bad url unpaid, reports an app rejection as node_refused with what it cost, and stops at the daily cap', async () => {
  const s = await start(() => ok(200, { accept: false, code: 'F00', message: 'bad job' }, 1000n), { budget: new DailyBudget(undefined, 1500n) });
  try {
    for (const bad of ['', 'ftp://x', 'nota url']) {
      const r = await get(`${s.url}/extract?url=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'bad_url');
    }
    assert.equal(s.sent.length, 0);
    const refused = await get(`${s.url}/extract?url=https://example.com`);
    assert.equal(refused.status, 502);
    assert.equal(refused.json.code, 'node_refused');
    assert.match(String(refused.json.error), /F00 bad job/);
    assert.equal(refused.json.paid, '1000');
    // 1000 spent of a 1500 cap: the next 1000 does not fit, and nothing is sent.
    const capped = await get(`${s.url}/extract?url=https://example.com`);
    assert.equal(capped.status, 402);
    assert.equal(capped.json.code, 'budget_exhausted');
    assert.equal(s.sent.length, 1);
  } finally {
    s.close();
  }
});

test('/fetch is the raw mode of the same job', async () => {
  const s = await start((x) => ok(200, { accept: true, result: { url: 'https://e.com/', status: 200, body: 'hi', via: 'anyone' } }, x.opts.amount));
  try {
    const r = await get(`${s.url}/fetch?url=https://e.com&method=head`);
    assert.equal(r.status, 200);
    assert.equal(r.json.body, 'hi');
    assert.equal(r.json.exit, 'anyone');
    const ev = (s.sent[0]!.req.body as { event: NostrEvent }).event;
    assert.deepEqual(ev.tags, [
      ['param', 'url', 'https://e.com/'],
      ['param', 'method', 'HEAD'],
      ['param', 'mode', 'raw'],
    ]);
  } finally {
    s.close();
  }
});

test('a metered route is priced over the body it will carry', async () => {
  const s = await start((x) => ok(200, { accept: true, result: {} }, x.opts.amount), { extractRoute: 'g.drew.ario' });
  try {
    const r = await get(`${s.url}/extract?url=https://e.com`);
    assert.equal(r.status, 200);
    const amount = s.sent[0]!.opts.amount;
    assert.ok(amount > 1000n && amount < 1100n, amount.toString());
  } finally {
    s.close();
  }
});

test('/relay/post signs a kind 1 note with the service key and pays the relay route; the note is what came back', async () => {
  const s = await start((x) => ok(200, { eventId: 'e', storedAt: 1 }, x.opts.amount));
  try {
    const r = await post(`${s.url}/relay/post`, { content: 'hello from the box', tags: [['t', 'charter']] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ok, true);
    assert.equal(r.json.paid, '1000');
    assert.equal(r.json.route, 'g.drew.relay');
    assert.equal(r.json.relay, 'wss://relay.mainnet.toonprotocol.dev');
    assert.deepEqual(r.json.relay_answer, { eventId: 'e', storedAt: 1 });
    const ev = r.json.event as NostrEvent;
    assert.equal(ev.kind, 1);
    assert.equal(ev.content, 'hello from the box');
    assert.deepEqual(ev.tags, [['t', 'charter']]);
    assert.equal(ev.pubkey, getPublicKey(s.key));
    assert.ok(verifyEvent(ev));
    assert.deepEqual((s.sent[0]!.req.body as { event: NostrEvent }).event, ev);
    assert.equal(s.sent[0]!.dest, 'g.drew.relay');
    assert.deepEqual(s.sent[0]!.opts, { sealKey: SEAL, sealUrl: CONNECTOR, amount: 1000n });
    const health = await get(`${s.url}/health`);
    assert.equal(health.json.nostr_pubkey, ev.pubkey);
  } finally {
    s.close();
  }
});

test('/relay/post refuses empty, oversize or malformed input unpaid and reports a relay rejection as paid but not ok', async () => {
  const s = await start((x) => ok(422, { error: 'Invalid event signature' }, x.opts.amount));
  try {
    for (const body of [{}, { content: '  ' }, { content: 'x'.repeat(4001) }, { content: 'x', kind: 'one' }, { content: 'x', tags: ['t'] }]) {
      const r = await post(`${s.url}/relay/post`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(s.sent.length, 0);
    const r = await post(`${s.url}/relay/post`, { content: 'x' });
    assert.equal(r.status, 502);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.relay_status, 422);
    assert.equal(r.json.paid, '1000');
  } finally {
    s.close();
  }
});

test('/relay/read hands the filter to the reader with a bounded limit and returns its events; a bad filter or relay is refused', async () => {
  const reads: Array<{ relay: string; filter: unknown; timeoutMs: number }> = [];
  const s = await start(() => ok(200, {}, 0n), {
    relayRead: async (relay, filter, timeoutMs) => {
      reads.push({ relay, filter, timeoutMs });
      return [{ id: 'a', pubkey: 'p', created_at: 1, kind: 1, tags: [], content: 'c', sig: 's' }];
    },
  });
  try {
    const r = await get(`${s.url}/relay/read?filter=${encodeURIComponent(JSON.stringify({ kinds: [1], limit: 9999 }))}&timeout_ms=99999`);
    assert.equal(r.status, 200);
    assert.equal(r.json.count, 1);
    assert.equal((r.json.events as unknown[]).length, 1);
    assert.deepEqual(reads[0], { relay: 'wss://relay.mainnet.toonprotocol.dev', filter: { kinds: [1], limit: 500 }, timeoutMs: 60_000 });
    const r2 = await get(`${s.url}/relay/read?relay=wss://other.example`);
    assert.equal(r2.status, 200);
    assert.deepEqual(reads[1], { relay: 'wss://other.example', filter: { limit: 10 }, timeoutMs: 15_000 });
    assert.equal((await get(`${s.url}/relay/read?filter=[1]`)).status, 400);
    assert.equal((await get(`${s.url}/relay/read?relay=https://x`)).status, 400);
    assert.equal(s.sent.length, 0);
  } finally {
    s.close();
  }
});

test('/health names the payer address at top level, even when the channel cannot be read', async () => {
  const s = await start(() => ok(200, {}, 0n), {
    payerAddress: '0xabc',
    channel: async () => {
      throw new Error('no rpc');
    },
  });
  try {
    const h = await get(`${s.url}/health`);
    assert.equal(h.json.payer, '0xabc');
    assert.equal(typeof (h.json.channel as { error: unknown }).error, 'string');
    const bare = await start(() => ok(200, {}, 0n));
    try {
      assert.equal((await get(`${bare.url}/health`)).json.payer, null);
    } finally {
      bare.close();
    }
  } finally {
    s.close();
  }
});

test('/health says what the service is and 404 lists the surface', async () => {
  const s = await start(() => ok(200, {}, 0n));
  try {
    const h = await get(`${s.url}/health`);
    assert.equal(h.status, 200);
    assert.equal(h.json.service, 'charter-payer');
    assert.equal(h.json.connector, CONNECTOR);
    assert.deepEqual(h.json.routes, { extract: 'g.drew.anon', relay: 'g.drew.relay' });
    assert.deepEqual(h.json.channel, { chain: 'evm', headroom: '1800000' });
    assert.equal((h.json.budget as { cap: string }).cap, '100000');
    const nf = await get(`${s.url}/nope`);
    assert.equal(nf.status, 404);
    assert.match(String(nf.json.error), /POST \/send/);
  } finally {
    s.close();
  }
});

test('the daily budget persists the day in its file, rolls at midnight UTC, and the Nostr key file is made once, mode 600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'charter-budget-'));
  let t = Date.UTC(2026, 10, 5, 23, 59, 0);
  const b = new DailyBudget(join(dir, 'b.json'), 2000n, () => t);
  assert.equal(b.check(1000n), undefined);
  b.record(1000n);
  assert.match(b.check(1500n) ?? '', /daily cap 2000 reached \(1000 spent today, 1500 asked\)/);
  const again = new DailyBudget(join(dir, 'b.json'), 2000n, () => t);
  assert.equal(again.view().spent, '1000');
  t += 2 * 60_000;
  assert.equal(again.view().spent, '0');
  assert.equal(again.view().day, '2026-11-06');
  const k1 = loadNostrKey(join(dir, 'k'));
  const k2 = loadNostrKey(join(dir, 'k'));
  assert.deepEqual(k1, k2);
  assert.equal(k1.length, 32);
  assert.equal(statSync(join(dir, 'k')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(dir, 'k'), 'utf8'), /^[0-9a-f]{64}\n$/);
});

test('a receipt is read from result, else from base64 data', () => {
  assert.deepEqual(receiptOf({ result: { a: 1 } }), { a: 1 });
  assert.deepEqual(receiptOf({ data: Buffer.from('{"b":2}').toString('base64') }), { b: 2 });
  assert.equal(receiptOf({ data: 'not base64 json' }), undefined);
  assert.equal(receiptOf('text'), undefined);
});
