import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOWED_MOVES, LIVE_STATES, type AllowanceState, type SignedPermission } from '../door/allowances.js';
import type { Answer, DoorClient } from '../fund/door-client.js';
import { cycle, LAPSE_END_MS, pullNeed, SHORT_RETRY_MS, type BillerDeps } from './biller.js';
import { inForce, NotSent, type Chain } from './chain.js';
import { loadState, saveState, type AllowState } from './state.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 24, 12, 0);
const hex = () => randomBytes(16).toString('hex');
const SPENDER = '0x3333333333333333333333333333333333333333';
const ACCOUNT = '0x4444444444444444444444444444444444444444';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const KEYS = ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly0000000000000000000000 a@b'];
const OFFER = 'hostpub:offer1';

function signed(): SignedPermission {
  return {
    signature: '0xabcdef',
    chainId: 8453,
    permission: { account: ACCOUNT, spender: SPENDER, token: USDC, allowance: '5208000', period: 2592000, start: 1, end: 281474976710655, salt: '0x01', extraData: '0x' },
  };
}

interface FakeLease { state: string; paidIntervals: number; paidThrough: number }

/** The door as the biller sees it: allowances, homes and leases in memory, answering as server.ts does. */
class FakeDoor implements DoorClient {
  payTo = '0x1111111111111111111111111111111111111111';
  allowances = new Map<string, Record<string, any>>();
  homes = new Map<string, { leaseId: string | null; offerId: string | null; hostKnown: boolean; grantLive: boolean }>();
  leases = new Map<string, FakeLease>();
  offer = { offerId: OFFER, intervalSeconds: 3600, tickPrice: '7000', images: ['charter-home', 'charter-hermes'] };
  pays: Array<{ path: string; json: any; status: number }> = [];
  posts: Array<{ id: string; json: any; status: number }> = [];
  gets: string[] = [];
  onPay?: (path: string, json: any) => Answer | undefined;
  onFund?: (method: string, path: string, json: any) => Answer | undefined;
  /** What the saved state looked like when each pay was sent. */
  savedAtPay: string[] = [];

  constructor(readonly clock: { t: number }, readonly saved: { s: string }) {}

  /** An allowance for a home with a running lease whose next tick is due. */
  home(over: Record<string, unknown> = {}, lease: Partial<FakeLease> = {}): { id: string; homeId: string; leaseId: string } {
    const id = hex();
    const homeId = randomBytes(8).toString('hex');
    const leaseId = hex();
    this.leases.set(leaseId, { state: 'running', paidIntervals: 3, paidThrough: this.clock.t + 10 * 60_000, ...lease });
    this.homes.set(homeId, { leaseId, offerId: OFFER, hostKnown: true, grantLive: false });
    this.allowances.set(id, {
      allowanceId: id,
      state: 'active',
      homeId,
      sshKeys: KEYS,
      image: 'charter-home',
      tickMicro: '7000',
      createdAt: this.clock.t - DAY,
      updatedAt: this.clock.t - DAY,
      signed: signed(),
      account: ACCOUNT,
      hoursPaid: 0,
      ...over,
    });
    return { id, homeId, leaseId };
  }

  a(id: string) {
    return this.allowances.get(id)!;
  }

  stateOf(id: string): string {
    return this.a(id).state;
  }

  tickPays() {
    return this.pays.filter((p) => p.path.endsWith('/ticks'));
  }

  async get(path: string): Promise<Answer> {
    this.gets.push(path);
    const m = /^\/v1\/leases\/([0-9a-f]{32})$/.exec(path);
    if (m && this.leases.has(m[1]!)) return { status: 200, body: { lease: { id: m[1], ...this.leases.get(m[1]!) }, stopped: false, offer: this.offer } };
    return { status: 404, body: { error: 'not_found' } };
  }

  async post(): Promise<Answer> {
    throw new Error('the biller sends no free POST');
  }

