import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lease, Offer } from '../types.js';
import { OFFER_KIND } from '../offer.js';
import { RunnerError, type Runner } from './runner.js';
import { BOOT_TIMEOUT_MS, homeSweep, landAll, offerTick, reconcile, windowTick, type LoopDeps } from './loop.js';
import { GRACE_MS, onTick } from '../lease.js';
import { LeaseStore } from './store.js';
import { HOME_RETENTION_MS, HomeStore, type HomeRecord } from './homes.js';
import { homeIdOf, homeJob, normalizeSshKeys } from '../jobs.js';

const T0 = 1_000_000;
const JOB = { image: 'charter-job-fetch', args: {} };
const OFFER: Offer = {
  id: 'o1', hostPubkey: '', ilpBase: 'g.test', sealKey: '0x04' + 'ab'.repeat(64), sealUrl: 'http://x.anyone/ilp', cpu: 1,
  memoryMiB: 1024, intervalSeconds: 30, firstTickGraceSeconds: 90, tickPrice: 5000n, openPrice: 1000n, statusPrice: 100n, images: ['charter-job-fetch'],
  hiddenHost: true, hiddenEgress: false, expiresAt: 0,
};

function lease(over: Partial<Lease> & { id: string }): Lease {
  return { offerId: 'o1', job: JOB, state: 'running', createdAt: T0, paidIntervals: 1, startedAt: T0, ...over };
}

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1';
const HOME_KEYS = normalizeSshKeys([KEY])!;
const HOME_JOB = homeJob(HOME_KEYS);
const HOME_ID = homeIdOf(HOME_KEYS);

function homeLease(over: Partial<Lease> & { id: string }): Lease {
  return lease({ job: HOME_JOB, homeId: HOME_ID, restarts: 0, paidThrough: T0 + 30_000, bootedAt: T0, ...over });
}

function homeStore(...recs: Array<Partial<HomeRecord> & { homeId: string }>): HomeStore {
  const s = new HomeStore();
  for (const r of recs) s.put({ port: 22000, createdAt: T0, paidOnce: false, ...r });
  return s;
}

function fakeRunner(over: Partial<Runner> = {}) {
  const stops: string[] = [];
  const r: Runner = {
    create: async () => undefined,
    start: async () => undefined,
    exited: () => new Promise<number>(() => undefined),
    stop: async (id) => void stops.push(id),
    output: async () => Buffer.alloc(0),
    alive: async () => true,
    ensureHome: async () => ({ homeId: '', port: 0, createdAt: 0, paidOnce: false }),
    publishHome: async () => undefined,
    retireHome: async () => undefined,
    homeAccess: async () => null,
    removeHome: async () => undefined,
    writePaidThrough: async () => undefined,
    ...over,
  };
  return { r, stops };
}

const tick = () => new Promise((r) => setImmediate(r));

test('windowTick closes a running lease past paidThrough + grace and stops the container once', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const { r, stops } = fakeRunner();
  let now = T0 + 30_000 + 10_000;
  const deps = { store, runner: r, now: () => now };

  await windowTick(deps);
  assert.equal(store.get('a')!.state, 'running', 'at the grace edge it is still running');
  assert.deepEqual(stops, []);

  now = T0 + 30_000 + 10_001;
  await windowTick(deps);
  assert.equal(store.get('a')!.state, 'closed');
  assert.equal(store.get('a')!.closedReason, 'missed_tick');
  await windowTick(deps);
  assert.deepEqual(stops, ['a']);
});

test('F-C3: windowTick gives the first tick 90 s after the container is created, then closes the lease', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', state: 'awaiting_first_tick', paidIntervals: 0, bootedAt: T0, startedAt: undefined }));
  const { r, stops } = fakeRunner();
  const deps = { store, runner: r, now: () => T0 + 10_001 };
  await windowTick(deps);
  assert.equal(store.get('a')!.state, 'awaiting_first_tick', 'ten seconds is too short for a wallet prompt');
  deps.now = () => T0 + 90_001;
  await windowTick(deps);
  assert.equal(store.get('a')!.closedReason, 'missed_tick');
  assert.deepEqual(stops, ['a']);
});

