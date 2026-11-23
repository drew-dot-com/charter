import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChannelConfig } from '@x402/evm';
import type { Offer } from '../types.js';
import type { ChannelChain, DoorChannel } from './channel-chain.js';
import { capitalAllocator, hostFundingWaiting, HostRegistry, hostIdOf, isProven, publicRecord, rankOffers, reapChannels, startChannelReaper, successRate } from './hosts.js';

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

const OFFER: Offer = {
  id: 'o1', hostId: 'ab'.repeat(32), url: 'https://host.example', payTo: `0x${'3'.repeat(40)}`, cpu: 1, memoryMiB: 1024, intervalSeconds: 3600,
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

test('a dropped host registers again as probing with every counter kept, and one more failure drops it again', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  for (let i = 0; i < 3; i++) reg.probeResult(id, false, T0 + i * DAY);
  assert.equal(reg.get(id)!.state, 'dropped');
  assert.deepEqual(reg.register('https://a.example', T0 + 3 * DAY), { hostId: id, state: 'probing' });
  const r = reg.get(id)!;
  assert.equal(r.probes.failed, 3);
  assert.equal(r.probes.consecutiveFailed, 3);
  reg.probeResult(id, false, T0 + 4 * DAY);
  assert.equal(reg.get(id)!.state, 'dropped');
  assert.equal(reg.get(id)!.probes.consecutiveFailed, 4);
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

test('two host failures in a row hide a listed host until its next probe, 24 h on, passes', () => {
  const { reg } = registry();
  const a = add(reg, 'a');
  const b = add(reg, 'b');
  reg.probeResult(a, true, T0);
  reg.probeResult(b, true, T0);
  // A finish in between breaks the run.
  reg.leaseHostFailed(b, T0 + 10);
  reg.leaseFinished(b, 3);
  reg.leaseHostFailed(b, T0 + 20);
  assert.equal(reg.get(b)!.state, 'listed');
  reg.leaseHostFailed(a, T0 + 30);
  assert.equal(reg.get(a)!.state, 'listed');
  reg.leaseHostFailed(a, T0 + 40);
  assert.equal(reg.get(a)!.state, 'hidden');
  assert.deepEqual(reg.listed().map((r) => r.hostId), [b]);
  assert.deepEqual(reg.dueProbes(T0 + 50, 0, 10), [], 'the 24 h rule still holds');
  assert.ok(reg.dueProbes(T0 + DAY, 0, 10).includes(a));
  reg.probeResult(a, true, T0 + DAY);
  assert.equal(reg.get(a)!.state, 'listed');
  assert.equal(reg.get(a)!.leases.consecutiveHostFailed, 0);
  // The run starts over: one more failure does not hide it.
  reg.leaseHostFailed(a, T0 + DAY + 1);
  assert.equal(reg.get(a)!.state, 'listed');
});

test('host failures do not move a host that is not listed', () => {
  const { reg } = registry();
  const id = add(reg, 'a');
  reg.leaseHostFailed(id, T0);
  reg.leaseHostFailed(id, T0 + 1);
  assert.equal(reg.get(id)!.state, 'probing');
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

/** A listed host with `finished` and `failed` real leases (failures first, so it is never hidden). */
function withRecord(reg: HostRegistry, name: string, finished: number, failed: number): string {
  const id = add(reg, name);
  reg.probeResult(id, true, T0);
  for (let i = 0; i < failed; i++) (reg.leaseOpened(id), reg.leaseHostFailed(id, T0), reg.leaseFinished(id, 1), (finished -= 1));
  for (let i = 0; i < finished; i++) (reg.leaseOpened(id), reg.leaseFinished(id, 1));
  return id;
}
const offerOn = (hostId: string, tickPrice: bigint, over: Partial<Offer> = {}): Offer => ({ ...OFFER, hostId, url: `https://${hostId.slice(0, 8)}.example`, tickPrice, ...over });

test('rankOffers: a 0.95 host beats a cheaper 0.5 host; a 0.5 host is picked when it is the only one', () => {
  const { reg } = registry();
  const good = withRecord(reg, 'good', 19, 1);
  const flaky = withRecord(reg, 'flaky', 1, 1);
  assert.equal(successRate(reg.get(good)!), 0.95);
  assert.equal(successRate(reg.get(flaky)!), 0.5);
  const cheap = offerOn(flaky, 1000n);
  const dear = offerOn(good, 9000n);
  assert.deepEqual(rankOffers([cheap, dear], reg), [dear]);
  assert.deepEqual(rankOffers([cheap], reg), [cheap]);
});

test('rankOffers: proven beats new; a tie on price breaks by hostId', () => {
  const { reg } = registry();
  const proven = withRecord(reg, 'proven', 3, 0);
  const fresh = withRecord(reg, 'fresh', 0, 0);
  assert.deepEqual(rankOffers([offerOn(fresh, 1000n), offerOn(proven, 9000n)], reg).map((o) => o.hostId), [proven, fresh]);
  const a = withRecord(reg, 'a', 3, 0);
  const b = withRecord(reg, 'b', 3, 0);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  assert.deepEqual(rankOffers([offerOn(hi, 5000n), offerOn(lo, 5000n)], reg).map((o) => o.hostId), [lo, hi]);
});

test('rankOffers: only listed hosts appear, and a host waiting for funding is skipped', () => {
  const { reg } = registry();
  const listed = withRecord(reg, 'listed', 1, 0);
  const hidden = withRecord(reg, 'hidden', 1, 0);
  reg.probeResult(hidden, false, T0 + DAY);
  const probing = add(reg, 'probing');
  const waiting = withRecord(reg, 'waiting', 5, 0);
  const list = [offerOn(listed, 9000n), offerOn(hidden, 1000n), offerOn(probing, 1000n), offerOn(waiting, 1000n)];
  assert.deepEqual(rankOffers(list, reg, { waiting: (id) => id === waiting }).map((o) => o.hostId), [listed]);
  assert.deepEqual(rankOffers(list, reg).map((o) => o.hostId), [waiting, listed]);
});

test('rankOffers: for a home job, an untested home offer comes after a tested one', () => {
  const { reg } = registry();
  const tested = withRecord(reg, 'tested', 1, 0);
  reg.markHomeTested(tested);
  const untested = withRecord(reg, 'untested', 1, 0);
  const home = { diskGiB: 10, retentionDays: 7, slots: 2 };
  const list = [offerOn(untested, 1000n, { home }), offerOn(tested, 9000n, { home })];
  assert.deepEqual(rankOffers(list, reg, { home: true }).map((o) => o.hostId), [tested, untested]);
  assert.deepEqual(rankOffers(list, reg).map((o) => o.hostId), [untested, tested], 'a job that is not a home ranks by price');
});

test('publicRecord: what a renter sees of a host', () => {
  const { reg } = registry();
  const id = withRecord(reg, 'a', 2, 0);
  reg.probeResult(id, false, T0 + DAY);
  reg.probeResult(id, true, T0 + 2 * DAY);
  assert.deepEqual(publicRecord(reg.get(id)!), { probesPassed: 2, leasesFinished: 2, successRate: 1, new: false, lastProbeFailedAt: T0 + DAY });
  const fresh = withRecord(reg, 'b', 0, 0);
  assert.deepEqual(publicRecord(reg.get(fresh)!, true), { probesPassed: 1, leasesFinished: 0, successRate: 1, new: true, funding: 'waiting' });
});

test('hostFundingWaiting: a proven host with nothing locked that the allocator refuses', () => {
  const { reg } = registry();
  const id = withRecord(reg, 'a', 1, 0);
  const unproven = add(reg, 'u');
  const locked = new Map<string, bigint>();
  let answer: bigint | 'over_cap' = 'over_cap';
  const waiting = hostFundingWaiting({ registry: reg, locked: (h) => locked.get(h) ?? 0n, depositFor: () => answer });
  assert.equal(waiting(id), true);
  assert.equal(waiting(unproven), false, 'an unproven host is not listed, so never waiting');
  locked.set(id, 100_000n);
  assert.equal(waiting(id), false, 'a channel that holds funds needs no deposit');
  locked.delete(id);
  answer = 500_000n;
  assert.equal(waiting(id), false);
});

/** A fake chain and payer for the reaper: channels by id, writes recorded. */
function fakeChannels() {
  const config = (n: number): ChannelConfig => ({
    payer: `0x${'1'.repeat(40)}`, payerAuthorizer: `0x${'1'.repeat(40)}`, receiver: `0x${'3'.repeat(40)}`, receiverAuthorizer: `0x${'4'.repeat(40)}`,
    token: `0x${'5'.repeat(40)}`, withdrawDelay: 3600, salt: `0x${n.toString(16).padStart(64, '0')}`,
  });
  const state = new Map<string, { balance: bigint; totalClaimed: bigint; pending: bigint; initiatedAt: number }>();
  const byHost = new Map<string, DoorChannel[]>();
  const writes: string[] = [];
  const resynced: string[] = [];
  let n = 0;
  /** A channel the door holds to `hostId`; `charged` is the door's record of what its vouchers owe (default: all claimed). */
  const open = (hostId: string, balance: bigint, totalClaimed = 0n, charged = totalClaimed): `0x${string}` => {
    const channelId = `0x${(++n).toString(16).padStart(64, 'c')}` as `0x${string}`;
    state.set(channelId, { balance, totalClaimed, pending: 0n, initiatedAt: 0 });
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), { channelId, config: config(n), balance, charged }]);
    return channelId;
  };
  /** The same channel kept under a second host too. */
  const share = (hostId: string, channelId: string): void => {
    const c = [...byHost.values()].flat().find((x) => x.channelId === channelId)!;
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), c]);
  };
  const clock = { t: T0 };
  const chain: ChannelChain = {
    state: async (id) => {
      const s = state.get(id)!;
      return { balance: s.balance, totalClaimed: s.totalClaimed, withdrawInitiatedAt: s.initiatedAt };
    },
    initiateWithdraw: async (c, amount) => {
      writes.push(`initiate ${c.channelId} ${amount}`);
      Object.assign(state.get(c.channelId)!, { pending: amount, initiatedAt: Math.floor(clock.t / 1000) });
    },
    finalizeWithdraw: async (c) => {
      writes.push(`finalize ${c.channelId}`);
      const s = state.get(c.channelId)!;
      Object.assign(s, { balance: s.balance - s.pending, pending: 0n, initiatedAt: 0 });
    },
  };
  const payer = {
    channels: async (hostId: string) => byHost.get(hostId) ?? [],
    resync: async (hostId: string, channelId: string) => void resynced.push(`${hostId.slice(0, 4)} ${channelId}`),
  };
  return { chain, payer, open, share, state, writes, resynced, clock };
}

