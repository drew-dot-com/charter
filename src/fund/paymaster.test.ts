import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOWED_MOVES, type GrantState } from '../door/grants.js';
import type { Answer, DoorClient } from './door-client.js';
import type { PitchIn, Verdict } from './judge.js';
import { commitmentOk, cycle, dayCapOk, grantEligible, HOME_USED_REASON, makeJudgeOne, MAX_JUDGE_TRIES, tickDue } from './paymaster.js';
import { writeFileSync } from 'node:fs';
import { emptyState, loadState, saveState, type FundState } from './state.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 20, 0, 10);
const hex = () => randomBytes(16).toString('hex');
const KEYS = ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly0000000000000000000000 a@b'];
const ADDRESS = '0x2222222222222222222222222222222222222222';

interface FakeLease { state: string; paidIntervals: number; paidThrough?: number; closedReason?: string; keys: string; offerId?: string }

function offer(o: Record<string, unknown> = {}) {
  return {
    offerId: 'hostpub:offer1',
    cpu: 1,
    memoryMiB: 1024,
    intervalSeconds: 3600,
    tickPrice: '7000',
    images: ['charter-home', 'charter-hermes'],
    hiddenHost: true,
    hiddenEgress: true,
    expiresAt: T0 + 365 * DAY,
    home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 1 },
    record: { probesPassed: 3, leasesFinished: 5, successRate: 1, new: false },
    ...o,
  };
}

/** The door as the fund sees it: grants, offers and leases in memory, answering as server.ts does. */
class FakeDoor implements DoorClient {
  payTo = '0x1111111111111111111111111111111111111111';
  grants = new Map<string, Record<string, any>>();
  offers: any[] = [offer()];
  leases = new Map<string, FakeLease>();
  doorStopped = new Set<string>();
  pays: Array<{ path: string; json: any; status: number }> = [];
  gets: string[] = [];
  posts: Array<{ id: string; json: any }> = [];
  publicBody: any;
  onPay?: (path: string, json: any) => Answer | undefined;
  onGet?: (path: string) => Answer | undefined;

  constructor(readonly clock: { t: number }) {}

  grant(over: Record<string, unknown> = {}): string {
    const grantId = (over.grantId as string) ?? hex();
    this.grants.set(grantId, {
      grantId,
      state: 'approved_waiting',
      name: 'agent',
      image: 'charter-home',
      sshKeys: KEYS,
      homeId: 'home-' + grantId.slice(0, 6),
      pitch: 'run a bot',
      createdAt: this.clock.t,
      decidedAt: this.clock.t,
      paidHours: 0,
      renewedByGrantee: false,
      updatedAt: this.clock.t,
      ...over,
    });
    return grantId;
  }

  g(id: string) {
    return this.grants.get(id)!;
  }

  lease(id: string): FakeLease {
    return this.leases.get(id)!;
  }

  /** The grantee pays the next tick itself. */
  granteeTick(leaseId: string): void {
    const l = this.lease(leaseId);
    l.paidIntervals++;
    l.paidThrough = (l.paidThrough ?? this.clock.t) + HOUR;
  }

  close(leaseId: string, reason = 'missed_tick'): void {
    const l = this.lease(leaseId);
    l.state = 'closed';
    l.closedReason = reason;
  }

  paid(): Array<{ path: string; json: any; status: number }> {
    return this.pays.filter((p) => p.status === 200);
  }