test('F-C3: windowTick never waits on a container that has not started (docker wait returns at once on a created one)', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'created', state: 'awaiting_first_tick', paidIntervals: 0, bootedAt: T0, startedAt: undefined }));
  store.put(lease({ id: 'starting', paidThrough: T0 + 30_000, bootedAt: T0, startedAt: undefined }));
  store.put(lease({ id: 'started', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const waited: string[] = [];
  const { r } = fakeRunner({ exited: (id) => { waited.push(id); return new Promise<number>(() => undefined); } });
  await windowTick({ store, runner: r, now: () => T0 + 1000 });
  assert.deepEqual(waited, ['started']);
  assert.equal(store.get('created')!.state, 'awaiting_first_tick');
  assert.equal(store.get('starting')!.state, 'running');
});

test('windowTick closes a lease stuck booting past the boot timeout as boot_failed', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', state: 'booting', paidIntervals: 0 }));
  const { r, stops } = fakeRunner();
  const deps = { store, runner: r, now: () => T0 + BOOT_TIMEOUT_MS };
  await windowTick(deps);
  assert.equal(store.get('a')!.state, 'booting');
  deps.now = () => T0 + BOOT_TIMEOUT_MS + 1;
  await windowTick(deps);
  assert.equal(store.get('a')!.state, 'closed');
  assert.equal(store.get('a')!.closedReason, 'boot_failed');
  assert.deepEqual(stops, ['a']);
});

test('windowTick leaves a paid running lease alone and waits on exited once', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  let waits = 0;
  const { r, stops } = fakeRunner({ exited: () => { waits++; return new Promise<number>(() => undefined); } });
  const deps = { store, runner: r, now: () => T0 + 5_000 };
  await windowTick(deps);
  await windowTick(deps);
  await windowTick(deps);
  assert.equal(waits, 1);
  assert.deepEqual(stops, []);
  assert.equal(store.get('a')!.state, 'running');
});

test('a job exiting 0 makes the lease done with its output part count', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const { r } = fakeRunner({ exited: async () => 0, output: async () => Buffer.alloc(100 * 1024) });
  await windowTick({ store, runner: r, now: () => T0 + 1000 });
  await tick();
  await tick();
  assert.equal(store.get('a')!.state, 'done');
  assert.equal(store.get('a')!.outputParts, 3);
});

test('a non-zero exit, or unreadable output, makes the lease done with 0 parts', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  store.put(lease({ id: 'b', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const { r } = fakeRunner({
    exited: async (id) => (id === 'a' ? 3 : 0),
    output: async () => { throw new RunnerError('bad_output', 'symlink'); },
  });
  await windowTick({ store, runner: r, now: () => T0 + 1000 });
  await tick();
  await tick();
  for (const id of ['a', 'b']) {
    assert.equal(store.get(id)!.state, 'done');
    assert.equal(store.get(id)!.outputParts, 0);
  }
});

test('an exit after the lease was closed changes nothing', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  let release!: (n: number) => void;
  const { r } = fakeRunner({ exited: () => new Promise<number>((res) => (release = res)) });
  const deps = { store, runner: r, now: () => T0 + 1000 };
  await windowTick(deps);
  store.put({ ...store.get('a')!, state: 'closed', closedReason: 'missed_tick' });
  release(137);
  await tick();
  await tick();
  assert.equal(store.get('a')!.state, 'closed');
});

test('reconcile closes a stored running lease whose container is gone as host_restart', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'gone', paidThrough: T0 + 30_000 }));
  store.put(lease({ id: 'alive', paidThrough: T0 + 30_000 }));
  store.put(lease({ id: 'boot', state: 'booting', paidIntervals: 0 }));
  store.put(lease({ id: 'wait', state: 'awaiting_first_tick', paidIntervals: 0, bootedAt: T0 }));
  store.put(lease({ id: 'fin', state: 'done', outputParts: 1 }));
  const asked: string[] = [];
  const { r } = fakeRunner({ alive: async (id) => { asked.push(id); return id === 'alive'; } });
  const { stops } = (() => ({ stops: [] as string[] }))();
  r.stop = async (id) => void stops.push(id);
  await reconcile({ store, runner: r, now: () => T0 });
  // A created container that never started is not running: it is closed and removed.
  assert.deepEqual(stops.sort(), ['boot', 'gone', 'wait']);
  assert.equal(store.get('gone')!.state, 'closed');
  assert.equal(store.get('gone')!.closedReason, 'host_restart');
  assert.equal(store.get('boot')!.closedReason, 'host_restart');
  assert.equal(store.get('wait')!.closedReason, 'host_restart');
  assert.equal(store.get('alive')!.state, 'running');
  assert.equal(store.get('fin')!.state, 'done');
  assert.ok(!asked.includes('fin'));
});

