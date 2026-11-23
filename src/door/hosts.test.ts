import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Offer } from '../types.js';
import { capitalAllocator, HostRegistry, hostIdOf, isProven, successRate } from './hosts.js';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

const OFFER: Offer = {
  id: 'o1', hostPubkey: '', ilpBase: '', sealKey: '', sealUrl: '', cpu: 1, memoryMiB: 1024, intervalSeconds: 3600,
  firstTickGraceSeconds: 90, tickPrice: 7000n, openPrice: 0n, statusPrice: 0n, images: ['charter-job-python'],
  hiddenHost: false, hiddenEgress: false, expiresAt: T0 + DAY,
};

function registry(): { reg: HostRegistry; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'hosts-')), 'hosts.json');
  return { reg: new HostRegistry(file), file };
}

function add(reg: HostRegistry, name: string, at = T0): string {
  const r = reg.register(`https://${name}.example`, at);
  assert.notEqual(r, 'bad_url');
  return (r as { hostId: string }).hostId;
}

test('hostIdOf is the sha256 hex of the normalized url', () => {
  assert.equal(hostIdOf('https://a.example'), createHash('sha256').update('https://a.example').digest('hex'));
  assert.match(hostIdOf('https://a.example'), /^[0-9a-f]{64}$/);
  assert.notEqual(hostIdOf('https://a.example'), hostIdOf('https://b.example'));
});

test('register is idempotent by normalized url and refuses a bad one', () => {
  const { reg } = registry();
  const a = reg.register('https://Host.Example/', T0);
  const b = reg.register('https://host.example', T0 + 5);
  assert.deepEqual(a, { hostId: hostIdOf('https://host.example'), state: 'probing' });
  assert.deepEqual(b, a);
  assert.equal(reg.all().length, 1);
  assert.equal(reg.get(hostIdOf('https://host.example'))!.registeredAt, T0);
  assert.equal(reg.register('http://host.example', T0), 'bad_url');
  assert.equal(reg.register('https://10.0.0.1', T0), 'bad_url');
});

test('a probe pass lists, a fail hides, three fails in a row drop', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  assert.deepEqual(reg.listed(), []);
  reg.probeResult(id, true, T0);
  assert.equal(reg.get(id)!.state, 'listed');
  assert.equal(reg.listed().length, 1);
  assert.ok(isProven(reg.get(id)!));
  reg.probeResult(id, false, T0 + DAY);
  assert.equal(reg.get(id)!.state, 'hidden');
  assert.deepEqual(reg.listed(), []);
  reg.probeResult(id, true, T0 + 2 * DAY);
  assert.equal(reg.get(id)!.state, 'listed');
  reg.probeResult(id, false, T0 + 3 * DAY);
  reg.probeResult(id, false, T0 + 4 * DAY);
  assert.equal(reg.get(id)!.state, 'hidden');
  reg.probeResult(id, false, T0 + 5 * DAY);
  const r = reg.get(id)!;
  assert.equal(r.state, 'dropped');
  assert.deepEqual(r.probes, { passed: 2, failed: 4, consecutiveFailed: 3, lastAt: T0 + 5 * DAY, lastFailedAt: T0 + 5 * DAY });
});

test('a dropped host registers again as probing with its counters kept', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  for (let i = 0; i < 3; i++) reg.probeResult(id, false, T0 + i * DAY);
  assert.equal(reg.get(id)!.state, 'dropped');
  assert.deepEqual(reg.register('https://a.example', T0 + 3 * DAY), { hostId: id, state: 'probing' });
  const r = reg.get(id)!;
  assert.equal(r.probes.failed, 3);
  assert.equal(r.probes.consecutiveFailed, 0);
  // One more failure hides it; it is not dropped again at once.
  reg.probeResult(id, false, T0 + 4 * DAY);
  assert.equal(reg.get(id)!.state, 'hidden');
});

test('dueProbes: first probes oldest registration first, at most perDay a day', () => {
  const { reg } = registry();
  const ids = ['a', 'b', 'c', 'd'].map((n, i) => add(reg, n, T0 + (3 - i)));
  // Registered d first (T0), then c, b, a.
  assert.deepEqual(reg.dueProbes(T0 + 10, 0, 2), [ids[3], ids[2]]);
  assert.deepEqual(reg.dueProbes(T0 + 10, 1, 2), [ids[3]]);
  assert.deepEqual(reg.dueProbes(T0 + 10, 2, 2), []);
  assert.deepEqual(reg.dueProbes(T0 + 10, 5, 2), []);
});

