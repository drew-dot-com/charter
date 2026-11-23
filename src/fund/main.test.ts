import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Answer, DoorClient } from './door-client.js';
import { usdcBalance } from './door-client.js';
import { addSecrets, redact, grantsLeft, parseFundKey, parseArgs, readStops, runLoop, runOnce, statusReport, stopCommand, updateHealth } from './main.js';
import { emptyState, loadState, saveState, type FundState } from './state.js';

const hex = () => randomBytes(16).toString('hex');
const dir = () => mkdtempSync(join(tmpdir(), 'fund-main-'));
const ADDRESS = '0x2222222222222222222222222222222222222222';
const T0 = Date.UTC(2026, 10, 20, 0, 10);

test('stop writes the grant into stops.json, not the state file', () => {
  const d = dir();
  const id = hex();
  saveState(join(d, 'state.json'), emptyState());
  stopCommand(d, id);
  assert.deepEqual(readStops(d), { stopAll: false, stopped: [id] });
  stopCommand(d, id);
  assert.deepEqual(readStops(d).stopped, [id]);
  assert.deepEqual(loadState(join(d, 'state.json')).stopped, []);
});

test('stop refuses an id that is not 32 hex characters, and stop-all sets stopAll', () => {
  const d = dir();
  assert.throws(() => stopCommand(d, '../etc/passwd'), /32 hex/);
  assert.equal(existsSync(join(d, 'stops.json')), false);
  stopCommand(d, 'all');
  assert.equal(readStops(d).stopAll, true);
});

test('a missing stops.json reads as nothing stopped; a broken one throws', () => {
  const d = dir();
  assert.deepEqual(readStops(d), { stopAll: false, stopped: [] });
  writeFileSync(join(d, 'stops.json'), '{nope');
  assert.throws(() => readStops(d), /stops\.json/);
});

test('status prints grants and balance without the key', () => {
  const d = dir();
  const s = emptyState();
  const id = hex();
  s.grants[id] = { grantId: id, fundTicks: 5, reopened: false, openUnknown: 123, opening: { offerId: 'o', at: 1 } };
  saveState(join(d, 'state.json'), s);
  writeFileSync(join(d, 'public.json'), JSON.stringify({ address: ADDRESS, balanceMicro: '9000000', grantsLeft: 1, open: true }));
  writeFileSync(join(d, 'health.json'), JSON.stringify({ at: T0, problems: [{ key: 'door', msg: 'x', at: T0 }] }));
  stopCommand(d, 'all');
  const out = JSON.stringify(statusReport(d));
  const r = statusReport(d) as any;
  assert.equal(r.address, ADDRESS);
  assert.equal(r.balanceMicro, '9000000');
  assert.equal(r.grantsLeft, 1);
  assert.equal(r.stopAll, true);
  assert.equal(r.grants[0].id, id);
  assert.equal(r.grants[0].fundTicks, 5);
  assert.equal(r.grants[0].openUnknown, 123);
  assert.equal(r.problems.length, 1);
  assert.doesNotMatch(out, /secret|private|0x[0-9a-f]{64}/i);
});

test('grantsLeft is floor(balance / (720 x tick x 1.1)) minus live', () => {
  // one grant = 720 * 7000 * 1.1 = 5_544_000
  assert.equal(grantsLeft(11_088_000n, 7000n, 0), 2);
  assert.equal(grantsLeft(11_087_999n, 7000n, 0), 1);
  assert.equal(grantsLeft(11_088_000n, 7000n, 1), 1);
  assert.equal(grantsLeft(5_000_000n, 7000n, 3), 0);
  assert.equal(grantsLeft(10n ** 9n, 0n, 0), 0);
});

test('parseArgs knows run, stop, stop-all, status and nothing else', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'run' });
  assert.deepEqual(parseArgs(['stop', 'abc']), { cmd: 'stop', id: 'abc' });
  assert.deepEqual(parseArgs(['stop-all']), { cmd: 'stop-all' });
  assert.deepEqual(parseArgs(['status']), { cmd: 'status' });
  assert.throws(() => parseArgs(['stop']), /usage/);
  assert.throws(() => parseArgs(['frobnicate']), /usage/);
});