  async get(path: string): Promise<Answer> {
    this.gets.push(path);
    const o = this.onGet?.(path);
    if (o) return o;
    if (path === '/v1/offers') return { status: 200, body: this.offers };
    const m = /^\/v1\/leases\/([0-9a-f]{32})$/.exec(path);
    if (m && this.leases.has(m[1]!)) {
      const l = this.leases.get(m[1]!)!;
      const { keys: _k, ...lease } = l;
      return { status: 200, body: { lease: { id: m[1], ...lease }, stopped: this.doorStopped.has(m[1]!), offer: this.offers[0] ?? offer() } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  async pay(path: string, json: any): Promise<Answer> {
    let a: Answer | undefined;
    try {
      a = this.onPay?.(path, json);
    } catch (e) {
      this.pays.push({ path, json, status: 0 }); // sent, answer lost
      throw e;
    }
    if (!a) a = this.answerPay(path, json);
    this.pays.push({ path, json, status: a.status });
    return a;
  }

  private answerPay(path: string, json: any): Answer {
    if (path === '/v1/rent') {
      const o = this.offers.find((x) => x.offerId === json.offerId);
      if (!o) return { status: 404, body: { error: 'not_found' } };
      const keys = json.home.sshKeys.join('\n');
      // One host, one disk per key set: home_in_use is that host's own check, as in host/server.ts.
      if ([...this.leases.values()].some((l) => l.keys === keys && l.state === 'running' && (l.offerId ?? 'hostpub:offer1') === json.offerId)) {
        return { status: 502, body: { error: 'home_in_use', leaseId: hex(), state: 'closed', closedReason: 'home_in_use' } };
      }
      const leaseId = hex();
      const paidThrough = this.clock.t + o.intervalSeconds * 1000;
      this.leases.set(leaseId, { state: 'running', paidIntervals: 1, paidThrough, keys, offerId: json.offerId });
      return { status: 200, body: { leaseId, state: 'running', paidIntervals: 1, paidThrough, duplicate: false, next: { path: `/v1/leases/${leaseId}/ticks`, index: 1 }, offer: o } };
    }
    const m = /^\/v1\/leases\/([0-9a-f]{32})\/ticks$/.exec(path);
    const l = m ? this.leases.get(m[1]!) : undefined;
    if (!m || !l) return { status: 404, body: { error: 'not_found' } };
    if (this.doorStopped.has(m[1]!)) return { status: 409, body: { error: 'stopped' } };
    if (l.state !== 'running') return { status: 409, body: { error: 'not_running' } };
    if (json.index !== l.paidIntervals) return { status: 409, body: { error: 'out_of_order', expected: l.paidIntervals } };
    l.paidIntervals++;
    l.paidThrough = (l.paidThrough ?? this.clock.t) + HOUR;
    return { status: 200, body: { paidIntervals: l.paidIntervals, paidThrough: l.paidThrough, duplicate: false } };
  }

  async fund(method: 'GET' | 'POST' | 'PUT', path: string, json?: any): Promise<Answer> {
    if (method === 'GET' && path === '/v1/fund/queue') {
      const q = [...this.grants.values()].filter((g) => g.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
      const live = [...this.grants.values()].filter((g) => g.state === 'active' || g.state === 'approved_waiting').length;
      return { status: 200, body: { grant: q ? { grantId: q.grantId, name: q.name, link: q.link ?? null, image: q.image, pitch: q.pitch, homeId: q.homeId } : null, live } };
    }
    const list = /^\/v1\/fund\/grants(?:\?state=([a-z_]+))?$/.exec(path);
    if (method === 'GET' && list) {
      return { status: 200, body: { grants: [...this.grants.values()].filter((g) => !list[1] || g.state === list[1]) } };
    }
    const one = /^\/v1\/fund\/grants\/([^/]+)$/.exec(path);
    if (method === 'POST' && one) {
      const g = this.grants.get(one[1]!);
      if (!g) return { status: 404, body: { error: 'not_found' } };
      this.posts.push({ id: one[1]!, json });
      if (json.state !== undefined && json.state !== g.state && !ALLOWED_MOVES[g.state as GrantState].includes(json.state)) return { status: 409, body: { error: 'bad_move' } };
      Object.assign(g, json);
      return { status: 200, body: g };
    }
    if (method === 'PUT' && path === '/v1/fund/public') {
      this.publicBody = json;
      return { status: 200, body: json };
    }
    return { status: 404, body: { error: 'not_found' } };
  }
}

function rig(o: { balance?: bigint; state?: FundState; save?: () => void } = {}) {
  const clock = { t: T0 };
  const door = new FakeDoor(clock);
  const state = o.state ?? emptyState();
  const problems: Array<{ key: string; msg: string }> = [];
  let judged = 0;
  let saves = 0;
  const deps = {
    door,
    address: ADDRESS,
    balance: async () => o.balance ?? 10_000_000n,
    now: () => clock.t,
    state,
    save: () => {
      saves++;
      o.save?.();
    },
    problem: (key: string, msg: string) => void problems.push({ key, msg }),
    judgeOne: async () => void judged++,
  };
  const run = (over: Partial<typeof deps> = {}) => cycle({ ...deps, ...over });
  return { clock, door, state, problems, run, deps, judged: () => judged, saves: () => saves };
}

/** Opens a grant's home in one cycle and answers its grant and lease ids. */
async function opened(r: ReturnType<typeof rig>, over: Record<string, unknown> = {}): Promise<{ id: string; leaseId: string }> {
  const id = r.door.grant(over);
  await r.run();
  const leaseId = r.door.g(id).leaseId as string;
  assert.equal(r.door.g(id).state, 'active');
  return { id, leaseId };
}

// ---- pure checks ----

test('commitmentOk at the exact boundary', () => {
  const tick = 7000n;
  const live = [{ hoursLeft: 100 }, { hoursLeft: 20 }];
  const need = ((120n + 720n) * tick * 11n) / 10n;
  assert.equal(need * 10n, (120n + 720n) * tick * 11n, 'the boundary is a whole number of micro');
  assert.equal(commitmentOk(need, live, tick), true);
  assert.equal(commitmentOk(need - 1n, live, tick), false);
  assert.equal(commitmentOk(((720n * tick * 11n) / 10n), [], tick), true);
  assert.equal(commitmentOk(((720n * tick * 11n) / 10n) - 1n, [], tick), false);
  assert.equal(commitmentOk(10n ** 12n, [], 0n), false, 'no price, no grant');
  assert.equal(commitmentOk(10n ** 12n, [{ hoursLeft: Number.NaN }], tick), true, 'a broken count is read as a full month');
  assert.equal(commitmentOk(((1440n * tick * 11n) / 10n) - 1n, [{ hoursLeft: Number.NaN }], tick), false);
});

test('dayCapOk', () => {
  const tick = 7000n;
  // one live grant: 24 x 7000 x 1.5 = 252000 a day, 36 ticks
  assert.equal(dayCapOk(245_000n, 1, tick, tick), true);
  assert.equal(dayCapOk(245_001n, 1, tick, tick), false);
  assert.equal(dayCapOk(0n, 2, tick, 504_000n), true);
  assert.equal(dayCapOk(0n, 2, tick, 504_001n), false);
  assert.equal(dayCapOk(0n, 0, tick, tick), false, 'no live grant, no spend');
  assert.equal(dayCapOk(0n, 1, 0n, 0n), false, 'no price, no spend');
});

test('tickDue half an interval early', () => {
  const lease = { state: 'running', paidThrough: T0 + HOUR };
  assert.equal(tickDue(lease, 3600, T0 + HOUR / 2), true);
  assert.equal(tickDue(lease, 3600, T0 + HOUR / 2 - 1), false);
  assert.equal(tickDue(lease, 3600, T0 + 2 * HOUR), true);
  assert.equal(tickDue({ state: 'running' }, 3600, T0 + 10 * HOUR), false, 'no paidThrough, no tick');
  assert.equal(tickDue({ state: 'closed', paidThrough: T0 }, 3600, T0 + HOUR), false);
  assert.equal(tickDue({ state: 'awaiting_first_tick', paidThrough: T0 }, 3600, T0 + HOUR), false);
  assert.equal(tickDue(lease, 0, T0 + HOUR), false, 'no interval, no tick');
});

// ---- opening ----

test('opens only when home.free > 0', async () => {
  const r = rig();
  r.door.offers = [offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 0 } })];
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.door.g(id).state, 'approved_waiting');

  r.door.offers = [offer({ images: ['charter-hermes'] }), offer({ offerId: 'hostpub:offer2' })];
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.pays.length, 1);
  assert.deepEqual(r.door.pays[0]!.json, { offerId: 'hostpub:offer2', home: { sshKeys: KEYS, image: 'charter-home' } });
  const g = r.door.g(id);
  assert.equal(g.state, 'active');
  assert.match(g.leaseId, /^[0-9a-f]{32}$/);
  assert.equal(g.paidHours, 1);
  const f = r.state.grants[id]!;
  assert.equal(f.fundTicks, 1);
  assert.equal(f.leaseId, g.leaseId);
  assert.equal(f.reopened, false);
  assert.equal(r.state.spend.micro, '7000');
});

test('the oldest approved grant opens first, one open a cycle', async () => {
  const r = rig();
  const young = r.door.grant({ decidedAt: T0 - 1000 });
  const old = r.door.grant({ decidedAt: T0 - 5000 });
  await r.run();
  assert.equal(r.door.g(old).state, 'active');
  assert.equal(r.door.g(young).state, 'approved_waiting');
  assert.equal(r.door.paid().length, 1);
});

test('a grant waits while the balance cannot cover it', async () => {
  const short = ((720n * 7000n * 11n) / 10n) - 1n;
  const r = rig({ balance: short });
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.door.g(id).state, 'approved_waiting');
  assert.ok(r.problems.some((p) => p.key === 'commitment'));
});

test('the commitment counts hours left on live grants', async () => {
  // Enough for one month and a bit, not for two.
  const r = rig({ balance: ((720n * 7000n * 11n) / 10n) + 100_000n });
  const a = r.door.grant({ decidedAt: T0 - 10 });
  const b = r.door.grant();
  await r.run();
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.g(a).state, 'active');
  assert.equal(r.door.g(b).state, 'approved_waiting');
  assert.equal(r.door.paid().filter((p) => p.path === '/v1/rent').length, 1);
});

test('a first open answered home_in_use ends the grant early and pays nothing', async () => {
  const r = rig();
  r.door.leases.set(hex(), { state: 'running', paidIntervals: 3, paidThrough: T0 + HOUR, keys: KEYS.join('\n') });
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.g(id).state, 'ended_early');
  assert.equal(r.door.paid().length, 0);
  assert.equal(r.state.spend.micro, '0');
  r.clock.t += HOUR * 2;
  await r.run();
  assert.equal(r.door.pays.length, 1, 'never tried again');
});

test('an open refused for another reason backs off and tries again later', async () => {
  const r = rig();
  let refuse = true;
  r.door.onPay = (path) => (refuse && path === '/v1/rent' ? { status: 503, body: { error: 'capacity' } } : undefined);
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.g(id).state, 'approved_waiting');
  assert.ok(r.problems.some((p) => p.key === 'open'));
  refuse = false;
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.pays.length, 1, 'backed off');
  r.clock.t += 5 * 60_000;
  await r.run();
  assert.equal(r.door.g(id).state, 'active');
});

test('approved grants expire after 14 days', async () => {
  const r = rig();
  r.door.offers = [offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 0 } })];
  const id = r.door.grant({ decidedAt: T0 - 14 * DAY - 1 });
  const fresh = r.door.grant({ decidedAt: T0 - 13 * DAY });
  await r.run();
  assert.equal(r.door.g(id).state, 'expired');
  assert.equal(r.door.g(fresh).state, 'approved_waiting');
});