test('offerTick publishes kind 31390 expiring 45 minutes ahead', async () => {
  const published: Array<{ ev: { kind: number; tags: string[][]; content: string }; relay: string }> = [];
  const cli = { publishEvent: async (ev: any, relay: string) => { published.push({ ev, relay }); return 'evid'; } };
  const now = 5_000_000_000;
  const id = await offerTick({ cli, offer: OFFER, relayUrl: 'wss://relay.example', now: () => now });
  assert.equal(id, 'evid');
  assert.equal(published.length, 1);
  assert.equal(published[0]!.relay, 'wss://relay.example');
  const { ev } = published[0]!;
  assert.equal(ev.kind, OFFER_KIND);
  assert.equal(ev.kind, 31390);
  assert.deepEqual(ev.tags.find((t) => t[0] === 'expiration'), ['expiration', String(Math.floor((now + 45 * 60_000) / 1000))]);
  assert.deepEqual(ev.tags.find((t) => t[0] === 'L'), ['L', 'charter']);
});

test('landAll lands inbound channels only and records the first tx on each paid, unlanded lease', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'paid' }));
  store.put(lease({ id: 'unpaid', paidIntervals: 0, state: 'closed', closedReason: 'missed_tick' }));
  store.put(lease({ id: 'already', landing: { chain: 'solana', tx: 'old', shared: true } }));
  const landed: string[] = [];
  const cli = {
    channels: async () => [
      { id: 'in1', direction: 'inbound' as const, chain: 'solana' },
      { id: 'out1', direction: 'outbound' as const, chain: 'solana' },
    ],
    land: async (id: string) => { landed.push(id); return [{ chain: 'solana', tx: 'tx1' }, { chain: 'solana', tx: 'tx2' }]; },
  };
  const r = await landAll({ cli, store });
  assert.deepEqual(landed, ['in1']);
  assert.deepEqual(r.recorded, ['paid']);
  assert.deepEqual(store.get('paid')!.landing, { chain: 'solana', tx: 'tx1', shared: true });
  assert.equal(store.get('unpaid')!.landing, undefined);
  assert.equal(store.get('already')!.landing!.tx, 'old');
});

test('landAll with no inbound channel or no txs records nothing and does not throw', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'paid' }));
  const none = await landAll({ cli: { channels: async () => [], land: async () => [] }, store });
  assert.deepEqual(none.txs, []);
  const empty = await landAll({
    cli: { channels: async () => [{ id: 'i', direction: 'inbound' as const, chain: 'solana' }], land: async () => [] },
    store,
  });
  assert.deepEqual(empty.recorded, []);
  assert.equal(store.get('paid')!.landing, undefined);
});

test('landAll keeps going when one channel fails to land and reports the error', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'paid' }));
  const cli = {
    channels: async () => [
      { id: 'bad', direction: 'inbound' as const, chain: 'solana' },
      { id: 'good', direction: 'inbound' as const, chain: 'solana' },
    ],
    land: async (id: string) => { if (id === 'bad') throw new Error('boom'); return [{ chain: 'solana', tx: 'tx9' }]; },
  };
  const r = await landAll({ cli, store });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!, /bad/);
  assert.equal(store.get('paid')!.landing!.tx, 'tx9');
});