  async pay(path: string, json: any): Promise<Answer> {
    this.savedAtPay.push(this.saved.s);
    let a: Answer | undefined;
    try {
      a = this.onPay?.(path, json);
    } catch (e) {
      this.pays.push({ path, json, status: 0 });
      throw e;
    }
    a ??= this.answerPay(path, json);
    this.pays.push({ path, json, status: a.status });
    return a;
  }

  private answerPay(path: string, json: any): Answer {
    if (path === '/v1/rent') {
      if (json.offerId !== OFFER) return { status: 404, body: { error: 'not_found' } };
      const leaseId = hex();
      const paidThrough = this.clock.t + HOUR;
      this.leases.set(leaseId, { state: 'running', paidIntervals: 1, paidThrough });
      for (const h of this.homes.values()) if (h.offerId === json.offerId) h.leaseId = leaseId;
      return { status: 200, body: { leaseId, state: 'running', paidIntervals: 1, paidThrough }, paid: 7000n };
    }
    const m = /^\/v1\/leases\/([0-9a-f]{32})\/ticks$/.exec(path);
    const l = m ? this.leases.get(m[1]!) : undefined;
    if (!m || !l) return { status: 404, body: { error: 'not_found' } };
    if (l.state !== 'running') return { status: 409, body: { error: 'not_running' } };
    if (json.index < l.paidIntervals) return { status: 409, body: { error: 'duplicate' } };
    if (json.index !== l.paidIntervals) return { status: 409, body: { error: 'out_of_order', expected: l.paidIntervals } };
    l.paidIntervals++;
    l.paidThrough += HOUR;
    return { status: 200, body: { paidIntervals: l.paidIntervals, paidThrough: l.paidThrough }, paid: 7000n };
  }

