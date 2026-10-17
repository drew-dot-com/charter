import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from './cli.js';
import { exitJob, OFFER, testHost } from './tenant/test-host.js';
import type { Offer } from './types.js';

const RESULT = Buffer.from(JSON.stringify({ ok: true, pages: ['a'] }));

async function cli(argv: string[], env: Record<string, string>, extra: Partial<CliDeps> = {}, offers: Offer[] = [OFFER]) {
  const out: string[] = [];
  const err: string[] = [];
  const h = await testHost({
    runner: { output: async () => RESULT },
    afterTick: (host, n) => {
      if (n === 2) exitJob(host, host.store.all()[0]!.id, RESULT);
    },
  });
  const made: string[] = [];
  const code = await runCli(argv, env, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => h.clock.t,
    sleep: h.sleep,
    fetchOffers: async () => offers,
    makePayer: (file) => (made.push(file), h.payer),
    ...extra,
  });
  h.close();
  return { code, out: out.join('\n'), err: err.join('\n'), made, h };
}

const ENV = { TOON_PASSPHRASE_FILE: '/run/secrets/pass' };

test('rent --json prints one object with decimal-string spent and decoded output', async () => {
  const r = await cli(['rent', '--offer', 'o1', '--urls', 'https://example.com', '--max-intervals', '5', '--relay', 'wss://r', '--json'], ENV);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j).sort(), ['leaseId', 'output', 'paidIntervals', 'spent', 'state']);
  assert.equal(j.state, 'done');
  assert.equal(j.paidIntervals, 2);
  assert.match(j.leaseId, /^[0-9a-f]{32}$/);
  assert.equal(typeof j.spent, 'string');
  assert.match(j.spent, /^\d+$/);
  assert.deepEqual(j.output, { ok: true, pages: ['a'] });
  assert.deepEqual(r.made, ['/run/secrets/pass']);
});

test('rent without --json prints a human summary', async () => {
  const r = await cli(['rent', '--offer', 'o1', '--urls', 'https://example.com', '--max-intervals', '5', '--relay', 'wss://r'], ENV);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /done/);
  assert.match(r.out, /spent/i);
  assert.doesNotMatch(r.out, /\u2014/);
});

function scriptFile(body: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'charter-cli-')), 'job.py');
  writeFileSync(f, body);
  return f;
}

test('rent --python sends the file as a python job to an offer that lists the image', async () => {
  const py: Offer = { ...OFFER, images: ['charter-job-fetch', 'charter-job-python'] };
  const f = scriptFile('print(6 * 7)\n');
  const r = await cli(['rent', '--offer', 'o1', '--python', f, '--max-intervals', '5', '--relay', 'wss://r', '--json'], ENV, {}, [py]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.h.store.all()[0]!.job, { image: 'charter-job-python', args: { SCRIPT: 'print(6 * 7)\n' } });
});

test('rent takes exactly one job, refuses an empty or oversize script, and an offer without the image, paying nothing', async () => {
  const py: Offer = { ...OFFER, images: ['charter-job-python'] };
  const both = await cli(['rent', '--offer', 'o1', '--urls', 'https://e.com', '--python', scriptFile('print(1)'), '--max-intervals', '1', '--relay', 'wss://r'], ENV, {}, [py]);
  assert.equal(both.code, 2);
  const neither = await cli(['rent', '--offer', 'o1', '--max-intervals', '1', '--relay', 'wss://r'], ENV, {}, [py]);
  assert.equal(neither.code, 2);
  for (const body of ['  \n', 'x'.repeat(8 * 1024 + 1)]) {
    const r = await cli(['rent', '--offer', 'o1', '--python', scriptFile(body), '--max-intervals', '1', '--relay', 'wss://r'], ENV, {}, [py]);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.h.store.all().length, 0);
  }
  const fetchOnly = await cli(['rent', '--offer', 'o1', '--python', scriptFile('print(1)'), '--max-intervals', '1', '--relay', 'wss://r'], ENV);
  assert.notEqual(fetchOnly.code, 0);
  assert.match(fetchOnly.err, /charter-job-python/);
  assert.equal(fetchOnly.h.store.all().length, 0);
});

test('paying commands refuse to run without TOON_PASSPHRASE_FILE', async () => {
  const r = await cli(['rent', '--offer', 'o1', '--urls', 'u', '--max-intervals', '5', '--relay', 'wss://r'], {});
  assert.equal(r.code, 2);
  assert.match(r.err, /TOON_PASSPHRASE_FILE/);
  assert.equal(r.made.length, 0);
  const s = await cli(['status', 'o1', 'abc', '--relay', 'wss://r'], {});
  assert.equal(s.code, 2);
  assert.match(s.err, /TOON_PASSPHRASE_FILE/);
});

