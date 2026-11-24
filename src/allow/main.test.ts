import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSecrets, bootState, LOW_ETH_WEI, parseArgs, readResolutions, readStops, resolveRefundCommand, runOnce, statusReport, stopCommand } from './main.js';
import { emptyState, loadState, saveState, type AllowEntry } from './state.js';
import type { BillerDeps } from './biller.js';

const hex = () => randomBytes(16).toString('hex');
const dir = () => mkdtempSync(join(tmpdir(), 'allow-main-'));
const ADDRESS = '0x2222222222222222222222222222222222222222';
const T0 = Date.UTC(2026, 10, 24, 0, 10);
const entry = (id: string, over: Partial<AllowEntry> = {}): AllowEntry => ({ allowanceId: id, creditMicro: '5000', ...over });
const health = (d: string) => JSON.parse(readFileSync(join(d, 'health.json'), 'utf8'));

function once(d: string, state = loadState(join(d, 'state.json')), o: { eth?: bigint; runCycle?: (b: BillerDeps) => Promise<void>; usdc?: bigint; logs?: string[] } = {}) {
  const seen: BillerDeps[] = [];
  return {
    seen,
    run: () =>
      runOnce({
        dir: d, state, door: {} as never, address: ADDRESS, now: () => T0, log: (m) => void o.logs?.push(m),
        chain: { usdc: async () => o.usdc ?? 7_000_000n, eth: async () => o.eth ?? 10n ** 15n } as never,
        runCycle: o.runCycle ?? (async (b) => void seen.push(b)),
      }),
  };
}

test('stop writes stops.json and the loop reads it', async () => {
  const d = dir();
  const id = hex();
  saveState(join(d, 'state.json'), emptyState());
  stopCommand(d, id);
  stopCommand(d, id);
  assert.deepEqual(readStops(d), [id]);
  assert.deepEqual(loadState(join(d, 'state.json')).entries, {});
  assert.throws(() => stopCommand(d, '../etc/passwd'), /32 hex/);
  const o = once(d);
  await o.run();
  assert.deepEqual([...o.seen[0].stops], [id]);
});

test('a missing stops.json reads as nothing stopped; a broken one throws and nothing is paid', async () => {
  const d = dir();
  assert.deepEqual(readStops(d), []);
  writeFileSync(join(d, 'stops.json'), '{nope');
  assert.throws(() => readStops(d), /stops\.json/);
  const o = once(d);
  await o.run();
  assert.equal(o.seen.length, 0);
  assert.equal(health(d).problems.some((p: { key: string }) => p.key === 'stops'), true);
});

test('health redacts the RPC URL and token', async () => {
  const d = dir();
  const rpc = 'https://base-mainnet.example.com/v2/SECRETRPCKEY123';
  const tok = 'tok_SECRETTOKEN_abcdef';
  addSecrets(rpc, tok);
  const o = once(d, undefined, {
    runCycle: async (b) => {
      b.problem('door', `call to ${rpc} failed with bearer ${tok}`);
    },
  });
  await o.run();
  const text = readFileSync(join(d, 'health.json'), 'utf8');
  assert.ok(!text.includes('SECRETRPCKEY123') && !text.includes('SECRETTOKEN'));
  assert.match(text, /redacted/);
  const h = health(d);
  assert.equal(h.at, T0);
  assert.equal(h.usdcMicro, '7000000');
  assert.equal(h.ethWei, (10n ** 15n).toString());
});

test('low ETH is a problem', async () => {
  const d = dir();
  await once(d, undefined, { eth: LOW_ETH_WEI - 1n }).run();
  assert.equal(health(d).problems.some((p: { key: string }) => p.key === 'low_eth'), true);
  const d2 = dir();
  await once(d2, undefined, { eth: LOW_ETH_WEI }).run();
  assert.equal(health(d2).problems.some((p: { key: string }) => p.key === 'low_eth'), false);
  assert.equal(LOW_ETH_WEI, 100000000000000n);
});

test('an unreadable state file stops the process instead of starting fresh', () => {
  const d = dir();
  assert.deepEqual(bootState(d).entries, {});
  writeFileSync(join(d, 'state.json'), '{broken');
  assert.throws(() => bootState(d), /refusing to start fresh/);
});

test('resolve-refund sent clears refundInFlight and zeroes the credit, so the end completes', async () => {
  const d = dir();
  const id = hex();
  const s = emptyState();
  s.entries[id] = entry(id, { refundInFlight: { to: ADDRESS, micro: '5000', at: 1 }, ending: { state: 'ended', endReason: 'stopped' } });
  saveState(join(d, 'state.json'), s);
  resolveRefundCommand(d, id, 'sent');
  assert.deepEqual(readResolutions(d), { [id]: 'sent' });
  const state = loadState(join(d, 'state.json'));
  let credit: string | undefined;
  let inFlight: unknown = 'unset';
  const o = once(d, state, { runCycle: async (b) => {
    credit = b.state.entries[id].creditMicro;
    inFlight = b.state.entries[id].refundInFlight;
  } });
  await o.run();
  assert.equal(credit, '0');
  assert.equal(inFlight, undefined);
  const saved = loadState(join(d, 'state.json')).entries[id];
  assert.equal(saved.creditMicro, '0');
  assert.equal(saved.refundInFlight, undefined);
  assert.deepEqual(readResolutions(d), {});
});