test('dueProbes never probes one host twice inside 24 h, and re-probes listed and hidden hosts daily', () => {
  const { reg } = registry();
  const listed = add(reg, 'listed');
  const hidden = add(reg, 'hidden');
  const dropped = add(reg, 'dropped');
  reg.probeResult(listed, true, T0);
  reg.probeResult(hidden, false, T0);
  for (let i = 0; i < 3; i++) reg.probeResult(dropped, false, T0 - 3 * DAY + i);
  assert.deepEqual(reg.dueProbes(T0 + DAY - 1, 0, 10), []);
  assert.deepEqual(new Set(reg.dueProbes(T0 + DAY, 0, 10)), new Set([listed, hidden]));
  // Re-probes are not first probes: perDay does not hold them back.
  assert.deepEqual(new Set(reg.dueProbes(T0 + DAY, 10, 10)), new Set([listed, hidden]));
});

test('a re-registered dropped host waits out 24 h from its last probe', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  for (let i = 0; i < 3; i++) reg.probeResult(id, false, T0 + i);
  reg.register('https://a.example', T0 + 10);
  assert.deepEqual(reg.dueProbes(T0 + 10, 0, 10), []);
  assert.deepEqual(reg.dueProbes(T0 + 2 + DAY, 0, 10), [id]);
});

test('two host failures in a row make the host due, first in line, within the 24 h rule', () => {
  const { reg } = registry();
  const a = add(reg, 'a');
  const b = add(reg, 'b');
  reg.probeResult(a, true, T0);
  reg.probeResult(b, true, T0 - 1000);
  reg.leaseOpened(b);
  reg.leaseHostFailed(b, T0 + 10);
  reg.leaseFinished(b, 3);
  reg.leaseHostFailed(b, T0 + 20);
  assert.equal(reg.get(b)!.probes.dueAt, undefined, 'a finish in between resets the run');
  reg.leaseHostFailed(a, T0 + 30);
  reg.leaseHostFailed(a, T0 + 40);
  assert.equal(reg.get(a)!.probes.dueAt, T0 + 40);
  assert.deepEqual(reg.dueProbes(T0 + 50, 0, 10), [], 'still inside 24 h of its last probe');
  // b's daily re-probe came due first, but a is due outside its schedule: a goes first.
  assert.deepEqual(reg.dueProbes(T0 + DAY, 0, 10), [a, b]);
  reg.probeResult(a, true, T0 + DAY);
  assert.equal(reg.get(a)!.probes.dueAt, undefined);
});

test('lease counters, success rate and the home map', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  assert.equal(successRate(reg.get(id)!), 1);
  reg.leaseOpened(id);
  reg.leaseOpened(id);
  reg.leaseOpened(id);
  reg.leaseFinished(id, 4);
  reg.leaseFinished(id, 2);
  reg.leaseHostFailed(id, T0);
  const r = reg.get(id)!;
  assert.deepEqual(r.leases, { opened: 3, finished: 2, hostFailed: 1, consecutiveHostFailed: 1 });
  assert.equal(r.intervalsPaid, 6);
  assert.equal(successRate(r), 2 / 3);
  assert.equal(r.homeTested, false);
  reg.markHomeTested(id);
  assert.equal(reg.get(id)!.homeTested, true);
  assert.equal(reg.homeHost('h1'), undefined);
  reg.setHomeHost('h1', id);
  assert.equal(reg.homeHost('h1'), id);
});

test('records come back as copies', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  reg.get(id)!.probes.passed = 99;
  reg.all()[0]!.state = 'listed';
  assert.equal(reg.get(id)!.probes.passed, 0);
  assert.equal(reg.get(id)!.state, 'probing');
});