  async fund(method: 'GET' | 'POST' | 'PUT', path: string, json?: any): Promise<Answer> {
    const o = this.onFund?.(method, path, json);
    if (o) return o;
    if (method === 'GET' && path === '/v1/biller/allowances') {
      return { status: 200, body: { allowances: [...this.allowances.values()].filter((a) => LIVE_STATES.includes(a.state)).map((a) => structuredClone(a)) } };
    }
    const one = /^\/v1\/biller\/allowances\/([0-9a-f]{32})$/.exec(path);
    if (method === 'POST' && one) {
      const a = this.allowances.get(one[1]!);
      if (!a) return { status: 404, body: { error: 'not_found' } };
      if (json.state !== undefined && json.state !== a.state && !ALLOWED_MOVES[a.state as AllowanceState].includes(json.state)) {
        this.posts.push({ id: one[1]!, json, status: 409 });
        return { status: 409, body: { error: 'bad_move' } };
      }
      this.posts.push({ id: one[1]!, json, status: 200 });
      Object.assign(a, json);
      return { status: 200, body: structuredClone(a) };
    }
    const h = /^\/v1\/biller\/homes\/([0-9a-f]{16})$/.exec(path);
    if (method === 'GET' && h) {
      const home = this.homes.get(h[1]!);
      return { status: 200, body: home ?? { leaseId: null, offerId: null, hostKnown: false, grantLive: false } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }
}

/** The chain as the biller sees it: one permission's period, a revoke flag, and every call in order. */
class FakeChain implements Chain {
  spender = SPENDER;
  calls: string[] = [];
  revoked = false;
  allowance = 5_208_000n;
  spent = 0n;
  periodEndsAt = T0 + 20 * DAY;
  canPullAnswer?: Awaited<ReturnType<Chain['canPull']>>;
  /** The pull lands on chain but its answer is lost. */
  pullLostAnswer = false;
  /** The pull is broadcast but still pending: nothing on chain yet, and its answer is lost. */
  pullPending = false;
  expired = false;
  savedAtSend: string[] = [];

  constructor(readonly saved: { s: string }) {}

  async status(_p: SignedPermission) {
    this.calls.push('status');
    const left = this.allowance > this.spent ? this.allowance - this.spent : 0n;
    return { isRevoked: this.revoked, isExpired: this.expired, remainingMicro: left, periodSpentMicro: this.spent, periodEndsAt: this.periodEndsAt };
  }

  async canPull(_p: SignedPermission, micro: bigint) {
    this.calls.push(`canPull:${micro}`);
    return this.canPullAnswer ?? { ok: true as const };
  }

  async pull(_p: SignedPermission, micro: bigint) {
    this.calls.push(`pull:${micro}`);
    this.savedAtSend.push(this.saved.s);
    if (this.pullPending) throw new Error('receipt wait timed out');
    this.spent += micro;
    if (this.pullLostAnswer) throw new Error('receipt wait timed out');
    return { tx: '0xpull' };
  }

  async revoke(_p: SignedPermission) {
    this.calls.push('revoke');
    this.revoked = true;
    return { tx: '0xrevoke' };
  }

  async refund(to: string, micro: bigint) {
    this.calls.push(`refund:${to}:${micro}`);
    this.savedAtSend.push(this.saved.s);
    return { tx: '0xrefund' };
  }

  async usdc() {
    return 10_000_000n;
  }

  async eth() {
    return 10n ** 15n;
  }

  sends(): string[] {
    return this.calls.filter((c) => /^(pull|revoke|refund)/.test(c));
  }
}

function rig() {
  const clock = { t: T0 };
  const saved = { s: '' };
  const door = new FakeDoor(clock, saved);
  const chain = new FakeChain(saved);
  const state: AllowState = { version: 1, entries: {} };
  const problems: Array<{ key: string; msg: string }> = [];
  const stops = new Set<string>();
  const deps: BillerDeps = {
    door,
    chain,
    state,
    save: () => void (saved.s = JSON.stringify(state)),
    now: () => clock.t,
    problem: (key, msg) => void problems.push({ key, msg }),
    stops,
  };
  const run = () => cycle(deps);
  const credit = (id: string) => state.entries[id]?.creditMicro;
  return { clock, door, chain, state, problems, stops, run, credit, saved };
}

// ---- pullNeed ----

test('pullNeed', () => {
  assert.equal(pullNeed(0n, 7000n, 5208000n), 168000n);
  assert.equal(pullNeed(7000n, 7000n, 5208000n), 0n);
  assert.equal(pullNeed(7000n, 7000n, 0n), 0n);
  assert.equal(pullNeed(3000n, 7000n, 5208000n), 165000n);
  assert.equal(pullNeed(0n, 7000n, 50000n), 50000n);
  assert.equal(pullNeed(0n, 7000n, 6999n), 0n);
});

// ---- approval ----

test('activates an approved allowance it can pull from', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'approved' });
  await r.run();
  assert.equal(r.door.stateOf(id), 'active');
  assert.equal(r.door.a(id).account, ACCOUNT);
  assert.equal(r.door.a(id).remainingMicro, '5208000');
  assert.equal(r.door.a(id).periodEndsAt, T0 + 20 * DAY);
  assert.deepEqual(r.chain.calls, ['status', 'canPull:7000']);
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.pays.length, 0);
  assert.deepEqual(r.problems, []);
});

test('refuses one the contract will not take', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'approved' });
  r.chain.canPullAnswer = { ok: false, why: 'invalid', detail: 'approveWithSignature reverted 0x1234' };
  await r.run();
  assert.equal(r.door.stateOf(id), 'refused');
  assert.match(r.door.a(id).reason, /approveWithSignature reverted 0x1234/);
  assert.deepEqual(r.chain.sends(), []);
});

test('an approved allowance whose account is short is active then short, and kept', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'approved' });
  r.chain.canPullAnswer = { ok: false, why: 'short', detail: 'account holds 0' };
  await r.run();
  assert.deepEqual(r.door.posts.map((p) => p.json.state).filter(Boolean), ['active', 'short']);
  assert.equal(r.door.stateOf(id), 'short');
  assert.equal(r.state.entries[id]?.nextTryAt, T0 + SHORT_RETRY_MS);
});