test('no usable tick price on any offer: nothing is spent', async () => {
  for (const tickPrice of ['', 'abc', '0', '10001', '-5', '7000.5']) {
    const r = rig();
    r.door.offers = [offer({ tickPrice })];
    r.door.grant();
    await r.run();
    assert.equal(r.door.pays.length, 0, `tickPrice ${JSON.stringify(tickPrice)}`);
  }
});

test('the door answering offers as { offers } is read too', async () => {
  const r = rig();
  const list = r.door.offers;
  r.door.onGet = (p) => (p === '/v1/offers' ? { status: 200, body: { offers: list } } : undefined);
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.g(id).state, 'active');
});

// ---- unanswered opens ----

const B = 'hostpub:offerB';
const freeOffer = (offerId: string, free: number) => offer({ offerId, home: { diskGiB: 2, retentionDays: 7, slots: 2, free } });

test('a timed-out open is retried on the same offer only', async () => {
  const r = rig();
  r.door.offers = [freeOffer('hostpub:offer1', 1), freeOffer(B, 1)];
  let lose = true;
  r.door.onPay = (path) => {
    if (path === '/v1/rent' && lose) throw new Error('The operation was aborted due to timeout');
    return undefined;
  };
  const id = r.door.grant();
  await r.run();
  assert.deepEqual(r.state.grants[id]!.opening, { offerId: 'hostpub:offer1', at: T0 });
  assert.ok(r.problems.some((p) => p.key === 'open'));
  // offer1 now shows no free slot and offerB does: the retry still goes to offer1 only
  lose = false;
  r.door.offers = [freeOffer(B, 1), freeOffer('hostpub:offer1', 0)];
  r.clock.t += 5 * 60_000;
  await r.run();
  const rents = r.door.pays.filter((p) => p.path === '/v1/rent');
  assert.equal(rents.length, 2);
  assert.ok(rents.every((p) => p.json.offerId === 'hostpub:offer1'), rents.map((p) => p.json.offerId).join(','));
  assert.equal(r.door.g(id).state, 'active');
  assert.equal(r.state.grants[id]!.opening, undefined, 'a 200 clears the marker');
});

test('home_in_use after an unanswered open records open-unknown and does not end the grant', async () => {
  const r = rig();
  r.door.offers = [freeOffer('hostpub:offer1', 1), freeOffer(B, 1)];
  let lose = true;
  r.door.onPay = (path, json) => {
    if (path !== '/v1/rent' || !lose) return undefined;
    // the door opens the home and settles, then the answer is lost
    const l = hex();
    r.door.leases.set(l, { state: 'running', paidIntervals: 1, paidThrough: r.clock.t + HOUR, keys: json.home.sshKeys.join('\n'), offerId: json.offerId });
    throw new Error('socket hang up');
  };
  const id = r.door.grant();
  const other = r.door.grant({ decidedAt: T0 + 1, sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyForTestsOnly000000000000000000000 c@d'] });
  await r.run();
  lose = false;
  r.clock.t += 5 * 60_000;
  await r.run();
  const f = r.state.grants[id]!;
  assert.equal(r.door.g(id).state, 'approved_waiting', 'not ended');
  assert.equal(f.openUnknown, r.clock.t);
  assert.equal(f.opening?.offerId, 'hostpub:offer1', 'the marker is kept');
  assert.ok(r.problems.some((p) => p.key === 'open-unknown' && p.msg.includes(id)));
  const rentsFor = () => r.door.pays.filter((p) => p.path === '/v1/rent' && p.json.home.sshKeys[0] === KEYS[0]);
  assert.equal(rentsFor().length, 2);
  assert.ok(rentsFor().every((p) => p.json.offerId === 'hostpub:offer1'));
  // it neither blocks the next grant nor gets paid, expired or retried later
  r.problems.length = 0;
  for (const step of [5 * 60_000, HOUR, 15 * DAY]) {
    r.clock.t += step;
    await r.run();
  }
  assert.equal(r.door.g(other).state, 'active');
  assert.equal(rentsFor().length, 2, 'nothing more paid for it');
  assert.equal(r.door.g(id).state, 'approved_waiting');
  assert.ok(r.problems.some((p) => p.key === 'open-unknown'), 'still reported each cycle');
  // Drew's stop ends it
  r.state.stopped.push(id);
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.g(id).state, 'stopped');
});

test('a crash after a 200 open (marker saved, leaseId not) does not open a second home on another offer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-state-'));
  const file = join(dir, 'state.json');
  let state = loadState(file);
  let crashed = false;
  const r = rig({
    state,
    save: () => {
      if (crashed) throw new Error('process killed');
      saveState(file, state);
    },
  });
  r.door.offers = [freeOffer('hostpub:offer1', 1), freeOffer(B, 1)];
  r.door.onPay = (path) => {
    if (path === '/v1/rent') crashed = true; // the process dies once the door has answered 200
    return undefined;
  };
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.paid().length, 1);
  // restart from the file: the marker is there, the lease id is not
  state = loadState(file);
  assert.equal(state.grants[id]!.leaseId, undefined);
  assert.equal(state.grants[id]!.opening?.offerId, 'hostpub:offer1');
  r.door.onPay = undefined;
  r.door.offers = [freeOffer(B, 1), freeOffer('hostpub:offer1', 0)];
  r.clock.t += 2 * 60_000;
  await r.run({ state, save: () => saveState(file, state) });
  assert.equal(r.door.paid().length, 1, 'no second home');
  assert.ok(r.door.pays.filter((p) => p.path === '/v1/rent').every((p) => p.json.offerId === 'hostpub:offer1'));
  assert.equal(r.door.g(id).state, 'approved_waiting');
  assert.ok(r.problems.some((p) => p.key === 'open-unknown'));
  assert.ok(loadState(file).grants[id]!.openUnknown !== undefined, 'the hold is saved');
});

test('a lost re-open answer does not end the grant: it is retried on its offer, then held', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.door.offers = [freeOffer('hostpub:offer1', 1), freeOffer(B, 1)];
  let lose = true;
  r.door.onPay = (path, json) => {
    if (path !== '/v1/rent' || !lose) return undefined;
    r.door.leases.set(hex(), { state: 'running', paidIntervals: 1, paidThrough: r.clock.t + HOUR, keys: json.home.sshKeys.join('\n'), offerId: json.offerId });
    throw new Error('timeout');
  };
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.g(id).state, 'active', 'not ended on a lost answer');
  assert.equal(r.state.grants[id]!.opening?.offerId, 'hostpub:offer1');
  lose = false;
  r.door.offers = [freeOffer(B, 1), freeOffer('hostpub:offer1', 0)];
  r.clock.t += 5 * 60_000;
  await r.run();
  const rents = r.door.pays.filter((p) => p.path === '/v1/rent');
  assert.equal(rents.length, 3);
  assert.ok(rents.every((p) => p.json.offerId === 'hostpub:offer1'));
  assert.equal(r.door.g(id).state, 'active');
  assert.notEqual(r.state.grants[id]!.openUnknown, undefined);
  assert.ok(r.problems.some((p) => p.key === 'open-unknown'));
  const pays = r.door.pays.length;
  r.clock.t += 3 * HOUR;
  await r.run();
  assert.equal(r.door.pays.length, pays, 'nothing paid while held');
});

test('a lost re-open whose retry opens carries on', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  let lose = true;
  r.door.onPay = (path) => {
    if (path === '/v1/rent' && lose) throw new Error('timeout');
    return undefined;
  };
  r.clock.t += 2 * HOUR;
  await r.run();
  lose = false;
  r.clock.t += 5 * 60_000;
  await r.run();
  const f = r.state.grants[id]!;
  assert.notEqual(f.leaseId, leaseId);
  assert.equal(f.opening, undefined);
  assert.equal(f.fundTicks, 2);
  assert.equal(r.door.g(id).state, 'active');
});