function reaperFor(reg: HostRegistry, f: ReturnType<typeof fakeChannels>, lastLeaseAt: Map<string, number>, locked: Map<string, bigint>, ticking = new Set<string>()) {
  const logs: string[] = [];
  const capital = {
    locked: (h: string) => locked.get(h) ?? 0n,
    withdrawn: (h: string, a: bigint) => void locked.set(h, (locked.get(h) ?? 0n) - a > 0n ? (locked.get(h) ?? 0n) - a : 0n),
  };
  return {
    logs,
    run: () => reapChannels({
      registry: reg, payer: f.payer, chain: f.chain, capital, lastLeaseAt: (h) => lastLeaseAt.get(h), ticking: (h) => ticking.has(h),
      now: () => f.clock.t, log: (m) => void logs.push(m),
    }),
  };
}

test('the reaper withdraws a channel idle 7 days and a dropped host\'s channel, and leaves a 6-day-idle one', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const idle = withRecord(reg, 'idle', 1, 0);
  const recent = withRecord(reg, 'recent', 1, 0);
  const dropped = withRecord(reg, 'dropped', 1, 0);
  for (let i = 1; i <= 3; i++) reg.probeResult(dropped, false, T0 + i * DAY);
  assert.equal(reg.get(dropped)!.state, 'dropped');
  const cIdle = f.open(idle, 500_000n, 120_000n);
  const cRecent = f.open(recent, 500_000n);
  const cDropped = f.open(dropped, 100_000n, 7000n);
  f.clock.t = T0 + 10 * DAY;
  const last = new Map([[idle, f.clock.t - 7 * DAY], [recent, f.clock.t - 6 * DAY], [dropped, f.clock.t - 60_000]]);
  const r = reaperFor(reg, f, last, new Map());
  await r.run();
  assert.deepEqual(f.writes.sort(), [`initiate ${cDropped} 93000`, `initiate ${cIdle} 380000`].sort());
  assert.ok(!f.writes.some((w) => w.includes(cRecent)), 'a channel idle 6 days is left alone');
  // A round inside the withdraw delay asks nothing again.
  f.clock.t += 1000 * 1000;
  await r.run();
  assert.equal(f.writes.length, 2);
});

