import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { homeIdOf, homeJob, normalizeSshKeys } from '../jobs.js';
import { onJobExit } from '../lease.js';
import type { JobSpec, Offer } from '../types.js';
import { RunnerError, type Runner } from './runner.js';
import { hostApps, OUTPUT_PART_BYTES } from './server.js';
import { LeaseStore } from './store.js';
import { HomeStore } from './homes.js';

const OFFER: Offer = {
  id: 'o1', hostPubkey: '', ilpBase: 'g.test', sealKey: '0x04' + 'ab'.repeat(64), sealUrl: 'http://x.anyone/ilp', cpu: 1,
  memoryMiB: 1024, intervalSeconds: 30, firstTickGraceSeconds: 90, tickPrice: 5000n, openPrice: 1000n, statusPrice: 100n, images: ['charter-job-fetch'],
  hiddenHost: true, hiddenEgress: false, expiresAt: 0,
};
const JOB: JobSpec = { image: 'charter-job-fetch', args: { URLS: 'https://example.com' } };
const T0 = 1_000_000;

function fakeRunner(over: Partial<Runner> = {}) {
  const calls: string[] = [];
  const r: Runner = {
    create: async (id) => void calls.push(`create ${id}`),
    start: async (id) => void calls.push(`start ${id}`),
    exited: async () => 0,
    stop: async (id) => void calls.push(`stop ${id}`),
    output: async () => Buffer.alloc(0),
    alive: async () => true,
    ready: async () => true,
    ensureHome: async () => ({ homeId: '', port: 0, createdAt: 0, paidOnce: false }),
    publishHome: async () => undefined,
    retireHome: async () => undefined,
    homeAccess: async () => null,
    removeHome: async () => undefined,
    writePaidThrough: async () => undefined,
    ...over,
  };
  return { r, calls };
}

async function setup(over: Partial<Runner> = {}, maxLeases?: number, maxHomes?: number, homes?: HomeStore, log: (m: string) => void = () => undefined) {
  const store = new LeaseStore();
  const { r, calls } = fakeRunner(over);
  const apps = hostApps({
    store, runner: r, offer: OFFER, now: () => T0, log,
    ...(homes ? { homes } : {}),
    ...(maxLeases === undefined ? {} : { maxLeases }),
    ...(maxHomes === undefined ? {} : { maxHomes }),
  });
  const servers: Array<import('node:http').Server> = [];
  const base = async (app: Express) => {
    const s = app.listen(0, '127.0.0.1');
    servers.push(s);
    await new Promise((res) => s.once('listening', res));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const urls = { open: await base(apps.open), tick: await base(apps.tick), status: await base(apps.status) };
  const post = async (url: string, path: string, body: unknown) => {
    const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const get = async (url: string, path: string) => {
    const res = await fetch(url + path);
    return { status: res.status, body: (await res.json()) as any };
  };
  const done = () => servers.forEach((s) => s.close());
  return { store, calls, urls, post, get, done };
}

async function opened(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const r = await t.post(t.urls.open, '/open', { job: JOB });
  return r.body.leaseId as string;
}

test('F-C3: POST /open creates the container without starting it and answers awaiting_first_tick with a 32 hex lease id', async () => {
  const t = await setup();
  try {
    const r = await t.post(t.urls.open, '/open', { job: JOB });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'awaiting_first_tick');
    assert.match(r.body.leaseId, /^[0-9a-f]{32}$/);
    const lease = t.store.get(r.body.leaseId)!;
    assert.equal(lease.state, 'awaiting_first_tick');
    assert.equal(lease.bootedAt, T0);
    assert.equal(lease.startedAt, undefined);
    assert.deepEqual(t.calls, [`create ${r.body.leaseId}`], 'no job work runs before interval 0 is paid');
  } finally {
    t.done();
  }
});

test('POST /open answers 200 closed/boot_failed when the runner rejects', async () => {
  const t = await setup({ create: async () => { throw new RunnerError('boot_failed', 'no docker'); } });
  try {
    const r = await t.post(t.urls.open, '/open', { job: JOB });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'closed');
    assert.equal(r.body.closedReason, 'boot_failed');
    assert.equal(r.body.error, 'boot_failed');
    assert.equal(t.store.get(r.body.leaseId)!.state, 'closed');
  } finally {
    t.done();
  }
});

