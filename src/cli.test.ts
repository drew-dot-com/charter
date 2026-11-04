import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runCli, type CliDeps } from './cli.js';
import { offerToJson } from './offer.js';
import type { PacketRequest, Payer, ToonClientPayerConfig } from './payer.js';
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
  const clientConfigs: ToonClientPayerConfig[] = [];
  const code = await runCli(argv, env, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => h.clock.t,
    sleep: h.sleep,
    fetchOffers: async () => offers,
    makePayer: async (env) => (made.push(env.TOON_PASSPHRASE_FILE ?? ''), h.payer),
    makeClientPayer: async (cfg) => (clientConfigs.push(cfg), h.payer),
    ...extra,
  });
  h.close();
  return { code, out: out.join('\n'), err: err.join('\n'), made, clientConfigs, h };
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
  // The real makePayer, so the check under test is the CLI's own.
  const r = await cli(['rent', '--offer', 'o1', '--urls', 'u', '--max-intervals', '5', '--relay', 'wss://r'], {}, { makePayer: undefined });
  assert.equal(r.code, 2);
  assert.match(r.err, /TOON_PASSPHRASE_FILE/);
  assert.equal(r.h.sent['charter-open'], 0);
  const s = await cli(['status', 'o1', 'abc', '--relay', 'wss://r'], {}, { makePayer: undefined });
  assert.equal(s.code, 2);
  assert.match(s.err, /TOON_PASSPHRASE_FILE/);
  const u = await cli(['status', 'o1', 'abc', '--relay', 'wss://r'], { ...ENV, CHARTER_PAYER: 'lightning' }, { makePayer: undefined });
  assert.equal(u.code, 2);
  assert.match(u.err, /CHARTER_PAYER/);
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
      fetchOffers: async () => [OFFER], makePayer: async () => h0.payer,
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

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ2';
const HOME: Offer = { ...OFFER, images: ['charter-job-fetch', 'charter-home'] };
const ONION = 'a'.repeat(56) + '.anyone';

/** A host for a home: it never finishes, its status shows how to reach the box, and it orders ticks like onTick. */
function homeHost(clock: { t: number }) {
  const opens: unknown[] = [];
  const ticks: number[] = [];
  let paidIntervals = 0;
  let paidThrough = clock.t;
  const payer: Payer = {
    async send(dest: string, req: PacketRequest, o: { amount: bigint }) {
      const app = dest.slice(dest.lastIndexOf('.') + 1);
      if (app === 'charter-open') {
        opens.push(req.body);
        return { status: 200, body: { leaseId: 'b'.repeat(32), state: 'awaiting_first_tick' }, paid: o.amount };
      }
      if (app === 'charter-tick') {
        const index = (req.body as { index: number }).index;
        ticks.push(index);
        if (index < paidIntervals) return { status: 200, body: { paidIntervals, paidThrough, duplicate: true }, paid: o.amount };
        if (index > paidIntervals) return { status: 409, body: { error: 'out_of_order' }, paid: o.amount };
        paidIntervals++;
        paidThrough = Math.max(paidThrough, clock.t) + 30_000;
        return { status: 200, body: { paidIntervals, paidThrough, duplicate: false }, paid: o.amount };
      }
      const lease = {
        id: 'b'.repeat(32), offerId: 'o1', job: { image: 'charter-home', args: {} }, state: 'running', createdAt: 0,
        paidIntervals, paidThrough, access: { ssh: { host: ONION, port: 22, user: 'tenant' } },
      };
      return { status: 200, body: { lease }, paid: o.amount };
    },
  };
  return { payer, opens, ticks, setPaid: (n: number) => ((paidIntervals = n), (paidThrough = clock.t + 20_000)) };
}

async function homeCli(argv: string[], env: Record<string, string>, setup: (h: ReturnType<typeof homeHost>) => void = () => undefined) {
  const clock = { t: 1_000_000 };
  const h = homeHost(clock);
  setup(h);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, env, {
    out: (s) => out.push(s), err: (s) => err.push(s), now: () => clock.t, sleep: async (ms) => void (clock.t += ms),
    fetchOffers: async () => { throw new Error('the relay must not be read'); },
    makePayer: async () => h.payer,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), h };
}