test('the registry survives a reload from disk, offer prices included', () => {
  const { reg, file } = registry();
  const a = add(reg, 'a');
  const b = add(reg, 'b', T0 + 1);
  reg.setOffer(a, OFFER, T0 + 5);
  reg.probeResult(a, true, T0 + 6);
  reg.leaseOpened(a);
  reg.leaseFinished(a, 2);
  reg.leaseHostFailed(b, T0 + 7);
  reg.markHomeTested(a);
  reg.setHomeHost('home1', a);
  reg.countFirstProbe(T0 + 6);
  const again = new HostRegistry(file);
  assert.deepEqual(again.all(), reg.all());
  assert.equal(again.get(a)!.offer!.tickPrice, 7000n);
  assert.equal(again.get(a)!.offerFetchedAt, T0 + 5);
  assert.equal(again.get(a)!.lastSeenAt, T0 + 6);
  assert.equal(again.homeHost('home1'), a);
  assert.equal(again.firstProbesToday(T0 + 6), 1);
  assert.match(readFileSync(file, 'utf8'), /"hostId"/);
});

test('firstProbesToday counts by UTC day', () => {
  const { reg } = registry();
  const day = Date.UTC(2027, 0, 1);
  reg.countFirstProbe(day + 1000);
  reg.countFirstProbe(day + 2000);
  assert.equal(reg.firstProbesToday(day + DAY - 1), 2);
  assert.equal(reg.firstProbesToday(day + DAY), 0);
  reg.countFirstProbe(day + DAY);
  assert.equal(reg.firstProbesToday(day + DAY), 1);
});

const CAPS = { probeDeposit: 100_000n, hostDeposit: 500_000n, probeCap: 1_000_000n, hostCap: 10_000_000n };

test('allocator: 10 unproven hosts at 0.10 fill the 1 USDC probe cap and the 11th is over_cap', () => {
  const { reg } = registry();
  const locked = new Map<string, bigint>();
  const alloc = capitalAllocator({ registry: reg, locked: (id) => locked.get(id) ?? 0n, ...CAPS });
  for (let i = 0; i < 11; i++) {
    const id = add(reg, `u${i}`);
    const d = alloc(id);
    if (i < 10) {
      assert.equal(d, 100_000n, `host ${i}`);
      locked.set(id, d as bigint);
    } else assert.equal(d, 'over_cap');
  }
  // Asking again changes nothing: the allocator has no side effects.
  assert.equal(alloc(add(reg, 'u10')), 'over_cap');
});

test('allocator: proven hosts at 0.50 fill 10 USDC at 20, apart from the probe cap', () => {
  const { reg } = registry();
  const locked = new Map<string, bigint>();
  const alloc = capitalAllocator({ registry: reg, locked: (id) => locked.get(id) ?? 0n, ...CAPS });
  // The probe tier is full, which does not touch the proven tier.
  for (let i = 0; i < 10; i++) locked.set(add(reg, `u${i}`), 100_000n);
  for (let i = 0; i < 21; i++) {
    const id = add(reg, `p${i}`);
    reg.probeResult(id, true, T0);
    const d = alloc(id);
    if (i < 20) {
      assert.equal(d, 500_000n, `host ${i}`);
      locked.set(id, d as bigint);
    } else assert.equal(d, 'over_cap');
  }
  assert.equal(alloc(add(reg, 'u-new')), 'over_cap');
});

test('allocator: a host that passes its probe moves its locked capital to the proven tier', () => {
  const { reg } = registry();
  const locked = new Map<string, bigint>();
  const alloc = capitalAllocator({ registry: reg, locked: (id) => locked.get(id) ?? 0n, ...CAPS });
  const ids = Array.from({ length: 10 }, (_, i) => add(reg, `u${i}`));
  for (const id of ids) locked.set(id, 100_000n);
  const next = add(reg, 'next');
  assert.equal(alloc(next), 'over_cap');
  reg.probeResult(ids[0]!, true, T0);
  assert.equal(alloc(next), 100_000n);
  assert.equal(alloc(ids[0]!), 500_000n);
});

test('allocator: an unknown or dropped host gets nothing', () => {
  const { reg } = registry();
  const alloc = capitalAllocator({ registry: reg, locked: () => 0n, ...CAPS });
  assert.equal(alloc('f'.repeat(64)), 'over_cap');
  const id = add(reg, 'a');
  for (let i = 0; i < 3; i++) reg.probeResult(id, false, T0 + i);
  assert.equal(alloc(id), 'over_cap');
});