test('the fund key must be 0x and 64 hex', () => {
  const k = `0x${randomBytes(32).toString('hex')}`;
  assert.equal(parseFundKey(`${k}\n`), k);
  assert.throws(() => parseFundKey('0x1234'), /CHARTER_FUND_KEY_FILE/);
  assert.throws(() => parseFundKey(k.slice(2)), /CHARTER_FUND_KEY_FILE/);
  try {
    parseFundKey('0xsecretsecret');
  } catch (e) {
    assert.doesNotMatch(String(e), /secretsecret/);
  }
});

test('health keeps a problem for an hour, then drops it, and a new one replaces its key', () => {
  const d = dir();
  updateHealth(d, [{ key: 'door', msg: 'a' }], T0);
  updateHealth(d, [], T0 + 30 * 60_000);
  assert.equal(JSON.parse(readFileSync(join(d, 'health.json'), 'utf8')).problems.length, 1);
  updateHealth(d, [{ key: 'door', msg: 'b' }], T0 + 40 * 60_000);
  let h = JSON.parse(readFileSync(join(d, 'health.json'), 'utf8'));
  assert.deepEqual(h.problems, [{ key: 'door', msg: 'b', at: T0 + 40 * 60_000 }]);
  assert.equal(h.at, T0 + 40 * 60_000);
  updateHealth(d, [], T0 + 40 * 60_000 + 60 * 60_000 + 1);
  h = JSON.parse(readFileSync(join(d, 'health.json'), 'utf8'));
  assert.deepEqual(h.problems, []);
});

function fakeDoor(puts: unknown[], offers: unknown = { offers: [{ offerId: 'o1', tickPrice: '7000', intervalSeconds: 3600, home: { slots: 2, free: 1 } }, { offerId: 'o2', tickPrice: '7000', intervalSeconds: 3600, home: { slots: 3, free: 0 } }] }): DoorClient {
  const ok = (body: unknown): Answer => ({ status: 200, body });
  return {
    payTo: ADDRESS,
    async get(path) {
      return path === '/v1/offers' ? ok(offers) : ok({});
    },
    async pay() {
      return ok({});
    },
    async fund(method, path, json) {
      if (method === 'PUT' && path === '/v1/fund/public') {
        puts.push(json);
        return ok(json);
      }
      return ok({ grants: [] });
    },
  };
}

test('one iteration re-reads stops.json: a stop written after the state says otherwise wins', async () => {
  const d = dir();
  const id = hex();
  const state: FundState = emptyState();
  state.grants[id] = { grantId: id, fundTicks: 0, reopened: false };
  stopCommand(d, id);
  const seen: FundState[] = [];
  await runOnce({
    dir: d, state, door: fakeDoor([]), address: ADDRESS, balance: async () => 1n, now: () => T0,
    judgeOne: async () => {}, runCycle: async (c) => { seen.push(structuredClone(c.state)); },
  });
  assert.deepEqual(seen[0].stopped, [id]);
  assert.deepEqual(state.stopped, [id]);
  stopCommand(d, 'all');
  await runOnce({
    dir: d, state, door: fakeDoor([]), address: ADDRESS, balance: async () => 1n, now: () => T0,
    judgeOne: async () => {}, runCycle: async (c) => { seen.push(structuredClone(c.state)); },
  });
  assert.equal(seen[1].stopAll, true);
});

test('one iteration reports the pot to the door and writes health', async () => {
  const d = dir();
  const puts: any[] = [];
  const state = emptyState();
  const live = hex();
  state.grants[live] = { grantId: live, fundTicks: 3, reopened: false };
  const gone = hex();
  state.grants[gone] = { grantId: gone, fundTicks: 720, reopened: false, endedAt: 5 };
  await runOnce({
    dir: d, state, door: fakeDoor(puts), address: ADDRESS, balance: async () => 11_088_000n, now: () => T0,
    judgeOne: async () => {}, runCycle: async (c) => { c.problem('door', 'boom'); },
  });
  assert.deepEqual(puts, [{ address: ADDRESS, balanceMicro: '11088000', grantsLeft: 1, open: true }]);
  const h = JSON.parse(readFileSync(join(d, 'health.json'), 'utf8'));
  assert.equal(h.at, T0);
  assert.deepEqual(h.problems, [{ key: 'door', msg: 'boom', at: T0 }]);
  assert.equal(JSON.parse(readFileSync(join(d, 'public.json'), 'utf8')).grantsLeft, 1);
});