test('a revoke seen on an approved allowance refuses it as cancelled before activation', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'approved' });
  r.chain.revoked = true;
  await r.run();
  assert.equal(r.door.stateOf(id), 'refused');
  assert.equal(r.door.a(id).reason, 'cancelled before activation');
  assert.equal(r.door.a(id).endReason, undefined);
  assert.deepEqual(r.chain.sends(), []);
});

test('an operator stop on an approved allowance goes stopping then ended', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'approved' });
  r.stops.add(id);
  await r.run();
  assert.deepEqual(r.door.posts.map((p) => [p.json.state, p.status]), [['stopping', 200], ['ended', 200]]);
  assert.equal(r.door.a(id).endReason, 'operator');
  assert.deepEqual(r.chain.sends(), ['revoke']);
});

test('ignores a waiting allowance', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'waiting', signed: undefined });
  r.stops.add(id);
  await r.run();
  assert.deepEqual(r.chain.calls, []);
  assert.equal(r.door.posts.length, 0);
  assert.equal(r.door.pays.length, 0);
});

// ---- paying ----

test('goes short without sending', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.chain.canPullAnswer = { ok: false, why: 'short', detail: 'account holds 100' };
  await r.run();
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.door.stateOf(id), 'short');
  assert.equal(r.state.entries[id]?.nextTryAt, T0 + SHORT_RETRY_MS);
  // Within the hour nothing is tried again; after it, the pull is checked again.
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.chain.calls.filter((c) => c.startsWith('canPull')).length, 1);
  r.chain.canPullAnswer = undefined;
  r.clock.t = T0 + SHORT_RETRY_MS + 1;
  await r.run();
  assert.equal(r.door.stateOf(id), 'active');
  assert.equal(r.door.tickPays().length, 1);
});

test('pulls a day of ticks then pays the due tick', async () => {
  const r = rig();
  const { id, leaseId } = r.door.home();
  await r.run();
  assert.deepEqual(r.chain.sends(), ['pull:168000']);
  assert.deepEqual(r.door.tickPays().map((p) => [p.path, p.json.index, p.status]), [[`/v1/leases/${leaseId}/ticks`, 3, 200]]);
  assert.equal(r.credit(id), '161000');
  const a = r.door.a(id);
  assert.equal(a.state, 'active');
  assert.equal(a.lastPullTx, '0xpull');
  assert.equal(a.remainingMicro, '5040000');
  assert.equal(a.hoursPaid, 1);
  assert.equal(a.creditMicro, '161000');
  // The pull and the tick were each sent only after the state that records them was saved.
  assert.equal(JSON.parse(r.chain.savedAtSend[0]!).entries[id].pullInFlight.micro, '168000');
  assert.deepEqual(JSON.parse(r.door.savedAtPay[0]!).entries[id].tickInFlight, { leaseId, index: 3, micro: '7000' });
  assert.equal(r.state.entries[id]?.pullInFlight, undefined);
  assert.equal(r.state.entries[id]?.tickInFlight, undefined);
});

test('pays from credit without pulling', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  await r.run();
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.tickPays().length, 1);
  assert.equal(r.credit(id), '7000');
});

test('does not pay a tick that is not due', async () => {
  const r = rig();
  const { id } = r.door.home({}, { paidThrough: T0 + 50 * 60_000 });
  await r.run();
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.credit(id), '0');
});

test('does not pay while a grant is live', async () => {
  const r = rig();
  const { homeId } = r.door.home();
  r.door.homes.get(homeId)!.grantLive = true;
  await r.run();
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.door.gets.length, 0);
});

test('keeps credit on out_of_order', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.onPay = (path) => (path.endsWith('/ticks') ? { status: 409, body: { error: 'out_of_order', expected: 4 } } : undefined);
  await r.run();
  assert.equal(r.door.tickPays().length, 1);
  assert.equal(r.credit(id), '14000');
  assert.equal(r.door.a(id).hoursPaid, 0);
  assert.equal(r.state.entries[id]?.tickInFlight, undefined);
});