test('POST /open reports a runner refusal by code, and does not stop a container that never existed', async () => {
  const t = await setup({ create: async () => { throw new RunnerError('image_not_allowed', 'evil'); } });
  try {
    const r = await t.post(t.urls.open, '/open', { job: { image: 'evil', args: {} } });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'closed');
    assert.equal(r.body.error, 'image_not_allowed');
    assert.deepEqual(t.calls, []);
  } finally {
    t.done();
  }
});

test('F-I2: past CHARTER_MAX_LEASES live leases an open answers 200 closed busy before docker create', async () => {
  const t = await setup({}, 1);
  try {
    const first = await opened(t);
    const r = await t.post(t.urls.open, '/open', { job: JOB });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'closed');
    assert.equal(r.body.closedReason, 'busy');
    assert.match(r.body.leaseId, /^[0-9a-f]{32}$/);
    assert.equal(t.store.get(r.body.leaseId)!.closedReason, 'busy');
    assert.deepEqual(t.calls, [`create ${first}`], 'no container for the refused lease');
    // A running lease still counts; a done or closed one does not.
    await t.post(t.urls.tick, '/tick', { leaseId: first, index: 0 });
    assert.equal((await t.post(t.urls.open, '/open', { job: JOB })).body.closedReason, 'busy');
    t.store.put(onJobExit(t.store.get(first)!, 0));
    const again = await t.post(t.urls.open, '/open', { job: JOB });
    assert.equal(again.body.state, 'awaiting_first_tick');
  } finally {
    t.done();
  }
});

test('F-I2: the default cap is one live lease', async () => {
  const t = await setup();
  try {
    await opened(t);
    assert.equal((await t.post(t.urls.open, '/open', { job: JOB })).body.closedReason, 'busy');
  } finally {
    t.done();
  }
});

test('POST /open rejects a malformed job with 400 before calling the runner', async () => {
  const t = await setup();
  try {
    for (const body of [
      {},
      { job: 'x' },
      { job: { image: 5, args: {} } },
      { job: { image: 'a' } },
      { job: { image: 'a', args: [] } },
      { job: { image: 'a', args: { URLS: 1 } } },
    ]) {
      const r = await t.post(t.urls.open, '/open', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'bad_request');
    }
    const bad = await fetch(t.urls.open + '/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.store.all(), []);
  } finally {
    t.done();
  }
});

test('POST /tick: index 0 pays one interval, a repeat is a duplicate, index 3 is out of order', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    const first = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { paidIntervals: 1, paidThrough: T0 + 30_000, duplicate: false });
    const again = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.paidIntervals, 1);
    const skip = await t.post(t.urls.tick, '/tick', { leaseId, index: 3 });
    assert.equal(skip.status, 409);
    assert.equal(skip.body.error, 'out_of_order');
    assert.equal(t.store.get(leaseId)!.paidIntervals, 1);
  } finally {
    t.done();
  }
});

test('F-C3: the paid tick 0 starts the container, once; later and duplicate ticks never start it again', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    assert.deepEqual(t.calls, [`create ${leaseId}`]);
    assert.equal((await t.post(t.urls.tick, '/tick', { leaseId, index: 0 })).status, 200);
    assert.deepEqual(t.calls, [`create ${leaseId}`, `start ${leaseId}`]);
    assert.equal(t.store.get(leaseId)!.startedAt, T0);
    assert.equal((await t.post(t.urls.tick, '/tick', { leaseId, index: 0 })).body.duplicate, true);
    assert.equal((await t.post(t.urls.tick, '/tick', { leaseId, index: 1 })).status, 200);
    assert.deepEqual(t.calls, [`create ${leaseId}`, `start ${leaseId}`]);
  } finally {
    t.done();
  }
});