test('windowTick decides each lease from a fresh read: a tick paid during an earlier stop is kept', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  store.put(lease({ id: 'b', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const now = T0 + 30_000 + 10_001;
  const { r, stops } = fakeRunner({
    stop: async (id) => {
      stops.push(id);
      if (id === 'a') store.put(onTick(store.get('b')!, 1, now, 30_000).lease);
    },
  });
  await windowTick({ store, runner: r, now: () => now });
  assert.deepEqual(stops, ['a']);
  assert.equal(store.get('a')!.state, 'closed');
  assert.equal(store.get('b')!.state, 'running');
  assert.equal(store.get('b')!.paidIntervals, 2);
});

test('windowTick does not overwrite a landing written while it was stopping an earlier lease', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', paidThrough: T0 + 30_000, bootedAt: T0 }));
  store.put(lease({ id: 'b', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const { r } = fakeRunner({
    stop: async (id) => {
      if (id === 'a') store.put({ ...store.get('b')!, landing: { chain: 'solana', tx: 't', shared: true } });
    },
  });
  await windowTick({ store, runner: r, now: () => T0 + 30_000 + 10_001 });
  assert.equal(store.get('b')!.state, 'closed');
  assert.equal(store.get('b')!.landing?.tx, 't');
});

test('windowTick never watches a home\'s exit and fills its access once anon has the hostname', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h' }));
  const homes = homeStore({ homeId: HOME_ID });
  const asked: string[] = [];
  let ready = false;
  let exits = 0;
  const { r } = fakeRunner({
    exited: () => { exits++; return new Promise<number>(() => undefined); },
    homeAccess: async (id) => {
      asked.push(id);
      return ready ? { ssh: { host: 'abc.anon', port: 22, user: 'tenant' } } : null;
    },
  });
  const deps: LoopDeps = { store, runner: r, homes, now: () => T0 + 1000 };
  await windowTick(deps);
  assert.equal(store.get('h')!.access ?? null, null, 'no hostname yet');
  ready = true;
  await windowTick(deps);
  assert.equal(store.get('h')!.access?.ssh.host, 'abc.anon');
  await windowTick(deps);
  assert.deepEqual(asked, [HOME_ID, HOME_ID], 'filled access is not asked again');
  assert.equal(store.get('h')!.state, 'running');
  assert.equal(exits, 0);
  assert.ok(!deps.watched!.has('h'));
});

test('windowTick publishes a running home\'s onion once per process, and retries a failed publish', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h', access: { ssh: { host: 'abc.anon', port: 22, user: 'tenant' } } }));
  const homes = homeStore({ homeId: HOME_ID });
  const published: string[] = [];
  let fail = true;
  const logs: string[] = [];
  const { r } = fakeRunner({
    publishHome: async (id) => {
      published.push(id);
      if (fail) throw new Error('no_pid');
    },
  });
  const deps = { store, runner: r, homes, now: () => T0 + 1000, log: (m: string) => void logs.push(m) };
  await windowTick(deps);
  fail = false;
  await windowTick(deps);
  await windowTick(deps);
  assert.deepEqual(published, [HOME_ID, HOME_ID]);
  assert.ok(logs.some((m) => /no_pid/.test(m)));
});

test('a home that misses its tick keeps its disk when it paid, loses it when it never paid', async () => {
  const keysB = normalizeSshKeys([KEY.replace(/1$/, '2')])!;
  const idB = homeIdOf(keysB);
  const store = new LeaseStore();
  store.put(homeLease({ id: 'paid', paidIntervals: 1 }));
  store.put(homeLease({
    id: 'unpaid', job: homeJob(keysB), homeId: idB, state: 'awaiting_first_tick', paidIntervals: 0,
    paidThrough: undefined, startedAt: undefined,
  }));
  const homes = homeStore({ homeId: HOME_ID }, { homeId: idB });
  const retired: string[] = [];
  const removed: string[] = [];
  const { r, stops } = fakeRunner({
    retireHome: async (id) => void retired.push(id),
    removeHome: async (id) => void removed.push(id),
  });
  const now = T0 + 90_001 + 30_000;
  await windowTick({ store, runner: r, homes, now: () => now });
  assert.deepEqual(stops.sort(), ['paid', 'unpaid']);
  assert.equal(store.get('paid')!.closedReason, 'missed_tick');
  assert.equal(store.get('unpaid')!.closedReason, 'missed_tick');
  assert.ok(retired.includes(HOME_ID));
  assert.deepEqual(removed, [idB]);
  assert.deepEqual(homes.get(HOME_ID), { homeId: HOME_ID, port: 22000, createdAt: T0, paidOnce: true, lastClosedAt: now });
  assert.equal(homes.get(idB), undefined);
});

test('closing a home leaves its disk and onion alone while another live lease holds the same home', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'old', paidIntervals: 0, state: 'awaiting_first_tick', paidThrough: undefined, startedAt: undefined }));
  store.put(homeLease({ id: 'live', paidThrough: T0 + 10 * 60_000 }));
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true });
  const calls: string[] = [];
  const { r } = fakeRunner({
    retireHome: async (id) => void calls.push(`retire ${id}`),
    removeHome: async (id) => void calls.push(`remove ${id}`),
  });
  await windowTick({ store, runner: r, homes, now: () => T0 + 90_001 });
  assert.equal(store.get('old')!.closedReason, 'missed_tick');
  assert.deepEqual(calls, []);
  assert.equal(homes.get(HOME_ID)!.lastClosedAt, undefined);
});