test('keeps credit on duplicate and on a refused tick', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.onPay = () => ({ status: 409, body: { error: 'duplicate' } });
  await r.run();
  assert.equal(r.credit(id), '14000');
  r.door.onPay = () => ({ status: 402, body: { error: 'settlement_failed' } });
  r.clock.t += 10 * 60_000;
  await r.run();
  assert.equal(r.credit(id), '14000');
  assert.ok(r.problems.some((p) => /402/.test(p.msg)));
});

test('reconciles a pull whose answer was lost', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.chain.pullLostAnswer = true;
  await r.run();
  assert.deepEqual(r.chain.sends(), ['pull:168000']);
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.state.entries[id]?.pullInFlight?.micro, '168000');
  assert.equal(r.credit(id), '0');
  assert.ok(r.problems.length > 0);
  // The pull landed: the next cycle sees the period's spend grown by it, counts it, and pulls nothing more.
  r.chain.pullLostAnswer = false;
  r.clock.t += 60_000;
  await r.run();
  assert.deepEqual(r.chain.sends(), ['pull:168000']);
  assert.equal(r.state.entries[id]?.pullInFlight, undefined);
  assert.equal(r.door.tickPays().length, 1);
  assert.equal(r.credit(id), '161000');
});

test('a pull that never landed is waited for, then not counted', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '0', pullInFlight: { micro: '168000', at: T0 - 60_000, periodEndsAt: T0 + 20 * DAY }, periodSpentSeen: '0' };
  r.chain.canPullAnswer = { ok: false, why: 'short', detail: 'account holds 0' };
  // It may still be pending: nothing else is tried for this allowance.
  await r.run();
  assert.deepEqual(r.chain.calls, ['status']);
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.state.entries[id]?.pullInFlight?.micro, '168000');
  r.clock.t = T0 + 11 * 60_000;
  await r.run();
  assert.equal(r.credit(id), '0');
  assert.equal(r.state.entries[id]?.pullInFlight, undefined);
  assert.deepEqual(r.chain.sends(), []);
});

test('a pull lost across a period reset is not guessed at', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '0', pullInFlight: { micro: '168000', at: T0 - 60_000, periodEndsAt: T0 - 1 }, periodSpentSeen: '5000000' };
  await r.run();
  assert.ok(r.problems.some((p) => /period has reset/.test(p.msg)));
  assert.equal(r.state.entries[id]?.pullInFlight, undefined);
});

test('a pull that certainly sent nothing is dropped at once', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.chain.pull = async () => {
    throw new NotSent('not enough ETH for gas');
  };
  await r.run();
  assert.equal(r.state.entries[id]?.pullInFlight, undefined);
  assert.equal(r.credit(id), '0');
  assert.equal(r.door.pays.length, 0);
});

test('a tick whose answer was lost is counted once the host shows it', async () => {
  const r = rig();
  const { id, leaseId } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.onPay = (path) => {
    if (!path.endsWith('/ticks')) return undefined;
    const l = r.door.leases.get(leaseId)!;
    l.paidIntervals++;
    l.paidThrough += HOUR;
    throw new Error('timeout');
  };
  await r.run();
  assert.equal(r.credit(id), '14000');
  assert.deepEqual(r.state.entries[id]?.tickInFlight, { leaseId, index: 3, micro: '7000' });
  r.door.onPay = undefined;
  r.clock.t += 10 * 60_000;
  await r.run();
  assert.equal(r.credit(id), '7000');
  assert.equal(r.state.entries[id]?.tickInFlight, undefined);
  assert.equal(r.door.a(id).hoursPaid, 1);
  // That hour is paid through T0 + 70 min, so nothing more is due yet.
  assert.equal(r.door.tickPays().length, 1);
});

test('spent_for_period when the permission has less than a tick left', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.chain.spent = 5_208_000n - 6_999n;
  await r.run();
  assert.equal(r.door.stateOf(id), 'spent_for_period');
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.pays.length, 0);
  // Not posted again every cycle.
  const posts = r.door.posts.length;
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.door.posts.length, posts);
  // A new period: it pulls and is active again.
  r.chain.spent = 0n;
  r.clock.t += 10 * 60_000;
  await r.run();
  assert.equal(r.door.stateOf(id), 'active');
  assert.deepEqual(r.chain.sends(), ['pull:168000']);
});

