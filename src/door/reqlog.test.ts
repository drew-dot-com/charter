import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { fileRequestSink, logRequests, MAX_PATH, MAX_UA, type RequestEntry, type RequestSink } from './reqlog.js';

async function serve(sink: RequestSink, go: (base: string) => Promise<void>): Promise<void> {
  let t = 1_000_000;
  const app = express();
  app.use(logRequests(sink, () => (t += 7)));
  app.use('/v1', express.Router().get('/rent', (_req, res) => void res.status(402).end()));
  app.use((_req, res) => void res.status(404).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await go(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

/** An entry lands when the response finishes, which can be just after fetch resolves. */
async function settle(got: unknown[], n: number): Promise<void> {
  for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 5));
}

test('an entry names the path, status and agent, and nothing that identifies the caller', async () => {
  const got: RequestEntry[] = [];
  await serve((e) => got.push(e), async (base) => {
    await fetch(`${base}/v1/rent?secret=abc`, {
      headers: { 'user-agent': 'x402scan/1', referer: 'https://www.x402scan.com/some/page?q=1', 'x-forwarded-for': '203.0.113.9', 'payment-signature': 'abc' },
    });
    await settle(got, 1);
  });
  assert.equal(got.length, 1);
  const e = got[0]!;
  assert.deepEqual(
    { m: e.m, p: e.p, s: e.s, ua: e.ua, ref: e.ref, paid: e.paid, ms: e.ms },
    { m: 'GET', p: '/v1/rent', s: 402, ua: 'x402scan/1', ref: 'www.x402scan.com', paid: true, ms: 7 },
  );
  const line = JSON.stringify(e);
  assert.ok(!line.includes('203.0.113.9'));
  assert.ok(!line.includes('127.0.0.1'));
  assert.ok(!line.includes('secret'));
  assert.ok(!line.includes('some/page'));
});

test('long paths and agents are cut, a bare request has no agent or referrer, and a bad referrer is dropped', async () => {
  const got: RequestEntry[] = [];
  await serve((e) => got.push(e), async (base) => {
    await fetch(`${base}/${'a'.repeat(MAX_PATH + 50)}`, { headers: { 'user-agent': 'b'.repeat(MAX_UA + 50), referer: 'not a url' } });
    await settle(got, 1);
  });
  assert.equal(got[0]!.p.length, MAX_PATH);
  assert.equal(got[0]!.ua!.length, MAX_UA);
  assert.equal(got[0]!.ref, undefined);
  assert.equal(got[0]!.paid, false);
  assert.equal(got[0]!.s, 404);
});

test('a sink that throws does not disturb the response', async () => {
  let called = 0;
  await serve(() => { called++; throw new Error('disk full'); }, async (base) => {
    const r = await fetch(`${base}/v1/rent`);
    assert.equal(r.status, 402);
    for (let i = 0; i < 100 && called === 0; i++) await new Promise((res) => setTimeout(res, 5));
  });
  assert.equal(called, 1);
});

const entry = (p: string): RequestEntry => ({ t: '2026-11-08T00:00:00.000Z', m: 'GET', p, s: 200, ms: 1, paid: false });

test('the file sink writes JSON lines and rolls once past its cap, keeping one old file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'reqlog-')), 'requests.jsonl');
  const one = Buffer.byteLength(`${JSON.stringify(entry('/a'))}\n`);
  const sink = fileRequestSink(file, one * 2);
  sink(entry('/a'));
  sink(entry('/b'));
  assert.ok(!existsSync(`${file}.1`));
  sink(entry('/c'));
  assert.deepEqual(readFileSync(`${file}.1`, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as RequestEntry).p), ['/a', '/b']);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as RequestEntry).p), ['/c']);
});

test('the file sink picks up the size of a log left by the last run', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'reqlog-')), 'requests.jsonl');
  const one = Buffer.byteLength(`${JSON.stringify(entry('/a'))}\n`);
  fileRequestSink(file, one * 2)(entry('/a'));
  const again = fileRequestSink(file, one * 2);
  again(entry('/b'));
  assert.ok(!existsSync(`${file}.1`));
  again(entry('/c'));
  assert.ok(existsSync(`${file}.1`));
});