test('the reaper finalizes a withdrawal past its delay, and an emptied host\'s capital leaves locked', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const id = withRecord(reg, 'a', 1, 0);
  const c = f.open(id, 500_000n, 120_000n);
  const locked = new Map([[id, 500_000n]]);
  const last = new Map([[id, T0]]);
  f.clock.t = T0 + 8 * DAY;
  const r = reaperFor(reg, f, last, locked);
  await r.run();
  assert.deepEqual(f.writes, [`initiate ${c} 380000`]);
  assert.equal(locked.get(id), 500_000n, 'nothing has come back yet');
  f.clock.t += 3600 * 1000;
  await r.run();
  assert.deepEqual(f.writes, [`initiate ${c} 380000`, `finalize ${c}`]);
  assert.equal(f.state.get(c)!.balance, 120_000n);
  assert.equal(locked.get(id), 0n, 'the channel holds nothing of the door\'s: its capital is free');
  assert.deepEqual(f.resynced, [`${id.slice(0, 4)} ${c}`], 'the door\'s record follows the chain');
  assert.ok(r.logs.some((l) => l.includes('380000')), r.logs.join('\n'));
  await r.run();
  assert.equal(f.writes.length, 2, 'an empty channel is not withdrawn again');
});

test('the reaper frees an idle host\'s capital once the host refunded its channel itself', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const id = withRecord(reg, 'a', 1, 0);
  const c = f.open(id, 500_000n, 70_000n);
  const locked = new Map([[id, 500_000n]]);
  // The host refunded the unspent 430000 back to the door.
  f.state.get(c)!.balance = 70_000n;
  f.clock.t = T0 + 8 * DAY;
  const r = reaperFor(reg, f, new Map([[id, T0]]), locked);
  await r.run();
  assert.deepEqual(f.writes, [], 'nothing left to withdraw');
  assert.equal(locked.get(id), 0n);
});