// ---- ending ----

test('stop revokes then refunds credit', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'stopping' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '161000' };
  await r.run();
  assert.deepEqual(r.chain.sends(), ['revoke', `refund:${ACCOUNT}:161000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'stopped');
  assert.equal(r.door.a(id).creditMicro, '0');
  assert.equal(r.credit(id), '0');
  assert.equal(r.door.pays.length, 0);
  // The refund went out only after the state recorded it as in flight.
  assert.equal(JSON.parse(r.chain.savedAtSend[0]!).entries[id].refundInFlight.micro, '161000');
  // Nothing is sent again on the next cycle.
  await r.run();
  assert.deepEqual(r.chain.sends(), ['revoke', `refund:${ACCOUNT}:161000`]);
});

test('an operator stop on an active allowance ends it as operator', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '7000' };
  r.stops.add(id);
  await r.run();
  assert.deepEqual(r.chain.sends(), ['revoke', `refund:${ACCOUNT}:7000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'operator');
  assert.equal(r.door.pays.length, 0);
});

test('a stop with no credit revokes and refunds nothing', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'stopping' });
  r.chain.revoked = true;
  await r.run();
  assert.deepEqual(r.chain.sends(), []);
  assert.equal(r.door.stateOf(id), 'ended');
});

test('a refund whose answer was lost is never sent again', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'stopping' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '161000' };
  r.chain.refund = async (to, micro) => {
    r.chain.calls.push(`refund:${to}:${micro}`);
    throw new Error('receipt wait timed out');
  };
  await r.run();
  await r.run();
  assert.equal(r.chain.calls.filter((c) => c.startsWith('refund')).length, 1);
  assert.equal(r.door.stateOf(id), 'stopping');
  assert.ok(r.problems.some((p) => /refund/.test(p.msg) && /161000/.test(p.msg)));
});

test('a refund that was never sent is tried again', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'stopping' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '161000' };
  const real = r.chain.refund.bind(r.chain);
  let first = true;
  r.chain.refund = async (to, micro) => {
    if (first) {
      first = false;
      throw new NotSent('not enough ETH for gas');
    }
    return real(to, micro);
  };
  await r.run();
  assert.equal(r.door.stateOf(id), 'stopping');
  await r.run();
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.chain.calls.filter((c) => c.startsWith('refund')).length, 1);
  assert.equal(r.credit(id), '0');
});

test('a revoke seen on chain ends it as cancelled and refunds', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '21000' };
  r.chain.revoked = true;
  await r.run();
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:21000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'cancelled');
  assert.equal(r.door.pays.length, 0);
});

test('a lost pull is counted before an end refunds', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'stopping' });
  r.chain.spent = 168000n;
  r.state.entries[id] = { allowanceId: id, creditMicro: '0', pullInFlight: { micro: '168000', at: T0 - 60_000 }, periodSpentSeen: '0' };
  await r.run();
  assert.deepEqual(r.chain.sends(), ['revoke', `refund:${ACCOUNT}:168000`]);
});

test('ends as home_gone when the door no longer knows the host', async () => {
  const r = rig();
  const { id, homeId } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '7000' };
  r.door.homes.get(homeId)!.hostKnown = false;
  await r.run();
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:7000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'home_gone');
});

// ---- re-opening ----