test('a stopAll fund reports closed, and one with no grant left too', async () => {
  const d = dir();
  const puts: any[] = [];
  stopCommand(d, 'all');
  const base = { dir: d, door: fakeDoor(puts), address: ADDRESS, now: () => T0, judgeOne: async () => {}, runCycle: async () => {} };
  await runOnce({ ...base, state: emptyState(), balance: async () => 99_000_000n });
  assert.equal(puts[0].open, false);
  const d2 = dir();
  await runOnce({ ...base, dir: d2, state: emptyState(), balance: async () => 1_000_000n });
  assert.equal(puts[1].grantsLeft, 0);
  assert.equal(puts[1].open, false);
});

test('a stopped fund sends grants left 0 though the balance would cover grants', async () => {
  const d = dir();
  const puts: any[] = [];
  stopCommand(d, 'all');
  await runOnce({ dir: d, state: emptyState(), door: fakeDoor(puts), address: ADDRESS, now: () => T0, judgeOne: async () => {}, runCycle: async () => {}, balance: async () => 99_000_000n });
  assert.deepEqual(puts[0], { address: ADDRESS, balanceMicro: '99000000', grantsLeft: 0, open: false });
});

test('a stopped fund closes intake with the last known balance when the balance read fails', async () => {
  const d = dir();
  const puts: any[] = [];
  const base = { dir: d, state: emptyState(), door: fakeDoor(puts), address: ADDRESS, now: () => T0, judgeOne: async () => {}, runCycle: async () => {} };
  await runOnce({ ...base, balance: async () => 42_000_000n });
  stopCommand(d, 'all');
  await runOnce({ ...base, balance: async () => { throw new Error('rpc down'); } });
  assert.deepEqual(puts[1], { address: ADDRESS, balanceMicro: '42000000', grantsLeft: 0, open: false });
  const h = JSON.parse(readFileSync(join(d, 'health.json'), 'utf8'));
  assert.ok(h.problems.some((p: any) => p.key === 'public' && /rpc down/.test(p.msg)), 'the failed read is still a problem');
  // no report ever: 0
  const d2 = dir();
  stopCommand(d2, 'all');
  await runOnce({ ...base, dir: d2, balance: async () => { throw new Error('rpc down'); } });
  assert.equal(puts[2].balanceMicro, '0');
  assert.equal(puts[2].open, false);
});

test('an open fund whose balance read fails sends no report', async () => {
  const d = dir();
  const puts: any[] = [];
  await runOnce({ dir: d, state: emptyState(), door: fakeDoor(puts), address: ADDRESS, now: () => T0, judgeOne: async () => {}, runCycle: async () => {}, balance: async () => { throw new Error('rpc down'); } });
  assert.deepEqual(puts, []);
});

test('the cycle gets the last reported balance for closing intake', async () => {
  const d = dir();
  writeFileSync(join(d, 'public.json'), JSON.stringify({ address: ADDRESS, balanceMicro: '123', grantsLeft: 0, open: false }));
  let got: string | undefined;
  await runOnce({ dir: d, state: emptyState(), door: fakeDoor([]), address: ADDRESS, now: () => T0, judgeOne: async () => {}, balance: async () => 1n, runCycle: async (c) => { got = c.lastBalanceMicro?.(); } });
  assert.equal(got, '123');
});

test('a cycle that throws is recorded and never escapes', async () => {
  const d = dir();
  await runOnce({
    dir: d, state: emptyState(), door: fakeDoor([]), address: ADDRESS, balance: async () => 1n, now: () => T0,
    judgeOne: async () => {}, runCycle: async () => { throw new Error('kaboom'); },
  });
  const h = JSON.parse(readFileSync(join(d, 'health.json'), 'utf8'));
  assert.equal(h.problems[0].key, 'cycle');
  assert.match(h.problems[0].msg, /kaboom/);
});

