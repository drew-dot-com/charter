import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lease, Offer } from '../types.js';
import { OFFER_KIND } from '../offer.js';
import { RunnerError, type Runner } from './runner.js';
import { BOOT_TIMEOUT_MS, landAll, offerTick, reconcile, windowTick } from './loop.js';
import { LeaseStore } from './store.js';

const T0 = 1_000_000;
const JOB = { image: 'charter-job-fetch', args: {} };
const OFFER: Offer = {
  id: 'o1', hostPubkey: '', ilpBase: 'g.test', sealKey: 'http://x.anyone/ilp', cpu: 1, memoryMiB: 1024,
  intervalSeconds: 30, tickPrice: 5000n, openPrice: 1000n, statusPrice: 100n, images: ['charter-job-fetch'],
  hiddenHost: true, hiddenEgress: false, expiresAt: 0,
};

function lease(over: Partial<Lease> & { id: string }): Lease {
  return { offerId: 'o1', job: JOB, state: 'running', createdAt: T0, paidIntervals: 1, ...over };
}

function fakeRunner(over: Partial<Runner> = {}) {
  const stops: string[] = [];
  const r: Runner = {
    start: async () => undefined,
    exited: () => new Promise<number>(() => undefined),
    stop: async (id) => void stops.push(id),
    output: async () => Buffer.alloc(0),
    alive: async () => true,
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

test('windowTick closes a lease that never sent its first tick', async () => {
  const store = new LeaseStore();
  store.put(lease({ id: 'a', state: 'awaiting_first_tick', paidIntervals: 0, bootedAt: T0 }));
  const { r, stops } = fakeRunner();
  await windowTick({ store, runner: r, now: () => T0 + 10_001 });
  assert.equal(store.get('a')!.closedReason, 'missed_tick');
  assert.deepEqual(stops, ['a']);
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
  await reconcile({ store, runner: r, now: () => T0 });
  assert.equal(store.get('gone')!.state, 'closed');
  assert.equal(store.get('gone')!.closedReason, 'host_restart');
  assert.equal(store.get('boot')!.closedReason, 'host_restart');
  assert.equal(store.get('wait')!.closedReason, 'host_restart');
  assert.equal(store.get('alive')!.state, 'running');
  assert.equal(store.get('fin')!.state, 'done');
  assert.ok(!asked.includes('fin'));
});

test('offerTick publishes kind 31390 expiring 30 minutes ahead', async () => {
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
  assert.deepEqual(ev.tags.find((t) => t[0] === 'expiration'), ['expiration', String(Math.floor((now + 30 * 60_000) / 1000))]);
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