// ---- the month ----

test('a grant pays 720 ticks then completes', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  for (let h = 1; h < 720; h++) {
    r.clock.t += HOUR;
    await r.run();
  }
  const g = r.door.g(id);
  assert.equal(r.door.paid().length, 720);
  assert.equal(r.state.grants[id]!.fundTicks, 720);
  assert.equal(g.state, 'completed');
  assert.equal(g.paidHours, 720);
  assert.equal(r.state.grants[id]!.watchUntil, r.clock.t + 7 * DAY);
  assert.equal(r.door.lease(leaseId).paidIntervals, 720);
  assert.deepEqual(r.problems, []);
  // every tick index came from the host, in order
  const idx = r.door.paid().filter((p) => p.path.endsWith('/ticks')).map((p) => p.json.index);
  assert.deepEqual(idx, Array.from({ length: 719 }, (_, i) => i + 1));
  for (let h = 0; h < 5; h++) {
    r.clock.t += HOUR;
    await r.run();
  }
  assert.equal(r.door.pays.length, 720, 'nothing after hour 720');
});

test('a tick is paid only when due', async () => {
  const r = rig();
  await opened(r);
  r.clock.t += HOUR / 2 - 1;
  await r.run();
  assert.equal(r.door.pays.length, 1);
  r.clock.t += 1;
  await r.run();
  assert.equal(r.door.pays.length, 2);
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.pays.length, 2, 'not twice for one hour');
});

test('a lease is read about once an hour, not every cycle', async () => {
  // A door lease read is a paid host status call the door pays for.
  const r = rig();
  const { leaseId } = await opened(r);
  const reads = () => r.door.gets.filter((g) => g.includes(leaseId)).length;
  for (let m = 1; m <= 120; m++) {
    r.clock.t += 60_000;
    await r.run();
  }
  assert.equal(r.door.paid().length, 3);
  assert.ok(reads() <= 4, `read ${reads()} times in two hours`);
});

test('payTick: 402 backs off and records a problem', async () => {
  const r = rig();
  const { id } = await opened(r);
  let refuse = true;
  r.door.onPay = (path) => (refuse && path.endsWith('/ticks') ? { status: 402, body: { error: 'payment_required' } } : undefined);
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.door.pays.length, 2);
  assert.equal(r.state.grants[id]!.fundTicks, 1);
  assert.equal(r.state.spend.micro, '7000', 'a refused tick is not spend');
  assert.ok(r.problems.some((p) => p.key === 'tick' && p.msg.includes('402')));
  assert.equal(r.state.grants[id]!.backoffUntil, r.clock.t + 5 * 60_000);
  refuse = false;
  r.clock.t += 4 * 60_000;
  await r.run();
  assert.equal(r.door.pays.length, 2, 'skipped while backing off');
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.pays.length, 3);
  assert.equal(r.state.grants[id]!.fundTicks, 2);
});

test('409 duplicate is not counted and does not back off', async () => {
  const r = rig();
  const { id } = await opened(r);
  let dup = true;
  r.door.onPay = (path) => (dup && path.endsWith('/ticks') ? { status: 409, body: { error: 'duplicate' } } : undefined);
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.state.grants[id]!.fundTicks, 1);
  assert.equal(r.state.grants[id]!.backoffUntil, undefined);
  dup = false;
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.state.grants[id]!.fundTicks, 2);
});

test('a tick whose answer never came is counted once the host shows it, never paid twice', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.onPay = (path, json) => {
    if (!path.endsWith('/ticks')) return undefined;
    // the host counts it, then the answer is lost
    const l = r.door.lease(leaseId);
    if (json.index === l.paidIntervals) {
      l.paidIntervals++;
      l.paidThrough! += HOUR;
    }
    throw new Error('timeout');
  };
  r.clock.t += HOUR / 2;
  await r.run();
  assert.ok(r.problems.some((p) => p.key === 'tick'));
  assert.equal(r.state.grants[id]!.fundTicks, 1);
  r.door.onPay = undefined;
  r.clock.t += 5 * 60_000;
  await r.run();
  const f = r.state.grants[id]!;
  assert.equal(f.fundTicks, 2, 'the lost answer counted');
  assert.equal(f.renewedByGrantee ?? false, false, 'not read as the grantee paying');
  assert.equal(r.door.g(id).renewedByGrantee, false);
  assert.equal(r.state.spend.micro, '14000');
  assert.equal(r.door.lease(leaseId).paidIntervals, 2, 'not paid twice');
});

for (const [status, error] of [[502, 'host send timed out'], [402, 'settlement_failed'], [503, 'retry_later']] as const) {
  test(`a tick answered ${status} ${error} that the host counted is the door's hour, never the grantee's`, async () => {
    const r = rig();
    const { id, leaseId } = await opened(r);
    r.door.onPay = (path, json) => {
      if (!path.endsWith('/ticks')) return undefined;
      // the door paid the host, then the fund's payment did not settle
      const l = r.door.lease(leaseId);
      l.paidIntervals = json.index + 1;
      l.paidThrough! += HOUR;
      return { status, body: { error } };
    };
    r.clock.t += HOUR / 2;
    await r.run();
    const f = r.state.grants[id]!;
    assert.deepEqual(f.hostPaid, { leaseId, index: 1 });
    assert.equal(f.backoffUntil, r.clock.t + 5 * 60_000);
    r.door.onPay = undefined;
    r.clock.t += 5 * 60_000;
    await r.run();
    assert.equal(f.renewedByGrantee ?? false, false);
    assert.equal(r.door.g(id).renewedByGrantee, false, 'not posted as renewed');
    assert.equal(f.hostPaid, undefined);
    assert.equal(f.leaseTicks, 2, 'the door-paid hour is on the lease count');
    assert.equal(f.fundTicks, 1, 'the fund did not pay it');
    assert.equal(r.state.spend.micro, '7000', 'not day spend');
    // and a real grantee hour afterwards is still seen
    r.door.granteeTick(leaseId);
    r.clock.t += HOUR;
    await r.run();
    assert.equal(r.door.g(id).renewedByGrantee, true);
  });
}

test('a tick refused before the host (400) keeps no host-paid marker', async () => {
  const r = rig();
  const { id } = await opened(r);
  r.door.onPay = (path) => (path.endsWith('/ticks') ? { status: 400, body: { error: 'authorization_window' } } : undefined);
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.state.grants[id]!.hostPaid, undefined);
});

test('409 out_of_order (the grantee paid between read and tick) is no problem, no backoff, re-read next cycle', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  let once = true;
  r.door.onPay = (path) => {
    if (!path.endsWith('/ticks') || !once) return undefined;
    once = false;
    r.door.granteeTick(leaseId);
    return { status: 409, body: { error: 'out_of_order', expected: 2 } };
  };
  r.clock.t += HOUR / 2;
  await r.run();
  const f = r.state.grants[id]!;
  assert.equal(f.backoffUntil, undefined);
  assert.equal(f.hostPaid, undefined);
  assert.ok(!r.problems.some((p) => p.key === 'tick'), JSON.stringify(r.problems));
  assert.equal(f.fundTicks, 1);
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.g(id).renewedByGrantee, true, 'the grantee paid that hour');
  // the grantee paid index 1, so the fund's next tick is index 2, an hour later
  r.clock.t += HOUR;
  await r.run();
  const idx = r.door.paid().filter((p) => p.path.endsWith('/ticks')).map((p) => p.json.index);
  assert.deepEqual(idx, [2]);
  assert.equal(f.fundTicks, 2);
});