test('an anon error on close is logged and the tick goes on to the next lease', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h' }));
  store.put(lease({ id: 'job', paidThrough: T0 + 30_000, bootedAt: T0 }));
  const homes = homeStore({ homeId: HOME_ID });
  const logs: string[] = [];
  const { r, stops } = fakeRunner({ retireHome: async () => { throw new Error('no_pid'); } });
  await windowTick({ store, runner: r, homes, now: () => T0 + 30_000 + GRACE_MS + 1, log: (m: string) => void logs.push(m) });
  assert.deepEqual(stops.sort(), ['h', 'job']);
  assert.equal(store.get('job')!.closedReason, 'missed_tick');
  assert.ok(logs.some((m) => /no_pid/.test(m)));
  assert.equal(homes.get(HOME_ID)!.paidOnce, true, 'the record is kept even when anon failed');
});

test('reconcile re-creates a paid home whose container is gone and counts the restart', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h' }));
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true });
  const calls: string[] = [];
  const { r, stops } = fakeRunner({
    alive: async () => false,
    create: async (id, job) => void calls.push(`create ${id} ${job.image}`),
    start: async (id) => void calls.push(`start ${id}`),
    publishHome: async (id) => void calls.push(`publish ${id}`),
  });
  await reconcile({ store, runner: r, homes, now: () => T0 + 1000 });
  assert.deepEqual(calls, ['create h charter-home', 'start h', `publish ${HOME_ID}`]);
  assert.deepEqual(stops, []);
  assert.equal(store.get('h')!.state, 'running');
  assert.equal(store.get('h')!.restarts, 1);
});

test('reconcile closes a home it cannot re-create as host_restart, keeping a paid disk', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h' }));
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true });
  const removed: string[] = [];
  const { r, stops } = fakeRunner({
    alive: async () => false,
    start: async () => { throw new RunnerError('docker_failed', 'boom'); },
    removeHome: async (id) => void removed.push(id),
  });
  await reconcile({ store, runner: r, homes, now: () => T0 + 1000, log: () => undefined });
  assert.equal(store.get('h')!.closedReason, 'host_restart');
  assert.deepEqual(stops, ['h']);
  assert.deepEqual(removed, []);
  assert.equal(homes.get(HOME_ID)!.lastClosedAt, T0 + 1000);
});