test('--max-intervals is required and must be a positive integer', async () => {
  for (const bad of [[], ['--max-intervals', '0'], ['--max-intervals', '-1'], ['--max-intervals', '1.5'], ['--max-intervals', 'x']]) {
    const r = await cli(['rent', '--offer', 'o1', '--urls', 'u', '--relay', 'wss://r', ...bad], ENV);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.err, /max-intervals/);
    assert.equal(r.made.length, 0);
  }
});

test('rent with an unknown offer id fails without paying', async () => {
  const r = await cli(['rent', '--offer', 'nope', '--urls', 'u', '--max-intervals', '2', '--relay', 'wss://r'], ENV);
  assert.equal(r.code, 1);
  assert.match(r.err, /nope/);
  assert.equal(r.h.sent['charter-open'], 0);
});

test('offers lists live offers and needs no passphrase', async () => {
  const r = await cli(['offers', '--relay', 'wss://r'], {});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`${OFFER.hostPubkey}:o1`)); // copyable as --offer
  assert.match(r.out, /0\.005/); // tick price in USDC
});

test('status resolves the offer from the relay and prints the lease', async () => {
  const h0 = await testHost({});
  const out: string[] = [];
  try {
    const api = (await import('./tenant/host-api.js')).hostApi(h0.payer, OFFER);
    const { leaseId } = await api.open({ image: 'charter-job-fetch', args: { URLS: 'u' } });
    const code = await runCli(['status', 'o1', leaseId, '--relay', 'wss://r', '--json'], ENV, {
      out: (s) => out.push(s), err: () => undefined, now: () => h0.clock.t, sleep: h0.sleep,
      fetchOffers: async () => [OFFER], makePayer: () => h0.payer,
    });
    assert.equal(code, 0);
    const j = JSON.parse(out.join('\n'));
    assert.equal(j.leaseId, leaseId);
    assert.equal(j.state, 'awaiting_first_tick');
    assert.equal(j.spent, '100');
  } finally {
    h0.close();
  }
});

const OTHER: Offer = { ...OFFER, hostPubkey: 'cd'.repeat(32), sealKey: '0x04' + 'cd'.repeat(64), sealUrl: 'http://other.example/ilp' };
const RENT = ['--urls', 'https://example.com', '--max-intervals', '5', '--relay', 'wss://r', '--json'];

test('a bare --offer id shared by two hosts is refused, listing both pubkeys, and nothing is paid', async () => {
  const r = await cli(['rent', '--offer', 'o1', ...RENT], ENV, {}, [OTHER, OFFER]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes(OFFER.hostPubkey) && r.err.includes(OTHER.hostPubkey), r.err);
  assert.equal(r.h.sent['charter-open'], 0);
  const s = await cli(['status', 'o1', 'a'.repeat(32), '--relay', 'wss://r'], ENV, {}, [OTHER, OFFER]);
  assert.equal(s.code, 1);
  assert.ok(s.err.includes(OFFER.hostPubkey) && s.err.includes(OTHER.hostPubkey), s.err);
  assert.equal(s.h.sent['charter-status'], 0);
});

test('--offer <pubkey>:<id> picks that host exactly, and a wrong pubkey pays nothing', async () => {
  const r = await cli(['rent', '--offer', `${OTHER.hostPubkey}:o1`, ...RENT], ENV, {}, [OFFER, OTHER]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.h.seen.length > 0);
  for (const s of r.h.seen) assert.equal(s.sealUrl, OTHER.sealUrl);

  const bad = await cli(['rent', '--offer', `${'ee'.repeat(32)}:o1`, ...RENT], ENV, {}, [OFFER, OTHER]);
  assert.equal(bad.code, 1);
  assert.equal(bad.h.sent['charter-open'], 0);

  const st = await cli(['status', `${OTHER.hostPubkey}:o1`, 'a'.repeat(32), '--relay', 'wss://r'], ENV, {}, [OFFER, OTHER]);
  for (const s of st.h.seen) assert.equal(s.sealUrl, OTHER.sealUrl);
  assert.ok(st.h.seen.length > 0);
});

test('a bare --offer id still works when exactly one offer matches', async () => {
  const r = await cli(['rent', '--offer', 'o1', ...RENT], ENV, {}, [OFFER]);
  assert.equal(r.code, 0, r.err);
});