test('the day cap stops ticks and resets at UTC midnight', async () => {
  const r = rig();
  const { id } = await opened(r);
  r.state.grants[id]!.daySpend = { day: '2026-11-20', micro: String(252_000n - 6_999n) };
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.state.grants[id]!.fundTicks, 1);
  assert.ok(r.problems.some((p) => p.key === 'daycap'));
  // past midnight the day starts again (the lease lapsed meanwhile and re-opens)
  r.clock.t = Date.UTC(2026, 10, 21, 0, 5);
  r.door.close(r.state.grants[id]!.leaseId!);
  await r.run();
  assert.equal(r.state.spend.day, '2026-11-21');
  assert.equal(r.state.spend.micro, '7000');
  assert.deepEqual(r.state.grants[id]!.daySpend, { day: '2026-11-21', micro: '7000' });
  assert.equal(r.state.grants[id]!.fundTicks, 2);
});

test('the day cap is per grant: one grant completing at 18:00 UTC never blocks another', async () => {
  const r = rig({ balance: 20_000_000n });
  r.door.offers = [offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 2 } })];
  const a = await opened(r);
  r.clock.t += 60_000;
  const b = await opened(r, { sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyForTestsOnly000000000000000000000 c@d'] });
  // A completes at its tick due before 18:00: 720 - 18 hours of the fund's earlier pay.
  r.state.grants[a.id]!.fundTicks = 720 - 18;
  r.state.grants[a.id]!.leaseTicks = 1;
  const end = Date.UTC(2026, 10, 20, 23, 50);
  while (r.clock.t < end) {
    r.clock.t += 10 * 60_000;
    await r.run();
  }
  assert.equal(r.door.g(a.id).state, 'completed');
  assert.ok(r.state.grants[a.id]!.watchUntil! - 7 * DAY <= Date.UTC(2026, 10, 20, 18, 0), 'A completed by 18:00');
  const fb = r.state.grants[b.id]!;
  assert.equal(fb.fundTicks, 25, 'B paid its open and every hour of the day');
  assert.ok(!r.problems.some((p) => p.key === 'daycap'), JSON.stringify(r.problems));
  // the fund-wide figure is the sum of the grants' days
  const sum = BigInt(r.state.grants[a.id]!.daySpend!.micro) + BigInt(fb.daySpend!.micro);
  assert.equal(r.state.spend.micro, sum.toString());
  assert.ok(sum > 252_000n, 'more than one grant\'s cap was spent in the day');
});

test('state survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-state-'));
  const file = join(dir, 'state.json');
  let state = loadState(file);
  const r = rig({ state, save: () => saveState(file, state) });
  const { id, leaseId } = await opened(r);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // the grantee pays two hours itself while the fund is down
  r.door.granteeTick(leaseId);
  r.door.granteeTick(leaseId);
  state = loadState(file);
  assert.equal(state.grants[id]!.fundTicks, 1);
  r.clock.t += 3 * HOUR - HOUR / 2;
  await r.run({ state, save: () => saveState(file, state) });
  const ticks = r.door.paid().filter((p) => p.path.endsWith('/ticks'));
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0]!.json.index, 3, 'the host paidIntervals, not fundTicks');
  const back = loadState(file);
  assert.equal(back.grants[id]!.fundTicks, 2);
  assert.equal(back.spend.micro, '14000');
});

test('loadState: a missing file is a fresh state, a broken one throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-state-'));
  assert.deepEqual(loadState(join(dir, 'none.json')), emptyState());
  const bad = join(dir, 'bad.json');
  saveState(bad, { ...emptyState(), spend: { day: '', micro: 'x' } } as FundState);
  assert.throws(() => loadState(bad));
});

test('loadState reads a state file written before judgeAttempts, daySpend and hostPaid existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-state-'));
  const file = join(dir, 'state.json');
  const id = hex();
  // the shape the deployed fund writes today
  const old = {
    grants: { [id]: { grantId: id, fundTicks: 12, reopened: false, leaseId: hex(), leaseTicks: 12, lastPaidAt: T0, nextReadAt: T0, inflight: { leaseId: hex(), index: 12, price: '7000' } } },
    spend: { day: '2026-11-20', micro: '84000' },
    stopAll: false,
    stopped: [],
  };
  writeFileSync(file, JSON.stringify(old));
  const s = loadState(file);
  assert.deepEqual(s.judgeAttempts, {});
  assert.equal(s.grants[id]!.fundTicks, 12);
  assert.equal(s.grants[id]!.daySpend, undefined);
  assert.equal(s.spend.micro, '84000');
  // and it is written back with the new fields, and reads again
  s.judgeAttempts[hex()] = 2;
  s.grants[id]!.daySpend = { day: '2026-11-20', micro: '7000' };
  s.grants[id]!.hostPaid = { leaseId: hex(), index: 3 };
  saveState(file, s);
  assert.deepEqual(loadState(file), s);
  // a broken new field still stops the fund
  for (const bad of [{ ...old, judgeAttempts: { x: -1 } }, { ...old, grants: { [id]: { ...old.grants[id], daySpend: { day: 1, micro: '0' } } } }, { ...old, grants: { [id]: { ...old.grants[id], hostPaid: { index: 1 } } } }]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadState(file), /not valid/);
  }
});

test('a deployed fund with a pre-upgrade state keeps paying where it left off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fund-state-'));
  const file = join(dir, 'state.json');
  const r0 = rig();
  const { id, leaseId } = await opened(r0);
  const g = { ...r0.state.grants[id]! };
  delete g.daySpend;
  writeFileSync(file, JSON.stringify({ grants: { [id]: g }, spend: r0.state.spend, stopAll: false, stopped: [] }));
  const state = loadState(file);
  r0.clock.t += HOUR / 2;
  await r0.run({ state, save: () => saveState(file, state) });
  assert.equal(loadState(file).grants[id]!.fundTicks, 2);
  assert.equal(r0.door.lease(leaseId).paidIntervals, 2);
});

test('grantee tick marks renewedByGrantee', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.granteeTick(leaseId);
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.door.g(id).renewedByGrantee, true);
  assert.equal(r.door.pays.length, 1, 'the grantee paid this hour, nothing due');
  r.door.granteeTick(leaseId);
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.posts.filter((p) => p.id === id && p.json.renewedByGrantee !== undefined).length, 1, 'set once');
});

test('after completion the fund watches 7 days, marks a grantee renewal, never pays', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.state.grants[id]!.fundTicks = 719;
  r.state.grants[id]!.leaseTicks = 719;
  r.door.lease(leaseId).paidIntervals = 719;
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.door.g(id).state, 'completed');
  const pays = r.door.pays.length;
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.g(id).renewedByGrantee, false);
  r.door.granteeTick(leaseId);
  r.clock.t += HOUR;
  await r.run();
  assert.equal(r.door.g(id).renewedByGrantee, true);
  assert.equal(r.door.pays.length, pays, 'no payment after completion');
  // past the watch nothing is read
  r.clock.t += 8 * DAY;
  const reads = r.door.gets.length;
  await r.run();
  assert.equal(r.door.gets.filter((g) => g.includes(leaseId)).length, r.door.gets.slice(0, reads).filter((g) => g.includes(leaseId)).length);
});