test('F-C3: a container that fails to start on tick 0 closes the lease boot_failed, is removed, and the tick answers 409 not_running', async () => {
  const t = await setup({ start: async () => { throw new RunnerError('boot_failed', 'start'); } });
  try {
    const leaseId = await opened(t);
    const r = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_running');
    const l = t.store.get(leaseId)!;
    assert.equal(l.state, 'closed');
    assert.equal(l.closedReason, 'boot_failed');
    assert.ok(t.calls.includes(`stop ${leaseId}`));
  } finally {
    t.done();
  }
});

test('POST /tick: unknown lease 404, bad ids and indexes 400, done 409 lease_done, closed 409 not_running', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    assert.equal((await t.post(t.urls.tick, '/tick', { leaseId: 'a'.repeat(32), index: 0 })).status, 404);
    for (const body of [
      { leaseId, index: -1 },
      { leaseId, index: 1.5 },
      { leaseId, index: '0' },
      { leaseId, index: 2 ** 60 },
      { leaseId, index: null },
      { leaseId: leaseId.toUpperCase(), index: 0 },
      { leaseId: 'short', index: 0 },
      { index: 0 },
    ]) {
      const r = await t.post(t.urls.tick, '/tick', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'bad_request');
    }
    assert.equal(t.store.get(leaseId)!.paidIntervals, 0);

    await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    t.store.put(onJobExit(t.store.get(leaseId)!, 1));
    const done = await t.post(t.urls.tick, '/tick', { leaseId, index: 1 });
    assert.equal(done.status, 409);
    assert.equal(done.body.error, 'lease_done');

    const other = await opened(t);
    t.store.put({ ...t.store.get(other)!, state: 'closed', closedReason: 'missed_tick' });
    const closed = await t.post(t.urls.tick, '/tick', { leaseId: other, index: 0 });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, 'not_running');
  } finally {
    t.done();
  }
});

test('POST /tick on a booting lease is 409 not_running', async () => {
  const t = await setup();
  try {
    const leaseId = 'b'.repeat(32);
    t.store.put({ id: leaseId, offerId: 'o1', job: JOB, state: 'booting', createdAt: T0, paidIntervals: 0 });
    const r = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_running');
  } finally {
    t.done();
  }
});

test('each app answers 404 to the other apps routes and to unknown paths', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    assert.equal((await t.post(t.urls.open, '/tick', { leaseId, index: 0 })).status, 404);
    assert.equal((await t.post(t.urls.tick, '/open', { job: JOB })).status, 404);
    assert.equal((await t.post(t.urls.status, '/open', { job: JOB })).status, 404);
    assert.equal((await t.post(t.urls.status, '/tick', { leaseId, index: 0 })).status, 404);
    assert.equal((await t.get(t.urls.open, '/open')).status, 404);
    assert.equal((await t.get(t.urls.tick, '/tick')).status, 404);
    assert.equal((await t.get(t.urls.open, `/leases/${leaseId}`)).status, 404);
    assert.equal((await t.get(t.urls.tick, '/anything')).status, 404);
    assert.equal(t.store.get(leaseId)!.paidIntervals, 0);
  } finally {
    t.done();
  }
});