test('re-opens a closed home on its own offer only', async () => {
  const r = rig();
  const { id, homeId, leaseId } = r.door.home({}, { state: 'closed' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  await r.run();
  const rents = r.door.pays.filter((p) => p.path === '/v1/rent');
  assert.deepEqual(rents.map((p) => p.json), [{ offerId: OFFER, home: { sshKeys: KEYS, image: 'charter-home' } }]);
  assert.equal(r.credit(id), '7000');
  const newLease = r.door.homes.get(homeId)!.leaseId!;
  assert.notEqual(newLease, leaseId);
  assert.equal(r.door.a(id).leaseId, newLease);
  assert.equal(r.door.a(id).hoursPaid, 1);
  assert.equal(r.state.entries[id]?.lapsedSince, undefined);
  assert.deepEqual(JSON.parse(r.door.savedAtPay[0]!).entries[id].openInFlight.offerId, OFFER);
});

test('a re-open pulls first when credit is short of a tick', async () => {
  const r = rig();
  const { id } = r.door.home({}, { state: 'closed' });
  await r.run();
  assert.deepEqual(r.chain.sends(), ['pull:168000']);
  assert.equal(r.door.pays.filter((p) => p.path === '/v1/rent').length, 1);
  assert.equal(r.credit(id), '161000');
});

test('never re-opens on another offer', async () => {
  const r = rig();
  const { id, homeId } = r.door.home({}, { state: 'closed' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.homes.get(homeId)!.offerId = null;
  await r.run();
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.credit(id), '14000');
});

test('ends as home_gone on 409 home_host_gone', async () => {
  const r = rig();
  const { id } = r.door.home({}, { state: 'closed' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.onPay = (path) => (path === '/v1/rent' ? { status: 409, body: { error: 'home_host_gone' } } : undefined);
  await r.run();
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:14000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'home_gone');
});

test('ends as home_gone after 7 days lapsed', async () => {
  const r = rig();
  const { id } = r.door.home({ state: 'spent_for_period' }, { state: 'closed' });
  r.chain.spent = 5_208_000n;
  r.state.entries[id] = { allowanceId: id, creditMicro: '3000' };
  await r.run();
  assert.equal(r.state.entries[id]?.lapsedSince, T0);
  assert.equal(r.door.stateOf(id), 'spent_for_period');
  r.clock.t = T0 + LAPSE_END_MS;
  await r.run();
  assert.equal(r.door.stateOf(id), 'spent_for_period');
  r.clock.t = T0 + LAPSE_END_MS + 60_000;
  await r.run();
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:3000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'home_gone');
  assert.equal(r.door.pays.length, 0);
});

// ---- isolation ----

test('one allowance throwing does not stop the next', async () => {
  const r = rig();
  const first = r.door.home();
  const second = r.door.home();
  r.door.onFund = (method, path) => (method === 'GET' && path === `/v1/biller/homes/${first.homeId}` ? (() => { throw new Error('boom'); })() : undefined);
  await r.run();
  assert.ok(r.problems.some((p) => /boom/.test(p.msg)));
  assert.equal(r.door.tickPays().length, 1);
  assert.equal(r.door.tickPays()[0]!.path, `/v1/leases/${second.leaseId}/ticks`);
  assert.equal(r.credit(second.id), '161000');
});

test('an allowance whose spender is not this biller is not touched', async () => {
  const r = rig();
  const s = signed();
  s.permission.spender = '0x5555555555555555555555555555555555555555';
  const { id } = r.door.home({ signed: s });
  await r.run();
  assert.deepEqual(r.chain.calls, []);
  assert.equal(r.door.stateOf(id), 'active');
  assert.ok(r.problems.length > 0);
});

// ---- the state file ----

test('the state file is 0600 and an unreadable one throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allow-state-'));
  const file = join(dir, 'state.json');
  assert.deepEqual(loadState(file), { version: 1, entries: {} });
  const k = hex();
  const s: AllowState = { version: 1, entries: { [k]: { allowanceId: k, creditMicro: '7000' } } };
  saveState(file, s);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadState(file), s);
  writeFileSync(file, '{not json');
  assert.throws(() => loadState(file), /refusing to start fresh/);
  writeFileSync(file, JSON.stringify({ version: 1, entries: { a: { allowanceId: 'a', creditMicro: '-5' } } }));
  assert.throws(() => loadState(file), /refusing to start fresh/);
});

// ---- fix round 1 ----