const BOX = { ...ENV, CHARTER_OFFER_JSON: offerToJson(HOME) };

test('rent --home reads keys from a file and opens a home job', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'charter-cli-')), 'keys');
  writeFileSync(f, `${KEY_B} drew@air\n\n${KEY_A}\n`);
  const r = await homeCli(['rent', '--offer', 'o1', '--home', f, '--max-intervals', '2'], BOX);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.h.opens, [{ job: { image: 'charter-home', args: { SSH_KEYS: `${KEY_A}\n${KEY_B}` } } }]);
  assert.deepEqual(r.h.ticks, [0, 1]);
  assert.match(r.err, new RegExp(`opened lease ${'b'.repeat(32)}`));
  const ssh = `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${ONION}`;
  assert.equal(r.err.split('\n').filter((l) => l === ssh).length, 1, r.err);

  const both = await homeCli(['rent', '--offer', 'o1', '--home', f, '--urls', 'https://e.com', '--max-intervals', '1'], BOX);
  assert.equal(both.code, 2);
  const bad = join(mkdtempSync(join(tmpdir(), 'charter-cli-')), 'keys');
  writeFileSync(bad, 'not a key\n');
  const refused = await homeCli(['rent', '--offer', 'o1', '--home', bad, '--max-intervals', '1'], BOX);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--home/);
  assert.equal(refused.h.opens.length, 0);
});

test('renew attaches to a lease and pays from --from', async () => {
  const r = await homeCli(['renew', '--offer', `${HOME.hostPubkey}:o1`, '--lease', 'b'.repeat(32), '--from', '1', '--max-intervals', '2', '--json'], BOX, (h) => h.setPaid(1));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.h.ticks, [1, 2]);
  assert.equal(r.h.opens.length, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.leaseId, 'b'.repeat(32));
  assert.equal(j.state, 'running');
  assert.equal(j.paidIntervals, 3);

  for (const bad of [['--from', '-1'], ['--from', 'x']]) {
    const u = await homeCli(['renew', '--offer', 'o1', '--lease', 'b'.repeat(32), '--max-intervals', '2', ...bad], BOX);
    assert.equal(u.code, 2, JSON.stringify(bad));
    assert.match(u.err, /--from/);
  }
  const other = await homeCli(['renew', '--offer', `${'ee'.repeat(32)}:o1`, '--lease', 'b'.repeat(32), '--from', '1', '--max-intervals', '2'], BOX);
  assert.equal(other.code, 1);
  assert.deepEqual(other.h.ticks, []);
});

test('inside a box the host offer has no pubkey, and <pubkey>:<id> still resolves by id and pays', async () => {
  const env = { ...ENV, CHARTER_OFFER_JSON: offerToJson({ ...HOME, hostPubkey: '' }) };
  const r = await homeCli(['renew', '--offer', `${'cd'.repeat(32)}:o1`, '--lease', 'b'.repeat(32), '--max-intervals', '2', '--json'], env, (h) => h.setPaid(1));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.h.ticks, [1, 2]);
  const wrongId = await homeCli(['renew', '--offer', `${'cd'.repeat(32)}:o9`, '--lease', 'b'.repeat(32), '--max-intervals', '2'], env, (h) => h.setPaid(1));
  assert.equal(wrongId.code, 1);
  assert.deepEqual(wrongId.h.ticks, []);
});

test('renew --from too high pays nothing and exits 2, naming both numbers', async () => {
  for (const from of ['2', '0']) {
    const r = await homeCli(['renew', '--offer', 'o1', '--lease', 'b'.repeat(32), '--from', from, '--max-intervals', '3'], BOX, (h) => h.setPaid(1));
    assert.equal(r.code, 2, r.err);
    assert.deepEqual(r.h.ticks, []);
    assert.match(r.err, new RegExp(`--from ${from} .* 1`));
  }
});