test('one re-open, then ended_early', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.clock.t += 2 * HOUR;
  await r.run();
  const f = r.state.grants[id]!;
  assert.equal(f.reopened, true);
  assert.notEqual(f.leaseId, leaseId);
  assert.equal(f.fundTicks, 2, 'the re-open first hour is a fund tick');
  assert.equal(r.door.g(id).state, 'active');
  assert.equal(r.door.g(id).leaseId, f.leaseId);
  assert.equal(r.door.g(id).paidHours, 2);
  const rents = r.door.paid().filter((p) => p.path === '/v1/rent');
  assert.equal(rents.length, 2);
  assert.deepEqual(rents[1]!.json.home, { sshKeys: KEYS, image: 'charter-home' });
  // it ticks on the new lease from the host's count
  r.clock.t += HOUR / 2;
  await r.run();
  assert.equal(r.door.paid().at(-1)!.path, `/v1/leases/${f.leaseId}/ticks`);
  assert.equal(r.door.paid().at(-1)!.json.index, 1);
  assert.equal(r.door.g(id).renewedByGrantee, false, 'a re-open is not a grantee renewal');
  r.door.close(f.leaseId!);
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.g(id).state, 'ended_early');
  assert.equal(r.door.paid().filter((p) => p.path === '/v1/rent').length, 2, 'no second re-open');
});

test('a re-open refused with home_in_use ends the grant', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.door.onPay = (path) => (path === '/v1/rent' ? { status: 502, body: { error: 'home_in_use', closedReason: 'home_in_use' } } : undefined);
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.g(id).state, 'ended_early');
  assert.equal(r.state.grants[id]!.fundTicks, 1);
});

test('a re-open refused for any other reason ends the grant', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.door.onPay = (path) => (path === '/v1/rent' ? { status: 503, body: { error: 'capacity' } } : undefined);
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.g(id).state, 'ended_early');
});

test('a re-open waits for a free slot rather than ending', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.door.offers = [offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 0 } })];
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.g(id).state, 'active');
  assert.equal(r.state.grants[id]!.reopened, false);
  r.door.offers = [offer()];
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.state.grants[id]!.reopened, false, 'the closed lease is read again in 5 minutes, not every cycle');
  r.clock.t += 4 * 60_000;
  await r.run();
  assert.equal(r.state.grants[id]!.reopened, true);
  assert.equal(r.state.grants[id]!.fundTicks, 2);
});

// ---- grants open only on hosts with a record ----

const rec = (leasesFinished: number, more: Record<string, unknown> = {}) => ({ probesPassed: 3, leasesFinished, successRate: 1, new: false, ...more });

test('grantEligible: 5 leases and no probe failure in 7 days', () => {
  assert.equal(grantEligible({}, T0, 5), false, 'no record');
  assert.equal(grantEligible({ record: { leasesFinished: 4 } }, T0, 5), false);
  assert.equal(grantEligible({ record: { leasesFinished: 5 } }, T0, 5), true);
  assert.equal(grantEligible({ record: { leasesFinished: 5, lastProbeFailedAt: T0 - 7 * DAY + 1 } }, T0, 5), false);
  assert.equal(grantEligible({ record: { leasesFinished: 5, lastProbeFailedAt: T0 - 7 * DAY } }, T0, 5), true);
});

test('a host with 4 finished leases is skipped', async () => {
  const r = rig();
  r.door.offers = [offer({ offerId: 'hostpub:thin', record: rec(4) }), offer({ offerId: 'hostpub:proven', record: rec(5) })];
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.paid().find((p) => p.path === '/v1/rent')!.json.offerId, 'hostpub:proven');
  assert.equal(r.door.g(id).state, 'active');
});

test('5 finished and a failed probe 3 days ago is skipped', async () => {
  const r = rig();
  r.door.offers = [offer({ offerId: 'hostpub:flaky', record: rec(9, { lastProbeFailedAt: T0 - 3 * DAY }) }), offer({ offerId: 'hostpub:ok', record: rec(5, { lastProbeFailedAt: T0 - 8 * DAY }) })];
  r.door.grant();
  await r.run();
  assert.equal(r.door.paid().find((p) => p.path === '/v1/rent')!.json.offerId, 'hostpub:ok');
});

test('5 finished, no recent failure, is picked', async () => {
  const r = rig();
  r.door.offers = [offer({ record: rec(5) })];
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.g(id).state, 'active');
});

test('a host waiting for funding is skipped for new grants', async () => {
  const r = rig();
  r.door.offers = [offer({ offerId: 'hostpub:wait', record: rec(9, { funding: 'waiting' }) })];
  r.door.grant();
  await r.run();
  assert.equal(r.door.paid().length, 0);
});

test('none eligible waits and opens nothing', async () => {
  const r = rig();
  r.door.offers = [offer({ record: rec(4) }), offer({ offerId: 'hostpub:none', record: undefined })];
  const id = r.door.grant();
  await r.run();
  assert.equal(r.door.paid().length, 0);
  assert.equal(r.door.g(id).state, 'approved_waiting');
  assert.ok(r.problems.some((p) => p.msg.includes('no host with a record has a free home slot; waiting')), JSON.stringify(r.problems));
});

test('a re-open without a pin picks only a proven host; none waits', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.door.offers = [offer({ record: rec(1) })];
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.paid().filter((p) => p.path === '/v1/rent').length, 1);
  assert.equal(r.state.grants[id]!.reopened, false);
  assert.ok(r.problems.some((p) => p.msg.includes('no host with a record has a free home slot; waiting')));
});

test('a pinned re-open keeps going to its offer whatever its record', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.state.grants[id]!.opening = { offerId: 'hostpub:offer1', at: T0 };
  r.door.offers = [offer({ record: rec(0) })];
  r.clock.t += 2 * HOUR;
  await r.run();
  assert.equal(r.door.paid().filter((p) => p.path === '/v1/rent').length, 2);
});

test('home_host_gone on a re-open waits; the grant is not ended', async () => {
  const r = rig();
  const { id, leaseId } = await opened(r);
  r.door.close(leaseId);
  r.clock.t += 2 * HOUR;
  r.door.onPay = (path) => (path === '/v1/rent' ? { status: 409, body: { error: 'home_host_gone' } } : undefined);
  await r.run();
  assert.equal(r.door.g(id).state, 'active');
  assert.equal(r.state.grants[id]!.reopened, false);
  assert.equal(r.state.grants[id]!.opening, undefined);
  assert.ok(r.problems.some((p) => p.msg.includes('home_host_gone')));
  r.door.onPay = undefined;
  r.clock.t += 6 * 60_000;
  await r.run();
  assert.equal(r.state.grants[id]!.reopened, true);
});

// ---- stops ----

test('a stopped grant is never paid', async () => {
  const r = rig();
  const { id } = await opened(r);
  r.state.stopped.push(id);
  for (let h = 0; h < 4; h++) {
    r.clock.t += HOUR;
    await r.run();
  }
  assert.equal(r.door.pays.length, 1);
  assert.equal(r.door.g(id).state, 'stopped');
  assert.equal(r.door.posts.filter((p) => p.id === id && p.json.state === 'stopped').length, 1, 'posted once');
});

test('a stopped waiting grant is never opened', async () => {
  const r = rig();
  const id = r.door.grant();
  r.state.stopped.push(id);
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.door.g(id).state, 'stopped');
});

test('stopAll closes intake', async () => {
  const r = rig();
  const { id } = await opened(r);
  const waiting = r.door.grant();
  r.door.grant({ state: 'queued' });
  r.state.stopAll = true;
  const judgedBefore = r.judged();
  r.clock.t += HOUR;
  await r.run();
  assert.deepEqual(r.door.publicBody, { address: ADDRESS, balanceMicro: '10000000', grantsLeft: 0, open: false });
  assert.equal(r.judged(), judgedBefore, 'no judging while stopped');
  assert.equal(r.door.pays.length, 1, 'nothing paid');
  assert.equal(r.door.g(id).state, 'stopped');
  assert.equal(r.door.g(waiting).state, 'stopped');
});

