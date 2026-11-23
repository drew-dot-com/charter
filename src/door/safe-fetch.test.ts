import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { normalizeHostUrl } from './hosts.js';
import { blockedAddress, safeFetch, SafeFetchError } from './safe-fetch.js';

test('normalizeHostUrl refuses http, userinfo, query, fragment and inward IP literals', () => {
  for (const u of [
    'http://host.example',
    'https://user:pw@host.example',
    'https://user@host.example',
    'https://host.example/?a=1',
    'https://host.example/#top',
    'https://127.0.0.1',
    'https://127.8.9.10:8443',
    'https://localhost',
    'https://intranet',
    'https://10.1.2.3',
    'https://172.18.0.2',
    'https://172.31.255.255',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://0.0.0.0',
    'https://2130706433',
    'https://[::1]',
    'https://[::]',
    'https://[fc00::1]',
    'https://[fd12:3456::1]',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:ac12:2]',
    'not a url',
  ]) {
    assert.equal(normalizeHostUrl(u), null, u);
  }
});

test('normalizeHostUrl lowercases the host and drops a trailing slash', () => {
  assert.equal(normalizeHostUrl('https://Host.Example.COM/'), 'https://host.example.com');
  assert.equal(normalizeHostUrl('https://host.example.com:8443/charter//'), 'https://host.example.com:8443/charter');
  assert.equal(normalizeHostUrl('https://host.example.com:443'), 'https://host.example.com');
  assert.equal(normalizeHostUrl('https://8.8.8.8'), 'https://8.8.8.8');
  assert.equal(normalizeHostUrl('https://172.32.0.1'), 'https://172.32.0.1');
});

test('blockedAddress covers IPv4, IPv6 and IPv4 inside IPv6', () => {
  for (const a of ['127.0.0.1', '10.0.0.1', '172.18.0.2', '192.168.0.1', '169.254.1.1', '100.100.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fdff::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip']) {
    assert.equal(blockedAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(blockedAddress(a), false, a);
  }
});

interface Srv {
  url: (host?: string) => string;
  port: number;
  hits: IncomingMessage[];
  close: () => Promise<void>;
}

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Srv> {
  const hits: IncomingMessage[] = [];
  const s: Server = createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (host = 'host.test') => `http://${host}:${port}`,
    close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))),
  };
}

/** Lets a test reach its own server on 127.0.0.1 under a name the injected resolver answers. */
const local = { allowHttp: true, blocked: () => false, resolve: async () => ['127.0.0.1'] };

async function refusedWith(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof SafeFetchError && e.code === code);
}

test('safeFetch refuses a hostname that resolves to 127.0.0.1 and never connects', async () => {
  const s = await server((_req, res) => res.end('secret'));
  try {
    await refusedWith(safeFetch(s.url('rebind.test'), {}, { allowHttp: true, resolve: async () => ['127.0.0.1'] }), 'bad_url');
    await refusedWith(safeFetch(s.url('rebind.test'), {}, { allowHttp: true, resolve: async () => ['::ffff:127.0.0.1'] }), 'bad_url');
    await refusedWith(safeFetch(s.url('rebind.test'), {}, { allowHttp: true, resolve: async () => ['8.8.8.8', '172.18.0.2'] }), 'bad_url');
    await refusedWith(safeFetch(s.url('rebind.test'), {}, { allowHttp: true, resolve: async () => [] }), 'bad_url');
    await refusedWith(safeFetch(s.url('127.0.0.1'), {}, { allowHttp: true }), 'bad_url');
    assert.equal(s.hits.length, 0);
  } finally {
    await s.close();
  }
});

test('safeFetch refuses http, userinfo and other schemes by default', async () => {
  await refusedWith(safeFetch('http://host.example/x', {}, { resolve: async () => ['8.8.8.8'] }), 'bad_url');
  await refusedWith(safeFetch('https://u:p@host.example/x', {}, { resolve: async () => ['8.8.8.8'] }), 'bad_url');
  await refusedWith(safeFetch('file:///etc/passwd', {}), 'bad_url');
});

test('safeFetch resolves once and connects to the address it checked', async () => {
  const s = await server((req, res) => res.end(JSON.stringify({ host: req.headers.host, path: req.url })));
  try {
    let calls = 0;
    const r = await safeFetch(`${s.url('host.test')}/v1/offer?x=1`, {}, { ...local, resolve: async () => (calls++, ['127.0.0.1']) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { host: `host.test:${s.port}`, path: '/v1/offer?x=1' });
    assert.equal(calls, 1);
  } finally {
    await s.close();
  }
});

test('safeFetch takes a Request with method, headers and body, as the x402 fetch wrapper sends', async () => {
  const s = await server((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => res.writeHead(201, { 'x-seen': String(req.headers['x-door']) }).end(`${req.method} ${body}`));
  });
  try {
    const req = new Request(`${s.url()}/v1/leases`, { method: 'POST', headers: { 'x-door': 'yes', 'content-type': 'application/json' }, body: '{"a":1}' });
    const r = await safeFetch(req, {}, local);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-seen'), 'yes');
    assert.equal(await r.text(), 'POST {"a":1}');
  } finally {
    await s.close();
  }
});

test('safeFetch refuses a redirect', async () => {
  const s = await server((_req, res) => res.writeHead(302, { location: 'http://127.0.0.1:2375/' }).end());
  try {
    await refusedWith(safeFetch(s.url(), {}, local), 'redirect');
    assert.equal(s.hits.length, 1);
  } finally {
    await s.close();
  }
});

test('safeFetch stops at maxBytes while streaming', async () => {
  let written = 0;
  let aborted = false;
  const s = await server((_req, res) => {
    // Chunked, no content-length: the cap has to hold while the body arrives.
    res.on('close', () => (aborted = !res.writableFinished));
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    const pump = (): void => {
      while (written < 64 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  try {
    const r = await safeFetch(s.url(), { maxBytes: 1000 }, local);
    await refusedWith(r.text(), 'too_large');
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(aborted, 'the connection is dropped');
    assert.ok(written < 64 * 1024 * 1024, `server wrote ${written} bytes`);
  } finally {
    await s.close();
  }
});

test('safeFetch refuses a declared content-length over maxBytes and passes one at it', async () => {
  const s = await server((req, res) => res.writeHead(200, { 'content-length': req.url === '/big' ? '1001' : '1000' }).end(Buffer.alloc(req.url === '/big' ? 1001 : 1000)));
  try {
    await refusedWith(safeFetch(`${s.url()}/big`, { maxBytes: 1000 }, local), 'too_large');
    const ok = await safeFetch(`${s.url()}/fits`, { maxBytes: 1000 }, local);
    assert.equal((await ok.arrayBuffer()).byteLength, 1000);
  } finally {
    await s.close();
  }
});

test('safeFetch times out a host that never answers', async () => {
  const s = await server(() => undefined);
  try {
    await refusedWith(safeFetch(s.url(), { timeoutMs: 100 }, local), 'timeout');
  } finally {
    await s.close();
  }
});

test("safeFetch rejects with the caller's abort reason", async () => {
  const s = await server(() => undefined);
  try {
    const c = new AbortController();
    const why = new Error('caller gave up');
    setTimeout(() => c.abort(why), 50);
    await assert.rejects(safeFetch(s.url(), { signal: c.signal }, local), (e) => e === why);
  } finally {
    await s.close();
  }
});