test('startChannelReaper runs a round at once and stops', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const id = withRecord(reg, 'a', 1, 0);
  f.open(id, 500_000n);
  f.clock.t = T0 + 8 * DAY;
  const stop = startChannelReaper({
    registry: reg, payer: f.payer, chain: f.chain, capital: { locked: () => 0n, withdrawn: () => undefined },
    lastLeaseAt: () => undefined, ticking: () => false, now: () => f.clock.t, log: () => undefined,
  });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  stop();
  assert.equal(f.writes.length, 1);
});

test('R11: a channel kept under two hosts is left alone by the reaper', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const a = withRecord(reg, 'a', 1, 0);
  const b = withRecord(reg, 'b', 1, 0);
  for (let i = 1; i <= 3; i++) reg.probeResult(b, false, T0 + i * DAY);
  const shared = f.open(a, 500_000n);
  f.share(b, shared);
  const own = f.open(b, 100_000n);
  f.clock.t = T0 + 10 * DAY;
  const r = reaperFor(reg, f, new Map([[a, f.clock.t], [b, f.clock.t]]), new Map([[b, 100_000n]]));
  await r.run();
  assert.deepEqual(f.writes, [`initiate ${own} 100000`], 'only the dropped host\'s own channel');
  assert.ok(r.logs.some((l) => l.includes(shared) && l.includes('more than one host')), r.logs.join('\n'));
});

test('R11: a dropped host is not withdrawn while a lease still ticks on it, and is once it stops', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const id = withRecord(reg, 'a', 1, 0);
  for (let i = 1; i <= 3; i++) reg.probeResult(id, false, T0 + i * DAY);
  const c = f.open(id, 500_000n);
  f.clock.t = T0 + 4 * DAY;
  const ticking = new Set([id]);
  const r = reaperFor(reg, f, new Map([[id, f.clock.t - 60_000]]), new Map(), ticking);
  await r.run();
  assert.deepEqual(f.writes, []);
  ticking.delete(id);
  await r.run();
  assert.deepEqual(f.writes, [`initiate ${c} 500000`]);
});

test('R11: the withdrawal leaves what the door\'s vouchers owe the host, claimed or not', async () => {
  const { reg } = registry();
  const f = fakeChannels();
  const id = withRecord(reg, 'a', 1, 0);
  // 0.50 deposited, 0.10 claimed, 0.30 charged by the door's vouchers: 0.20 is the door's.
  const c = f.open(id, 500_000n, 100_000n, 300_000n);
  const locked = new Map([[id, 200_000n]]);
  f.clock.t = T0 + 8 * DAY;
  const r = reaperFor(reg, f, new Map([[id, T0]]), locked);
  await r.run();
  assert.deepEqual(f.writes, [`initiate ${c} 200000`]);
  f.clock.t += 3600 * 1000;
  await r.run();
  assert.equal(f.state.get(c)!.balance, 300_000n, 'the host can still claim its 0.20 unclaimed');
  assert.equal(locked.get(id), 0n, 'nothing of the door\'s is left: empty by the same measure');
  await r.run();
  assert.equal(f.writes.length, 2, 'and it is not withdrawn again');
});