test('stopAll closes intake even when the balance read fails, with the last known balance or 0', async () => {
  const r = rig();
  r.state.stopAll = true;
  await r.run({ balance: async () => { throw new Error('rpc down'); }, lastBalanceMicro: () => '5000000' });
  assert.deepEqual(r.door.publicBody, { address: ADDRESS, balanceMicro: '5000000', grantsLeft: 0, open: false });
  r.door.publicBody = undefined;
  await r.run({ balance: async () => { throw new Error('rpc down'); } });
  assert.deepEqual(r.door.publicBody, { address: ADDRESS, balanceMicro: '0', grantsLeft: 0, open: false });
  assert.ok(r.problems.some((p) => p.key === 'balance'));
});

// ---- robustness ----

test('ids that are not 32 hex characters are never put in a path', async () => {
  const r = rig();
  r.door.grant({ grantId: '../../v1/rent' });
  r.door.grant({ grantId: 'ABCDEF0123456789ABCDEF0123456789' });
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.door.posts.length, 0);
  assert.ok(r.problems.some((p) => p.msg.includes('not 32')));

  const r2 = rig();
  r2.door.onPay = (path) => (path === '/v1/rent' ? { status: 200, body: { leaseId: '../x', state: 'running' } } : undefined);
  const id = r2.door.grant();
  await r2.run();
  r2.clock.t += HOUR;
  await r2.run();
  assert.ok(r2.door.gets.every((g) => g === '/v1/offers'), `no lease read: ${r2.door.gets.join(',')}`);
  assert.ok(r2.door.pays.every((p) => p.path === '/v1/rent'));
  assert.equal(r2.door.g(id).state, 'ended_early');
});