test('GET /leases/:id answers the lease, 404 for unknown or malformed ids', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    const r = await t.get(t.urls.status, `/leases/${leaseId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.lease.id, leaseId);
    assert.equal(r.body.lease.state, 'awaiting_first_tick');
    assert.equal((await t.get(t.urls.status, `/leases/${'c'.repeat(32)}`)).status, 404);
    assert.equal((await t.get(t.urls.status, '/leases/..%2Fx')).status, 404);
  } finally {
    t.done();
  }
});

test('GET output/:part slices a 100 KiB result into 3 parts of 48 KiB', async () => {
  const bytes = Buffer.alloc(100 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const t = await setup({ output: async () => bytes });
  try {
    const leaseId = await opened(t);
    await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    t.store.put(onJobExit(t.store.get(leaseId)!, 3));

    const p0 = await t.get(t.urls.status, `/leases/${leaseId}/output/0`);
    assert.equal(p0.status, 200);
    assert.equal(p0.body.part, 0);
    assert.equal(p0.body.parts, 3);
    assert.equal(Buffer.from(p0.body.data, 'base64').length, 49152);
    assert.ok(Buffer.from(p0.body.data, 'base64').equals(bytes.subarray(0, OUTPUT_PART_BYTES)));

    const p2 = await t.get(t.urls.status, `/leases/${leaseId}/output/2`);
    assert.equal(Buffer.from(p2.body.data, 'base64').length, 100 * 1024 - 2 * 49152);

    for (const bad of ['3', '-1', '1.5', 'x', '99999999999999999999']) {
      assert.equal((await t.get(t.urls.status, `/leases/${leaseId}/output/${bad}`)).status, 404, bad);
    }
  } finally {
    t.done();
  }
});

test('GET output is 404 while the lease has no output parts', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    assert.equal((await t.get(t.urls.status, `/leases/${leaseId}/output/0`)).status, 404);
  } finally {
    t.done();
  }
});

test('GET output is 409 unpaid while the lease has no paid tick', async () => {
  const t = await setup({ output: async () => Buffer.from('hi') });
  try {
    const leaseId = await opened(t);
    t.store.put(onJobExit(t.store.get(leaseId)!, 1));
    const r = await t.get(t.urls.status, `/leases/${leaseId}/output/0`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'unpaid');
  } finally {
    t.done();
  }
});

test('F-C3: a done lease answers 409 lease_done to every tick, index 0 included, and records nothing', async () => {
  const t = await setup({ output: async () => Buffer.from('hello') });
  try {
    const leaseId = await opened(t);
    t.store.put(onJobExit(t.store.get(leaseId)!, 1));
    for (const index of [0, 1]) {
      const r = await t.post(t.urls.tick, '/tick', { leaseId, index });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'lease_done');
    }
    assert.equal(t.store.get(leaseId)!.paidIntervals, 0);
    assert.deepEqual(t.calls, [`create ${leaseId}`]);
  } finally {
    t.done();
  }
});

test('request bodies parse as JSON whatever the content-type says', async () => {
  const t = await setup();
  try {
    const leaseId = await opened(t);
    const res = await fetch(t.urls.tick + '/tick', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ leaseId, index: 0 }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).paidIntervals, 1);
  } finally {
    t.done();
  }
});

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 edison@air';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ2 other@box';
const HOME = homeJob(normalizeSshKeys([KEY])!);
const HOME_ID = homeIdOf(normalizeSshKeys([KEY])!);

/** Records the home calls in the same list as create/start/stop, so their order shows. */
function homeRunner(calls: string[], over: Partial<Runner> = {}): Partial<Runner> {
  return {
    ensureHome: async (homeId) => {
      calls.push(`ensureHome ${homeId}`);
      return { homeId, port: 2222, createdAt: T0, paidOnce: false };
    },
    publishHome: async (homeId) => void calls.push(`publishHome ${homeId}`),
    writePaidThrough: async (homeId, ms) => void calls.push(`writePaidThrough ${homeId} ${ms}`),
    ...over,
  };
}

test('open for a home refuses bad keys, a full house and a home already in use', async () => {
  const calls: string[] = [];
  const t = await setup(homeRunner(calls), 5, 1);
  try {
    for (const args of [{}, { SSH_KEYS: '' }, { SSH_KEYS: 'ssh-dss AAAA' }]) {
      const r = await t.post(t.urls.open, '/open', { job: { image: 'charter-home', args } });
      assert.equal(r.status, 400, JSON.stringify(args));
      assert.equal(r.body.error, 'bad_request');
    }
    assert.deepEqual(t.store.all(), []);

    const first = await t.post(t.urls.open, '/open', { job: HOME });
    assert.equal(first.body.state, 'awaiting_first_tick');
    const full = await t.post(t.urls.open, '/open', { job: homeJob(normalizeSshKeys([KEY2])!) });
    assert.deepEqual(full.body, { leaseId: full.body.leaseId, state: 'closed', closedReason: 'busy' });
    assert.equal(t.store.get(full.body.leaseId)!.closedReason, 'busy');
    // The same keys while the only slot is full: the slot is not the reason.
    const again = await t.post(t.urls.open, '/open', { job: HOME });
    assert.deepEqual(again.body, { leaseId: again.body.leaseId, state: 'closed', closedReason: 'home_in_use' });
  } finally {
    t.done();
  }

  const calls2: string[] = [];
  const u = await setup(homeRunner(calls2), 5, 2);
  try {
    const first = await u.post(u.urls.open, '/open', { job: HOME });
    calls2.length = 0;
    const same = await u.post(u.urls.open, '/open', { job: HOME });
    assert.deepEqual(same.body, { leaseId: same.body.leaseId, state: 'closed', closedReason: 'home_in_use' });
    assert.notEqual(same.body.leaseId, first.body.leaseId);
    assert.equal(u.store.get(same.body.leaseId)!.closedReason, 'home_in_use');
    assert.deepEqual(calls2, [], 'no disk and no container for a home in use');
  } finally {
    u.done();
  }
});

test('open for a home makes the disk before the container, and a no-disk refusal is a boot failure', async () => {
  const calls: string[] = [];
  const t = await setup(homeRunner(calls, { create: async (id) => void calls.push(`create ${id}`) }), 5, 1);
  try {
    const r = await t.post(t.urls.open, '/open', { job: HOME });
    assert.equal(r.body.state, 'awaiting_first_tick');
    assert.deepEqual(calls, [`ensureHome ${HOME_ID}`, `create ${r.body.leaseId}`]);
  } finally {
    t.done();
  }

  const calls2: string[] = [];
  const u = await setup(
    homeRunner(calls2, {
      ensureHome: async () => { throw new RunnerError('boot_failed', 'no disk'); },
      create: async (id) => void calls2.push(`create ${id}`),
    }),
    5, 1,
  );
  try {
    const r = await u.post(u.urls.open, '/open', { job: HOME });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { leaseId: r.body.leaseId, state: 'closed', closedReason: 'boot_failed', error: 'boot_failed' });
    assert.equal(u.store.get(r.body.leaseId)!.closedReason, 'boot_failed');
    assert.ok(!calls2.some((c) => c.startsWith('create')), 'no container without a disk');
  } finally {
    u.done();
  }
});

test('tick 0 on a home starts the box, publishes its onion and writes the paid time; tick 1 writes it again', async () => {
  const calls: string[] = [];
  const t = await setup(homeRunner(calls, { start: async (id) => void calls.push(`start ${id}`) }), 5, 1);
  try {
    const leaseId = (await t.post(t.urls.open, '/open', { job: HOME })).body.leaseId as string;
    calls.length = 0;
    const r0 = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(r0.status, 200);
    assert.deepEqual(calls, [`writePaidThrough ${HOME_ID} ${T0 + 30_000}`, `start ${leaseId}`, `publishHome ${HOME_ID}`]);
    assert.equal((await t.post(t.urls.tick, '/tick', { leaseId, index: 0 })).body.duplicate, true);
    const r1 = await t.post(t.urls.tick, '/tick', { leaseId, index: 1 });
    assert.equal(r1.status, 200);
    assert.equal(calls.filter((c) => c.startsWith('publishHome')).length, 1);
    assert.deepEqual(calls.filter((c) => c.startsWith('writePaidThrough')), [
      `writePaidThrough ${HOME_ID} ${T0 + 30_000}`,
      `writePaidThrough ${HOME_ID} ${T0 + 60_000}`,
    ]);

    // The status call answers the stored lease, home fields included.
    const s = await t.get(t.urls.status, `/leases/${leaseId}`);
    assert.equal(s.body.lease.homeId, HOME_ID);
    assert.equal(s.body.lease.restarts, 0);
    assert.deepEqual(s.body.lease, JSON.parse(JSON.stringify(t.store.get(leaseId))));
  } finally {
    t.done();
  }
});

test('a failed publish or paid-time write on a home tick is logged and the tick still answers 200', async () => {
  const calls: string[] = [];
  const t = await setup(
    homeRunner(calls, {
      publishHome: async () => { throw new Error('tor down'); },
      writePaidThrough: async () => { throw new Error('disk full'); },
    }),
    5, 1,
  );
  try {
    const leaseId = (await t.post(t.urls.open, '/open', { job: HOME })).body.leaseId as string;
    const r = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(r.status, 200);
    assert.equal(t.store.get(leaseId)!.state, 'running');
    assert.equal(t.store.get(leaseId)!.startedAt, T0);
  } finally {
    t.done();
  }
});

test('a home counts inside maxLeases', async () => {
  const calls: string[] = [];
  const t = await setup(homeRunner(calls), 1, 1);
  try {
    assert.equal((await t.post(t.urls.open, '/open', { job: HOME })).body.state, 'awaiting_first_tick');
    const r = await t.post(t.urls.open, '/open', { job: { image: 'charter-job-python', args: { SCRIPT: 'print(1)' } } });
    assert.equal(r.body.state, 'closed');
    assert.equal(r.body.closedReason, 'busy');
  } finally {
    t.done();
  }
});

test('a home whose container fails to start on tick 0 is closed boot_failed and released: onion retired, record marked paid', async () => {
  const calls: string[] = [];
  const homes = new HomeStore();
  homes.put({ homeId: HOME_ID, port: 2222, createdAt: T0, paidOnce: false });
  const t = await setup(
    homeRunner(calls, {
      create: async (id) => void calls.push(`create ${id}`),
      start: async () => { throw new RunnerError('boot_failed', 'start'); },
      stop: async (id) => void calls.push(`stop ${id}`),
      retireHome: async (id) => void calls.push(`retireHome ${id}`),
      removeHome: async (id) => void calls.push(`removeHome ${id}`),
    }),
    5, 1, homes,
  );
  try {
    const leaseId = (await t.post(t.urls.open, '/open', { job: HOME })).body.leaseId as string;
    const r = await t.post(t.urls.tick, '/tick', { leaseId, index: 0 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'not_running');
    const l = t.store.get(leaseId)!;
    assert.equal(l.state, 'closed');
    assert.equal(l.closedReason, 'boot_failed');
    assert.equal(l.paidIntervals, 1);
    assert.ok(calls.includes(`stop ${leaseId}`));
    assert.ok(calls.includes(`retireHome ${HOME_ID}`));
    assert.ok(!calls.includes(`removeHome ${HOME_ID}`), 'it paid a tick: the disk is kept');
    assert.deepEqual(homes.get(HOME_ID), { homeId: HOME_ID, port: 2222, createdAt: T0, paidOnce: true, lastClosedAt: T0 });
  } finally {
    t.done();
  }
});

test('a boot failure is logged with its detail while the renter gets only the code', async () => {
  const lines: string[] = [];
  const t = await setup(
    { ensureHome: async () => { throw new RunnerError('boot_failed', 'no disk'); } },
    5, 1, undefined, (m) => void lines.push(m),
  );
  try {
    const r = await t.post(t.urls.open, '/open', { job: HOME });
    assert.equal(r.body.closedReason, 'boot_failed');
    assert.equal(r.body.error, 'boot_failed');
    assert.ok(lines.some((l) => l.includes('boot failed') && l.includes('no disk')), lines.join('|'));
  } finally {
    t.done();
  }
});