test('reconcile closes a home whose paid time ran out during the outage without re-creating it', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h' }));
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true });
  let creates = 0;
  const { r, stops } = fakeRunner({ alive: async () => false, create: async () => void creates++ });
  const now = T0 + 30_000 + GRACE_MS + 1;
  await reconcile({ store, runner: r, homes, now: () => now });
  assert.equal(store.get('h')!.state, 'closed');
  assert.equal(store.get('h')!.closedReason, 'missed_tick');
  assert.equal(creates, 0);
  assert.deepEqual(stops, ['h']);
  assert.equal(homes.get(HOME_ID)!.lastClosedAt, now);
});

test('reconcile keeps a home docker already brought back', async () => {
  const store = new LeaseStore();
  const before = homeLease({ id: 'h' });
  store.put(before);
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true });
  const calls: string[] = [];
  const note = (name: string) => async () => void calls.push(name);
  const { r, stops } = fakeRunner({
    alive: async () => true, create: note('create'), start: note('start'), publishHome: note('publish'),
    retireHome: note('retire'), removeHome: note('remove'),
  });
  await reconcile({ store, runner: r, homes, now: () => T0 + 1000 });
  assert.deepEqual(calls, []);
  assert.deepEqual(stops, []);
  assert.deepEqual(store.get('h'), before);
});

test('reconcile closes a home still waiting on its first tick as a job is', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h', state: 'awaiting_first_tick', paidIntervals: 0, paidThrough: undefined, startedAt: undefined }));
  const homes = homeStore({ homeId: HOME_ID });
  const removed: string[] = [];
  let creates = 0;
  const { r, stops } = fakeRunner({
    alive: async () => false, create: async () => void creates++, removeHome: async (id) => void removed.push(id),
  });
  await reconcile({ store, runner: r, homes, now: () => T0 + 1000 });
  assert.equal(store.get('h')!.closedReason, 'host_restart');
  assert.equal(creates, 0);
  assert.deepEqual(stops, ['h']);
  assert.deepEqual(removed, [HOME_ID]);
  assert.equal(homes.get(HOME_ID), undefined);
});

test('homeSweep removes what sweepDue names and nothing live', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'live', homeId: 'live' }));
  const now = T0 + HOME_RETENTION_MS + 1;
  const homes = homeStore(
    { homeId: 'due', paidOnce: true, lastClosedAt: T0 },
    { homeId: 'live', paidOnce: false },
    { homeId: 'fresh', paidOnce: true, lastClosedAt: now - 1000 },
  );
  const removed: string[] = [];
  const { r } = fakeRunner({ removeHome: async (id) => void removed.push(id) });
  const ids = await homeSweep({ store, runner: r, homes, now: () => now });
  assert.deepEqual(ids, ['due']);
  assert.deepEqual(removed, ['due']);
  assert.deepEqual(homes.all().map((h) => h.homeId).sort(), ['fresh', 'live']);
});

test('homeSweep logs a failed removal, keeps the record, and returns only what it removed', async () => {
  const store = new LeaseStore();
  const homes = homeStore({ homeId: 'a' }, { homeId: 'b' });
  const logs: string[] = [];
  const { r } = fakeRunner({ removeHome: async (id) => { if (id === 'a') throw new Error('no_pid'); } });
  const ids = await homeSweep({ store, runner: r, homes, now: () => T0, log: (m: string) => void logs.push(m) });
  assert.deepEqual(ids, ['b']);
  assert.ok(homes.get('a'));
  assert.ok(logs.some((m) => /no_pid/.test(m)));
});

test('a returning home that paid before keeps its disk when its new lease never pays', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'back', state: 'awaiting_first_tick', paidIntervals: 0, paidThrough: undefined, startedAt: undefined }));
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true, lastClosedAt: T0 - 1000 });
  const removed: string[] = [];
  const { r } = fakeRunner({ removeHome: async (id) => void removed.push(id) });
  await windowTick({ store, runner: r, homes, now: () => T0 + 90_001 });
  assert.equal(store.get('back')!.closedReason, 'missed_tick');
  assert.deepEqual(removed, []);
  assert.equal(homes.get(HOME_ID)!.lastClosedAt, T0 - 1000, 'the paid retention clock is not reset by an unpaid lease');
});