test('renew without --from pays from the host count', async () => {
  const r = await homeCli(['renew', '--offer', 'o1', '--lease', 'b'.repeat(32), '--max-intervals', '3'], BOX, (h) => h.setPaid(4));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.h.ticks, [4, 5, 6]);
});

test('renew --from equal to the host count pays exactly --max-intervals ticks', async () => {
  const r = await homeCli(['renew', '--offer', 'o1', '--lease', 'b'.repeat(32), '--from', '3', '--max-intervals', '4', '--json'], BOX, (h) => h.setPaid(3));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.h.ticks, [3, 4, 5, 6]);
  assert.equal(JSON.parse(r.out).paidIntervals, 7);
});

test('CHARTER_OFFER_JSON replaces the relay read', async () => {
  const r = await cli(['rent', '--offer', 'o1', '--urls', 'https://example.com', '--max-intervals', '5', '--json'], { ...ENV, CHARTER_OFFER_JSON: offerToJson(OFFER) }, {
    fetchOffers: async () => { throw new Error('the relay must not be read'); },
  });
  assert.equal(r.code, 0, r.err);
  const leaseId = JSON.parse(r.out).leaseId;
  const s = await homeCli(['status', 'o1', leaseId], BOX);
  assert.equal(s.code, 0, s.err);
  assert.doesNotMatch(s.err, /--relay/);
  const relayed = await homeCli(['status', 'o1', leaseId, '--relay', 'wss://r'], BOX);
  assert.equal(relayed.code, 0, relayed.err);
  assert.match(relayed.err, /CHARTER_OFFER_JSON; --relay is ignored/);
  const wrong = await homeCli(['status', 'o2', leaseId], BOX);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /o2/);
  const garbled = await homeCli(['status', 'o1', leaseId], { ...ENV, CHARTER_OFFER_JSON: '{' });
  assert.equal(garbled.code, 1);
  assert.match(garbled.err, /CHARTER_OFFER_JSON/);
});

test('CHARTER_PAYER=toon-client builds the client payer from env', async () => {
  const env = {
    CHARTER_PAYER: 'toon-client',
    CHARTER_CONNECTOR_URL: 'https://box-connector.example',
    CHARTER_TOON_KEY_FILE: '/run/secrets/key',
    CHARTER_TOON_CHANNEL_STORE: '/data/channels.json',
    CHARTER_TOON_CHAIN: 'evm',
  };
  const r = await cli(['rent', '--offer', 'o1', '--urls', 'https://example.com', '--max-intervals', '5', '--relay', 'wss://r', '--json'], env, { makePayer: undefined });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).state, 'done');
  assert.deepEqual(r.clientConfigs, [
    { connectorUrl: 'https://box-connector.example', keyFile: '/run/secrets/key', channelStore: '/data/channels.json', chain: 'evm' },
  ]);
  // The node's own connector wins over the box's when both are set.
  const own = await cli(['status', 'o1', 'a'.repeat(32), '--relay', 'wss://r'], { ...env, CHARTER_TOON_CONNECTOR_URL: 'https://own.example' }, { makePayer: undefined });
  assert.equal(own.clientConfigs[0]!.connectorUrl, 'https://own.example');
  const blank = await cli(['status', 'o1', 'a'.repeat(32), '--relay', 'wss://r'], { ...env, CHARTER_CONNECTOR_URL: '  ' }, { makePayer: undefined });
  assert.equal(blank.code, 1);
  assert.match(blank.err, /CHARTER_TOON_CONNECTOR_URL or CHARTER_CONNECTOR_URL is required/);
  const padded = await cli(['status', 'o1', 'a'.repeat(32), '--relay', 'wss://r'], { ...env, CHARTER_CONNECTOR_URL: ' https://box-connector.example\n' }, { makePayer: undefined });
  assert.equal(padded.clientConfigs[0]!.connectorUrl, 'https://box-connector.example');
  const missing = await cli(['status', 'o1', 'a'.repeat(32), '--relay', 'wss://r'], { ...env, CHARTER_TOON_KEY_FILE: '' }, { makePayer: undefined });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /CHARTER_TOON_KEY_FILE is required/);
  assert.equal(missing.clientConfigs.length, 0);
});