test('resolve-refund unsent clears refundInFlight and keeps the credit so the next cycle refunds again', async () => {
  const d = dir();
  const id = hex();
  const s = emptyState();
  s.entries[id] = entry(id, { refundInFlight: { to: ADDRESS, micro: '5000', at: 1 } });
  saveState(join(d, 'state.json'), s);
  resolveRefundCommand(d, id, 'unsent');
  const state = loadState(join(d, 'state.json'));
  await once(d, state).run();
  const saved = loadState(join(d, 'state.json')).entries[id];
  assert.equal(saved.creditMicro, '5000');
  assert.equal(saved.refundInFlight, undefined);
  assert.deepEqual(readResolutions(d), {});
});

test('a resolution for an allowance with no refund in flight changes nothing and is reported', async () => {
  const d = dir();
  const id = hex();
  const s = emptyState();
  s.entries[id] = entry(id);
  saveState(join(d, 'state.json'), s);
  resolveRefundCommand(d, id, 'sent');
  await once(d, loadState(join(d, 'state.json'))).run();
  assert.equal(loadState(join(d, 'state.json')).entries[id].creditMicro, '5000');
  assert.equal(health(d).problems.some((p: { key: string }) => p.key === 'resolve'), true);
  assert.deepEqual(readResolutions(d), {});
});

test('resolve-refund validates its arguments', () => {
  const d = dir();
  assert.throws(() => resolveRefundCommand(d, 'nope', 'sent'), /32 hex/);
  assert.throws(() => resolveRefundCommand(d, hex(), 'maybe' as never), /sent, unsent or abandon/);
});

test('resolve-refund abandon ends a refund that can never land as operator, writes the credit off, logs and raises no problem', async () => {
  const d = dir();
  const id = hex();
  const s = emptyState();
  s.entries[id] = entry(id, { creditMicro: '7000', refundInFlight: { to: ADDRESS, micro: '7000', at: 1 }, ending: { state: 'ended', endReason: 'home_gone' } });
  saveState(join(d, 'state.json'), s);
  resolveRefundCommand(d, id, 'abandon');
  assert.deepEqual(readResolutions(d), { [id]: 'abandon' });
  const logs: string[] = [];
  let seen: AllowEntry | undefined;
  await once(d, loadState(join(d, 'state.json')), { logs, runCycle: async (b) => void (seen = structuredClone(b.state.entries[id])) }).run();
  assert.equal(seen?.creditMicro, '0');
  assert.equal(seen?.refundInFlight, undefined);
  assert.deepEqual(seen?.ending, { state: 'ended', endReason: 'operator' });
  const saved = loadState(join(d, 'state.json')).entries[id];
  assert.equal(saved.abandonedMicro, '7000');
  assert.deepEqual(saved.ending, { state: 'ended', endReason: 'operator' });
  assert.deepEqual(readResolutions(d), {});
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /abandon.*7000.*settle it by hand/);
  assert.deepEqual(health(d).problems, []);
});

test('resolve-refund abandon works with no refund in flight (a refund that fails before it is sent, every cycle)', async () => {
  const d = dir();
  const id = hex();
  const s = emptyState();
  s.entries[id] = entry(id, { creditMicro: '9000', ending: { state: 'ended', endReason: 'stopped' } });
  saveState(join(d, 'state.json'), s);
  resolveRefundCommand(d, id, 'abandon');
  await once(d, loadState(join(d, 'state.json'))).run();
  const saved = loadState(join(d, 'state.json')).entries[id];
  assert.equal(saved.creditMicro, '0');
  assert.equal(saved.abandonedMicro, '9000');
  assert.deepEqual(saved.ending, { state: 'ended', endReason: 'operator' });
});

test('resolve-refund abandon on an allowance with no end decided changes nothing and is reported', async () => {
  const d = dir();
  const id = hex();
  const s = emptyState();
  s.entries[id] = entry(id);
  saveState(join(d, 'state.json'), s);
  resolveRefundCommand(d, id, 'abandon');
  await once(d, loadState(join(d, 'state.json'))).run();
  const saved = loadState(join(d, 'state.json')).entries[id];
  assert.equal(saved.creditMicro, '5000');
  assert.equal(saved.abandonedMicro, undefined);
  assert.ok(health(d).problems.some((p: { key: string; msg: string }) => p.key === 'resolve' && /no end decided/.test(p.msg)));
  assert.deepEqual(readResolutions(d), {});
});

test('parseArgs and status', () => {
  const id = hex();
  assert.deepEqual(parseArgs([]), { cmd: 'run' });
  assert.deepEqual(parseArgs(['stop', id]), { cmd: 'stop', id });
  assert.deepEqual(parseArgs(['resolve-refund', id, 'sent']), { cmd: 'resolve-refund', id, outcome: 'sent' });
  assert.deepEqual(parseArgs(['resolve-refund', id, 'abandon']), { cmd: 'resolve-refund', id, outcome: 'abandon' });
  assert.deepEqual(parseArgs(['status']), { cmd: 'status' });
  assert.throws(() => parseArgs(['resolve-refund', id]), /usage/);
  assert.throws(() => parseArgs(['bogus']), /usage/);
  const d = dir();
  const s = emptyState();
  s.entries[id] = entry(id, { refundInFlight: { to: ADDRESS, micro: '5', at: 1 } });
  saveState(join(d, 'state.json'), s);
  writeFileSync(join(d, 'health.json'), JSON.stringify({ at: T0, problems: [], ethWei: '1', usdcMicro: '2' }));
  stopCommand(d, id);
  const r = statusReport(d) as any;
  assert.deepEqual(r.stopped, [id]);
  assert.equal(r.entries[0].refundInFlight.micro, '5');
  assert.equal(r.healthAt, T0);
  assert.equal(existsSync(join(d, 'state.json')), true);
});