test('a broken stops.json is a problem, not a crash, and nothing is paid that cycle', async () => {
  const d = dir();
  writeFileSync(join(d, 'stops.json'), '{nope');
  let ran = false;
  await runOnce({
    dir: d, state: emptyState(), door: fakeDoor([]), address: ADDRESS, balance: async () => 1n, now: () => T0,
    judgeOne: async () => {}, runCycle: async () => { ran = true; },
  });
  assert.equal(ran, false);
  assert.equal(JSON.parse(readFileSync(join(d, 'health.json'), 'utf8')).problems[0].key, 'stops');
});

test('the loop never overlaps cycles and stops after the current one', async () => {
  let running = 0;
  let max = 0;
  let n = 0;
  const stop = { stopped: false };
  await runLoop({
    once: async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (++n === 3) stop.stopped = true;
    },
    sleep: async () => {},
    signal: stop,
  });
  assert.equal(n, 3);
  assert.equal(max, 1);
});

const URL_WITH_KEY = 'https://base-mainnet.rpc.example/v2/SECRETAPIKEY123';

test('a balance error carrying the RPC URL never reaches health.json', async () => {
  const d = dir();
  const balance = () => usdcBalance(ADDRESS, URL_WITH_KEY, (async () => { throw new Error(`HTTP request failed. URL: ${URL_WITH_KEY}`); }) as never);
  await runOnce({
    dir: d, state: emptyState(), door: fakeDoor([]), address: ADDRESS, balance, now: () => T0,
    judgeOne: async () => {},
    runCycle: async (c) => { try { await c.balance(); } catch (e) { c.problem('balance', `the balance read failed: ${(e as Error).message}`); } },
  });
  const text = readFileSync(join(d, 'health.json'), 'utf8');
  assert.match(text, /balance/);
  assert.doesNotMatch(text, /SECRETAPIKEY123|rpc\.example/);
});

test('redact strips registered secrets from any problem text, even one that slips through', async () => {
  const d = dir();
  addSecrets(URL_WITH_KEY);
  assert.equal(redact(`boom ${URL_WITH_KEY}`), 'boom [redacted]');
  await runOnce({
    dir: d, state: emptyState(), door: fakeDoor([]), address: ADDRESS, balance: async () => 1n, now: () => T0,
    judgeOne: async () => {}, runCycle: async (c) => { c.problem('x', `leak ${URL_WITH_KEY}`); throw new Error(`and ${URL_WITH_KEY}`); },
  });
  assert.doesNotMatch(readFileSync(join(d, 'health.json'), 'utf8'), /SECRETAPIKEY123/);
});

test('CHARTER_GRANT_MIN_LEASES: default 5, a whole number overrides, junk is refused', async () => {
  const { minLeases } = await import('./main.js');
  assert.equal(minLeases({}), 5);
  assert.equal(minLeases({ CHARTER_GRANT_MIN_LEASES: '12' }), 12);
  assert.throws(() => minLeases({ CHARTER_GRANT_MIN_LEASES: 'many' }));
});

test('CHARTER_GRANT_HOMES_PER_HOST: default 2, 0 is allowed, junk is refused', async () => {
  const { grantHomesPerHost } = await import('./main.js');
  assert.equal(grantHomesPerHost({}), 2);
  assert.equal(grantHomesPerHost({ CHARTER_GRANT_HOMES_PER_HOST: '0' }), 0);
  assert.equal(grantHomesPerHost({ CHARTER_GRANT_HOMES_PER_HOST: '3' }), 3);
  assert.throws(() => grantHomesPerHost({ CHARTER_GRANT_HOMES_PER_HOST: 'lots' }));
  assert.throws(() => grantHomesPerHost({ CHARTER_GRANT_HOMES_PER_HOST: '-1' }));
  assert.throws(() => grantHomesPerHost({ CHARTER_GRANT_HOMES_PER_HOST: '1.5' }));
});
