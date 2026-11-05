import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { DeadlinePassedError, PacketRefusedError, SendTimeoutError } from './payer.js';
import { PayerServiceError, UrlPayer } from './payer-url.js';

const SEAL = '0x04' + 'ab'.repeat(64);
const OPTS = { sealKey: SEAL, sealUrl: 'https://c.example/ilp', amount: 7000n };

/** A stand-in service that records the one request and answers with `status` and `body`. */
async function fakeService(status: number, body: unknown): Promise<{ url: string; seen: { method?: string; path?: string; body?: unknown }; close: () => void }> {
  const seen: { method?: string; path?: string; body?: unknown } = {};
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.method = req.method;
      seen.path = req.url;
      seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, seen, close: () => server.close() };
}

test('send posts the wire shape to /send and maps the answer to a PacketAnswer', async () => {
  const s = await fakeService(200, { status: 200, body: { paidIntervals: 3, paidThrough: 99, duplicate: false }, paid: '7000' });
  try {
    const p = new UrlPayer(s.url);
    const a = await p.send('g.x.charter-tick', { method: 'POST', path: '/tick', body: { leaseId: 'L', index: 2 } }, { ...OPTS, priority: 'high', deadline: 123456 });
    assert.deepEqual(a, { status: 200, body: { paidIntervals: 3, paidThrough: 99, duplicate: false }, paid: 7000n });
    assert.equal(s.seen.method, 'POST');
    assert.equal(s.seen.path, '/send');
    assert.deepEqual(s.seen.body, {
      dest: 'g.x.charter-tick',
      method: 'POST',
      path: '/tick',
      body: { leaseId: 'L', index: 2 },
      sealKey: SEAL,
      sealUrl: 'https://c.example/ilp',
      amount: '7000',
      priority: 'high',
      deadline: 123456,
    });
  } finally {
    s.close();
  }
});

test('a GET without a body carries no body key, and a trailing slash on the URL is fine', async () => {
  const s = await fakeService(200, { status: 404, body: 'gone', paid: '100' });
  try {
    const a = await new UrlPayer(s.url + '/').send('g.x.charter-status', { method: 'GET', path: '/leases/L' }, OPTS);
    assert.deepEqual(a, { status: 404, body: 'gone', paid: 100n });
    assert.equal('body' in (s.seen.body as object), false);
    assert.equal(s.seen.path, '/send');
  } finally {
    s.close();
  }
});

test('service errors come back as the local payer errors', async () => {
  const cases: Array<[number, unknown, (e: unknown) => boolean]> = [
    [502, { error: 'packet_refused', code: 'F03', refusedBy: 'g.edge', message: 'too much' }, (e) => e instanceof PacketRefusedError && e.code === 'F03' && e.refusedBy === 'g.edge'],
    [504, { error: 'deadline_passed' }, (e) => e instanceof DeadlinePassedError],
    [504, { error: 'send_timeout' }, (e) => e instanceof SendTimeoutError],
    [502, { error: 'send_failed', message: 'boom' }, (e) => e instanceof PayerServiceError && /send_failed: boom/.test((e as Error).message)],
    [500, 'not json', (e) => e instanceof PayerServiceError && /no JSON/.test((e as Error).message)],
    [200, { status: 'ok', paid: 5 }, (e) => e instanceof PayerServiceError && /unreadable/.test((e as Error).message)],
  ];
  for (const [status, body, check] of cases) {
    const s = await fakeService(status, body);
    try {
      await assert.rejects(new UrlPayer(s.url).send('g.x', { method: 'GET', path: '/' }, OPTS), (e: unknown) => check(e) || (console.error(e), false));
    } finally {
      s.close();
    }
  }
});

test('an unreachable service is a PayerServiceError, not a hang', async () => {
  const s = await fakeService(200, {});
  s.close();
  await assert.rejects(new UrlPayer(s.url).send('g.x', { method: 'GET', path: '/' }, OPTS), (e: unknown) => e instanceof PayerServiceError && /unreachable/.test((e as Error).message));
});
