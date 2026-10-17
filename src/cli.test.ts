import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from './cli.js';
import { exitJob, OFFER, testHost } from './tenant/test-host.js';

const RESULT = Buffer.from(JSON.stringify({ ok: true, pages: ['a'] }));

async function cli(argv: string[], env: Record<string, string>, extra: Partial<CliDeps> = {}) {
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
    fetchOffers: async () => [OFFER],
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
  assert.match(r.out, /o1/);
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