test('a home re-opened while its unpaid lease was being stopped keeps its disk and record', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'old', state: 'awaiting_first_tick', paidIntervals: 0, paidThrough: undefined, startedAt: undefined }));
  const homes = homeStore({ homeId: HOME_ID });
  const calls: string[] = [];
  const { r } = fakeRunner({
    // The server sees the old lease closed and opens a new one before stop returns.
    stop: async () => void store.put(homeLease({ id: 'new', state: 'booting', paidIntervals: 0, createdAt: T0 + 90_001 })),
    retireHome: async (id) => void calls.push(`retire ${id}`),
    removeHome: async (id) => void calls.push(`remove ${id}`),
  });
  await windowTick({ store, runner: r, homes, now: () => T0 + 90_001 });
  assert.equal(store.get('old')!.closedReason, 'missed_tick');
  assert.deepEqual(calls, []);
  assert.ok(homes.get(HOME_ID));
});

test('a home re-opened while removeHome runs keeps its record in the loop\'s store', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'old', state: 'awaiting_first_tick', paidIntervals: 0, paidThrough: undefined, startedAt: undefined }));
  const homes = homeStore({ homeId: HOME_ID });
  const logs: string[] = [];
  const { r } = fakeRunner({
    removeHome: async () => void store.put(homeLease({ id: 'new', state: 'booting', paidIntervals: 0 })),
  });
  await windowTick({ store, runner: r, homes, now: () => T0 + 90_001, log: (m: string) => void logs.push(m) });
  assert.ok(homes.get(HOME_ID));
  assert.ok(logs.some((m) => /re-opened/.test(m)));
});

test('an unpaid home close lets removeHome retire the onion: no separate retire', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'u', state: 'awaiting_first_tick', paidIntervals: 0, paidThrough: undefined, startedAt: undefined }));
  const homes = homeStore({ homeId: HOME_ID });
  const calls: string[] = [];
  const { r } = fakeRunner({
    retireHome: async (id) => void calls.push(`retire ${id}`),
    removeHome: async (id) => void calls.push(`remove ${id}`),
  });
  await windowTick({ store, runner: r, homes, now: () => T0 + 90_001 });
  assert.deepEqual(calls, [`remove ${HOME_ID}`]);
});

test('reconcile closes a booting home whose container is gone as host_restart', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h', state: 'booting', paidIntervals: 0, paidThrough: undefined, startedAt: undefined, bootedAt: undefined }));
  const homes = homeStore({ homeId: HOME_ID });
  let creates = 0;
  const { r, stops } = fakeRunner({ alive: async () => false, create: async () => void creates++ });
  await reconcile({ store, runner: r, homes, now: () => T0 + 1000 });
  assert.equal(store.get('h')!.closedReason, 'host_restart');
  assert.equal(creates, 0);
  assert.deepEqual(stops, ['h']);
  assert.equal(homes.get(HOME_ID), undefined);
});

test('reconcile closes a home whose re-create fails as host_restart without starting it', async () => {
  const store = new LeaseStore();
  store.put(homeLease({ id: 'h' }));
  const homes = homeStore({ homeId: HOME_ID, paidOnce: true });
  let starts = 0;
  const { r, stops } = fakeRunner({
    alive: async () => false,
    create: async () => { throw new RunnerError('docker_failed', 'no image'); },
    start: async () => void starts++,
  });
  await reconcile({ store, runner: r, homes, now: () => T0 + 1000, log: () => undefined });
  assert.equal(store.get('h')!.closedReason, 'host_restart');
  assert.equal(starts, 0);
  assert.deepEqual(stops, ['h']);
  assert.equal(homes.get(HOME_ID)!.lastClosedAt, T0 + 1000);
});