test('one failing grant does not stop the others, and a network error is a problem', async () => {
  const r = rig({ balance: 20_000_000n });
  const a = await opened(r);
  r.clock.t += 60_000;
  r.door.offers = [offer({ home: { diskGiB: 2, retentionDays: 7, slots: 2, free: 2 } })];
  const b = await opened(r, { sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyForTestsOnly000000000000000000000 c@d'] });
  r.door.onGet = (p) => {
    if (p.includes(a.leaseId)) throw new Error('socket hang up');
    return undefined;
  };
  r.clock.t += HOUR;
  await r.run();
  assert.ok(r.problems.some((p) => p.msg.includes('socket hang up')));
  assert.equal(r.state.grants[b.id]!.fundTicks, 2);
  assert.equal(r.state.grants[a.id]!.fundTicks, 1);
});

test('cycle never throws: every door call failing is only problems', async () => {
  const r = rig();
  r.door.grant();
  const boom = async () => {
    throw new Error('down');
  };
  const door = { payTo: r.door.payTo, get: boom, pay: boom, fund: boom } as DoorClient;
  await r.run({ door, judgeOne: boom, balance: boom });
  assert.ok(r.problems.length > 0);
});

test('a door update that fails is sent again next cycle', async () => {
  const r = rig();
  const id = r.door.grant();
  const real = r.door.fund.bind(r.door);
  let down = true;
  r.door.fund = async (m, p, j) => (down && m === 'POST' ? { status: 503, body: null } : real(m, p, j));
  await r.run();
  assert.equal(r.door.g(id).state, 'approved_waiting');
  assert.equal(r.state.grants[id]!.fundTicks, 1);
  down = false;
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.paid().length, 1, 'not opened twice');
  assert.equal(r.door.g(id).state, 'active');
  assert.equal(r.door.g(id).leaseId, r.state.grants[id]!.leaseId);
});

test('an active grant the fund has no record of is never paid', async () => {
  const r = rig();
  const leaseId = hex();
  r.door.leases.set(leaseId, { state: 'running', paidIntervals: 1, paidThrough: T0, keys: 'k' });
  const id = r.door.grant({ state: 'active', leaseId });
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.ok(r.problems.some((p) => p.msg.includes(id)));
});

test('a save that fails before a payment stops the payment', async () => {
  const r = rig({
    save: () => {
      throw new Error('disk full');
    },
  });
  r.door.grant();
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.ok(r.problems.some((p) => p.msg.includes('disk full')));
});

// ---- judgeOne ----

function judgeRig(verdict: Verdict | Error = { decision: 'grant', summary: 'runs a bot', reason: 'A concrete use.' }) {
  const clock = { t: T0 };
  const door = new FakeDoor(clock);
  const calls: Array<{ p: PitchIn; ctx: { live: number; slots: number } }> = [];
  const judge = async (p: PitchIn, ctx: { live: number; slots: number }) => {
    calls.push({ p, ctx });
    if (verdict instanceof Error) throw verdict;
    return verdict;
  };
  const one = makeJudgeOne({ door, judge, slots: async () => 2 });
  return { door, calls, one };
}

test('judgeOne: a grant verdict moves the oldest queued pitch to approved_waiting', async () => {
  const j = judgeRig();
  const young = j.door.grant({ state: 'queued', createdAt: T0 });
  const old = j.door.grant({ state: 'queued', createdAt: T0 - 10, link: 'https://x.test' });
  j.door.grant({ state: 'active' });
  await j.one();
  assert.equal(j.door.g(old).state, 'approved_waiting');
  assert.equal(j.door.g(old).summary, 'runs a bot');
  assert.equal(j.door.g(old).reason, 'A concrete use.');
  assert.equal(j.door.g(young).state, 'queued');
  assert.deepEqual(j.calls[0], { p: { name: 'agent', link: 'https://x.test', image: 'charter-home', pitch: 'run a bot' }, ctx: { live: 1, slots: 2 } });
});

test('judgeOne: a decline verdict moves it to declined', async () => {
  const j = judgeRig({ decision: 'decline', summary: 's', reason: 'Not a fit.' });
  const id = j.door.grant({ state: 'queued' });
  await j.one();
  assert.equal(j.door.g(id).state, 'declined');
  assert.deepEqual(j.calls[0]!.p, { name: 'agent', image: 'charter-home', pitch: 'run a bot' }, 'a null link is left out');
});

test('judgeOne: a home that had a grant is declined without a model call', async () => {
  const j = judgeRig();
  j.door.grant({ state: 'completed', homeId: 'h1' });
  const id = j.door.grant({ state: 'queued', homeId: 'h1' });
  await j.one();
  assert.equal(j.calls.length, 0);
  assert.equal(j.door.g(id).state, 'declined');
  assert.equal(j.door.g(id).reason, HOME_USED_REASON);
  assert.equal(HOME_USED_REASON, 'This home has had a grant before.');
});

test('judgeOne: a declined or queued pitch on the same home is no bar', async () => {
  const j = judgeRig();
  j.door.grant({ state: 'declined', homeId: 'h1' });
  j.door.grant({ state: 'queued', homeId: 'h1', createdAt: T0 + 5 });
  const id = j.door.grant({ state: 'queued', homeId: 'h1', createdAt: T0 });
  await j.one();
  assert.equal(j.calls.length, 1);
  assert.equal(j.door.g(id).state, 'approved_waiting');
});

test('judgeOne: an API error leaves the pitch queued', async () => {
  const j = judgeRig(new Error('overloaded'));
  const id = j.door.grant({ state: 'queued' });
  await assert.rejects(j.one(), /overloaded/);
  assert.equal(j.door.g(id).state, 'queued');
  assert.equal(j.door.posts.length, 0);
});

function attemptsRig(fail: () => Error | undefined) {
  const clock = { t: T0 };
  const door = new FakeDoor(clock);
  const state = emptyState();
  let calls = 0;
  let saves = 0;
  const judge = async () => {
    calls++;
    const e = fail();
    if (e) throw e;
    return { decision: 'grant' as const, summary: 's', reason: 'A concrete use.' };
  };
  const one = makeJudgeOne({ door, judge, slots: async () => 2, state, save: () => void saves++, transient: (e) => (e as Error).message === 'overloaded' });
  return { door, state, one, calls: () => calls, saves: () => saves };
}

test('judgeOne: a pitch the judge fails on 3 times is declined as unreadable, and the queue moves on', async () => {
  let failing = true;
  const j = attemptsRig(() => (failing ? new Error('invalid request') : undefined));
  const bad = j.door.grant({ state: 'queued', createdAt: T0 - 10 });
  const next = j.door.grant({ state: 'queued', createdAt: T0 });
  await assert.rejects(j.one(), /invalid request/);
  await assert.rejects(j.one(), /invalid request/);
  assert.equal(j.state.judgeAttempts[bad], 2);
  assert.ok(j.saves() >= 2, 'each failure is saved');
  assert.equal(j.door.g(bad).state, 'queued');
  await j.one();
  assert.equal(MAX_JUDGE_TRIES, 3);
  assert.equal(j.calls(), 3);
  assert.equal(j.door.g(bad).state, 'declined');
  assert.equal(j.door.g(bad).reason, 'The judge could not read this pitch.');
  assert.equal(j.state.judgeAttempts[bad], undefined, 'cleared once posted');
  failing = false;
  await j.one();
  assert.equal(j.door.g(next).state, 'approved_waiting');
});

test('judgeOne: a pitch at the attempt limit is declined with no model call (a post that failed is sent again)', async () => {
  const j = attemptsRig(() => undefined);
  const id = j.door.grant({ state: 'queued' });
  j.state.judgeAttempts[id] = 3;
  await j.one();
  assert.equal(j.calls(), 0);
  assert.equal(j.door.g(id).state, 'declined');
  assert.equal(j.door.g(id).reason, 'The judge could not read this pitch.');
});

test('judgeOne: a queued pitch Drew stopped is declined as unreadable with no model call, and the queue moves on', async () => {
  const j = attemptsRig(() => new Error('invalid request'));
  const stuck = j.door.grant({ state: 'queued', createdAt: T0 - 10 });
  j.state.stopped = [stuck];
  await j.one();
  assert.equal(j.calls(), 0);
  assert.equal(j.door.g(stuck).state, 'declined');
  assert.equal(j.door.g(stuck).reason, 'The judge could not read this pitch.');
});

test('judgeOne: an unavailable API is not counted against the pitch', async () => {
  const j = attemptsRig(() => new Error('overloaded'));
  const id = j.door.grant({ state: 'queued' });
  for (let i = 0; i < 5; i++) await assert.rejects(j.one(), new RegExp(`grant ${id}: .*not counted.*overloaded`));
  assert.equal(j.state.judgeAttempts[id], undefined);
  assert.equal(j.door.g(id).state, 'queued');
});

test('judgeOne: an empty queue does nothing; a bad id is never posted', async () => {
  const j = judgeRig();
  await j.one();
  assert.equal(j.calls.length, 0);
  j.door.grant({ state: 'queued', grantId: 'nope/../x' });
  await assert.rejects(j.one(), /32/);
  assert.equal(j.door.posts.length, 0);
  assert.equal(j.calls.length, 0);
});

// ---- at most N live grant homes on one host ----

const HA = 'a'.repeat(64);
const HB = 'b'.repeat(64);
const roomy = (hostId: string) => offer({ offerId: `${hostId}:o1`, record: rec(9), home: { diskGiB: 2, retentionDays: 7, slots: 9, free: 9 } });
const keysFor = (n: number) => [`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly000000000000000000${n}0 g${n}@b`];
const hostOf = (r: ReturnType<typeof rig>, id: string) => (r.door.g(id).leaseId ? r.door.leases.get(r.door.g(id).leaseId as string)?.offerId : undefined);

test('with 2 per host, a third grant skips the full host and lands on another', async () => {
  const r = rig({ balance: 100_000_000n });
  r.door.offers = [roomy(HA), roomy(HB)];
  const ids = [1, 2, 3].map((n) => r.door.grant({ sshKeys: keysFor(n) }));
  for (let i = 0; i < 3; i++) await r.run({ grantHomesPerHost: 2 });
  const rents = r.door.paid().filter((p) => p.path === '/v1/rent').map((p) => p.json.offerId);
  assert.deepEqual(rents, [`${HA}:o1`, `${HA}:o1`, `${HB}:o1`]);
  assert.ok(ids.every((id) => r.door.g(id).state === 'active'));
});

test('every eligible host full: the grant waits with the room text', async () => {
  const r = rig({ balance: 100_000_000n });
  r.door.offers = [roomy(HA)];
  for (const n of [1, 2, 3]) r.door.grant({ sshKeys: keysFor(n) });
  for (let i = 0; i < 3; i++) await r.run({ grantHomesPerHost: 2 });
  assert.equal(r.door.paid().filter((p) => p.path === '/v1/rent').length, 2);
  assert.ok(r.problems.some((p) => p.msg.includes('no host with a record has room for another grant home; waiting')), JSON.stringify(r.problems));
});

test('a cap of 0 opens nothing; no host with a record keeps the older text', async () => {
  const r = rig();
  r.door.offers = [roomy(HA)];
  r.door.grant();
  await r.run({ grantHomesPerHost: 0 });
  assert.equal(r.door.paid().length, 0);
  assert.ok(r.problems.some((p) => p.msg.includes('has room for another grant home')));
  const r2 = rig();
  r2.door.offers = [offer({ offerId: `${HA}:o1`, record: rec(1) })];
  r2.door.grant();
  await r2.run({ grantHomesPerHost: 0 });
  assert.ok(r2.problems.some((p) => p.msg.includes('has a free home slot')));
});

test('a re-open of a grant\'s own home on a full host is not blocked', async () => {
  const r = rig({ balance: 100_000_000n });
  r.door.offers = [roomy(HA)];
  const { id, leaseId } = await (async () => {
    const id = r.door.grant({ sshKeys: keysFor(1) });
    await r.run({ grantHomesPerHost: 1 });
    return { id, leaseId: r.door.g(id).leaseId as string };
  })();
  r.door.close(leaseId);
  r.clock.t += 2 * HOUR;
  await r.run({ grantHomesPerHost: 1 });
  const rents = r.door.paid().filter((p) => p.path === '/v1/rent');
  assert.equal(rents.length, 2);
  assert.equal(rents[1]!.json.offerId, `${HA}:o1`);
  assert.equal(r.state.grants[id]!.reopened, true);
});

test('renewals (ticks) are never blocked by the cap', async () => {
  const r = rig({ balance: 100_000_000n });
  r.door.offers = [roomy(HA)];
  const id = r.door.grant({ sshKeys: keysFor(1) });
  await r.run({ grantHomesPerHost: 1 });
  const before = r.state.grants[id]!.fundTicks;
  r.clock.t += HOUR;
  await r.run({ grantHomesPerHost: 1 });
  assert.ok(r.state.grants[id]!.fundTicks > before, 'the tick was paid on a host at its cap');
  assert.ok(hostOf(r, id) === undefined || hostOf(r, id)!.startsWith(HA));
});

test('an opening in progress counts toward its host', async () => {
  const r = rig({ balance: 100_000_000n });
  r.door.offers = [roomy(HA), roomy(HB)];
  const first = r.door.grant({ sshKeys: keysFor(1) });
  await r.run({ grantHomesPerHost: 1 });
  r.state.grants[first]!.leaseId = undefined;
  r.state.grants[first]!.opening = { offerId: `${HA}:o1`, at: T0 };
  r.door.grant({ sshKeys: keysFor(2) });
  await r.run({ grantHomesPerHost: 1 });
  const rents = r.door.paid().filter((p) => p.path === '/v1/rent').map((p) => p.json.offerId);
  assert.equal(rents[rents.length - 1], `${HB}:o1`);
});