test('a pull that lands after it was given up is still credited', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.chain.pullPending = true;
  await r.run();
  assert.equal(r.state.entries[id]?.pullInFlight?.micro, '168000');
  // Ten minutes on the first pull is still not on chain: it is given up and a second pull goes out.
  r.chain.pullPending = false;
  r.clock.t = T0 + 11 * 60_000;
  await r.run();
  assert.deepEqual(r.chain.sends(), ['pull:168000', 'pull:168000']);
  assert.equal(r.credit(id), '161000');
  // Then the first one lands after all: it left the account, so it is the allowance's credit.
  r.chain.spent += 168000n;
  r.clock.t += 60_000;
  await r.run();
  assert.equal(r.credit(id), '329000');
  assert.deepEqual(r.chain.sends(), ['pull:168000', 'pull:168000']);
  assert.equal(r.door.a(id).creditMicro, '329000');
});

test('pulls nothing in the last minutes of a period', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.chain.periodEndsAt = T0 + 2 * 60_000;
  await r.run();
  assert.deepEqual(r.chain.calls.filter((c) => !c.startsWith('status')), []);
  assert.equal(r.door.pays.length, 0);
  assert.equal(r.credit(id), '0');
});

test('an end decided by home_host_gone is remembered after a lost refund', async () => {
  const r = rig();
  const { id } = r.door.home({}, { state: 'closed' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.onPay = (path) => (path === '/v1/rent' ? { status: 409, body: { error: 'home_host_gone' } } : undefined);
  r.chain.refund = async (to, micro) => {
    r.chain.calls.push(`refund:${to}:${micro}`);
    throw new Error('receipt wait timed out');
  };
  await r.run();
  // The door would now take a re-open: the biller still opens, pulls and pays nothing more.
  r.door.onPay = undefined;
  for (let i = 0; i < 3; i++) {
    r.clock.t += 10 * 60_000;
    await r.run();
  }
  assert.equal(r.door.pays.length, 1);
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:14000`]);
  assert.equal(r.state.entries[id]?.ending?.endReason, 'home_gone');
  assert.ok(r.problems.some((p) => /refund/.test(p.msg) && /14000/.test(p.msg)));
});

test('an end decided by home_host_gone is remembered after a failed ended post', async () => {
  const r = rig();
  const { id } = r.door.home({}, { state: 'closed' });
  r.state.entries[id] = { allowanceId: id, creditMicro: '14000' };
  r.door.onPay = (path) => (path === '/v1/rent' ? { status: 409, body: { error: 'home_host_gone' } } : undefined);
  r.door.onFund = (method, _path, json) => (method === 'POST' && json?.state === 'ended' ? { status: 503, body: { error: 'down' } } : undefined);
  await r.run();
  assert.equal(r.door.stateOf(id), 'active');
  assert.equal(r.credit(id), '0');
  r.door.onPay = undefined;
  r.door.onFund = undefined;
  r.clock.t += 10 * 60_000;
  await r.run();
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'home_gone');
  assert.equal(r.door.pays.length, 1);
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:14000`]);
});

test('an expired permission ends the allowance and refunds', async () => {
  const r = rig();
  const { id } = r.door.home();
  r.state.entries[id] = { allowanceId: id, creditMicro: '21000' };
  r.chain.expired = true;
  await r.run();
  assert.deepEqual(r.chain.sends(), [`refund:${ACCOUNT}:21000`]);
  assert.equal(r.door.stateOf(id), 'ended');
  assert.equal(r.door.a(id).endReason, 'cancelled');
  assert.equal(r.door.pays.length, 0);
  const r2 = rig();
  const two = r2.door.home({ state: 'approved' });
  r2.chain.expired = true;
  await r2.run();
  assert.equal(r2.door.stateOf(two.id), 'refused');
  assert.deepEqual(r2.chain.sends(), []);
});

test('inForce: a permission is in force from its start until its end', () => {
  const p = signed();
  p.permission.start = 1000;
  p.permission.end = 2000;
  assert.equal(inForce(p, 999), false);
  assert.equal(inForce(p, 1000), true);
  assert.equal(inForce(p, 1999), true);
  assert.equal(inForce(p, 2000), false);
});
