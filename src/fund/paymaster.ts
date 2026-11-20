// The grant fund's paymaster: one pass over the grants, run every 60 s. It judges one queued pitch,
// opens the oldest approved grant when a home slot is free and the pot covers it, and pays each granted
// home one hour at a time for 720 hours, within a day cap. Everything it spends goes through
// `door.pay`; every id it puts in a path is checked first; one bad grant never stops the others.
import type { GrantState } from '../door/grants.js';
import type { Answer, DoorClient } from './door-client.js';
import type { PitchIn, Verdict } from './judge.js';
import type { DoorPatch, FundGrant, FundState } from './state.js';

/** A grant is this many hours of a home. */
export const GRANT_HOURS = 720;
/** The most the fund pays for one tick, in micro-USDC (the door client's signing cap is the same). */
export const MAX_TICK_MICRO = 10_000n;
/** After a refused open or tick, the grant is left alone this long. */
export const BACKOFF_MS = 5 * 60_000;
/** An approved grant that waited this long for a slot expires. */
export const WAIT_MS = 14 * 86_400_000;
/** After hour 720 the lease is read this long, only to see whether the grantee renews. */
export const WATCH_MS = 7 * 86_400_000;
/** The longest the fund goes without reading a live lease. */
const READ_EVERY_MS = 3_600_000;
export const HOME_USED_REASON = 'This home has had a grant before.';

const ID = /^[0-9a-f]{32}$/;
const IMAGES = ['charter-home', 'charter-hermes'];
const MAX_KEYS = 8;

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);
const errOf = (a: Answer): string => (isObj(a.body) && typeof a.body.error === 'string' ? a.body.error.slice(0, 64) : 'no error field');
const short = (id: string): string => id.slice(0, 8);

// ---- the pure checks ----

/** Balance covers (hours left on every live grant + 720 for a new one) x tick x 1.1. A count that is not a number is read as a full month. */
export function commitmentOk(balance: bigint, live: { hoursLeft: number }[], tick: bigint): boolean {
  if (tick <= 0n) return false;
  let hours = BigInt(GRANT_HOURS);
  for (const g of live) {
    const h = Number.isFinite(g.hoursLeft) ? Math.min(GRANT_HOURS, Math.max(0, Math.ceil(g.hoursLeft))) : GRANT_HOURS;
    hours += BigInt(h);
  }
  return balance * 10n >= hours * tick * 11n;
}

/** Spend today plus `cost` stays within live grants x 24 x tick x 1.5. No live grant or no price: no spend. */
export function dayCapOk(spentToday: bigint, live: number, tick: bigint, cost: bigint): boolean {
  if (!Number.isSafeInteger(live) || live <= 0 || tick <= 0n || cost < 0n) return false;
  return (spentToday + cost) * 2n <= BigInt(live) * 24n * tick * 3n;
}

/** A running lease's next tick is due half an interval before its paid time runs out, never earlier. */
export function tickDue(lease: { state: string; paidThrough?: number }, intervalSeconds: number, now: number): boolean {
  if (lease.state !== 'running') return false;
  if (typeof lease.paidThrough !== 'number' || !Number.isFinite(lease.paidThrough)) return false;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return false;
  return lease.paidThrough - (intervalSeconds * 1000) / 2 <= now;
}

// ---- what the door says ----

interface Offer { offerId: string; images: string[]; intervalSeconds: number; tick: bigint; free: number }

/** A tick price the fund will pay: a decimal string, more than 0, at most MAX_TICK_MICRO. */
function priceOf(x: unknown): bigint | undefined {
  if (typeof x !== 'string' || !/^\d{1,12}$/.test(x)) return undefined;
  const p = BigInt(x);
  return p > 0n && p <= MAX_TICK_MICRO ? p : undefined;
}

function readOffer(o: unknown): Offer | undefined {
  if (!isObj(o) || typeof o.offerId !== 'string' || o.offerId.length < 1 || o.offerId.length > 256) return undefined;
  if (!Array.isArray(o.images) || !Number.isSafeInteger(o.intervalSeconds) || o.intervalSeconds <= 0) return undefined;
  const tick = priceOf(o.tickPrice);
  if (tick === undefined) return undefined;
  const free = isObj(o.home) && Number.isSafeInteger(o.home.free) ? (o.home.free as number) : 0;
  return { offerId: o.offerId, images: o.images.filter((i: unknown) => typeof i === 'string'), intervalSeconds: o.intervalSeconds, tick, free };
}

/**
 * What a `POST /v1/rent` answer means for the fund. `retry` is true when an earlier open of the same
 * grant got no answer (its `opening` marker was still set):
 * - `opened`: 200, a lease is open and its first hour paid.
 * - `lost`: no answer (network error or the client's timeout); the door may still have opened and settled.
 * - `held`: `home_in_use` after an unanswered open: that open may be the running home. Nothing more is paid.
 * - `in_use`: `home_in_use` on a first try: another home with these keys is running.
 * - `refused`: a definite refusal; nothing of this grant's runs on that host.
 * - `refused_still_unknown`: a door-level refusal of a retry (it never reached the host), so the earlier
 *   unanswered open is still unknown.
 */
type RentOutcome = 'opened' | 'lost' | 'held' | 'in_use' | 'refused' | 'refused_still_unknown';

function rentOutcome(a: Answer | Error, retry: boolean): RentOutcome {
  if (a instanceof Error) return 'lost';
  if (a.status === 200) return 'opened';
  const body = isObj(a.body) ? a.body : {};
  if (body.error === 'home_in_use' || body.closedReason === 'home_in_use') return retry ? 'held' : 'in_use';
  // A `closedReason` means the host itself answered the open, after its home_in_use check passed.
  if (!retry || typeof body.closedReason === 'string') return 'refused';
  return 'refused_still_unknown';
}

/** A grant as `GET /v1/fund/grants` lists it, with only what the paymaster reads. */
interface DoorGrant { grantId: string; state: string; image?: unknown; sshKeys?: unknown; decidedAt?: unknown; createdAt?: unknown }

function homeOf(g: DoorGrant): { sshKeys: string[]; image: string } | undefined {
  const keys = g.sshKeys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS) return undefined;
  if (!keys.every((k) => typeof k === 'string' && k.length > 0 && k.length <= 16_384)) return undefined;
  if (typeof g.image !== 'string' || !IMAGES.includes(g.image)) return undefined;
  return { sshKeys: [...keys], image: g.image };
}

/** When the grant was approved (or made, failing that); Infinity when the door gave neither. */
function approvedAt(g: DoorGrant): number {
  if (typeof g.decidedAt === 'number' && Number.isFinite(g.decidedAt)) return g.decidedAt;
  if (typeof g.createdAt === 'number' && Number.isFinite(g.createdAt)) return g.createdAt;
  return Infinity;
}

// ---- judging ----

/**
 * Judges the oldest queued pitch and posts the verdict. A home (key set) that already has a grant past
 * `queued` (other than declined) is declined with a fixed reason and no model call. Any error leaves the
 * pitch queued and is thrown for the cycle to record.
 */
export function makeJudgeOne(d: {
  door: DoorClient;
  judge: (p: PitchIn, ctx: { live: number; slots: number }) => Promise<Verdict>;
  slots: () => Promise<number>;
}): () => Promise<void> {
  return async () => {
    const q = await d.door.fund('GET', '/v1/fund/queue');
    if (q.status !== 200 || !isObj(q.body)) throw new Error(`GET /v1/fund/queue answered ${q.status}`);
    const p = q.body.grant;
    if (p === null || p === undefined) return;
    if (!isObj(p) || typeof p.grantId !== 'string' || !ID.test(p.grantId)) throw new Error('the queue answered a grant id that is not 32 hex characters; not judged');
    if (typeof p.homeId !== 'string' || p.homeId.length === 0) throw new Error(`queued grant ${short(p.grantId)} has no homeId; not judged`);
    if (typeof p.name !== 'string' || typeof p.pitch !== 'string' || typeof p.image !== 'string') throw new Error(`queued grant ${short(p.grantId)} is missing name, pitch or image; not judged`);

    const all = await d.door.fund('GET', '/v1/fund/grants');
    if (all.status !== 200 || !isObj(all.body) || !Array.isArray(all.body.grants)) throw new Error(`GET /v1/fund/grants answered ${all.status}`);
    const used = all.body.grants.some(
      (g: unknown) => isObj(g) && g.grantId !== p.grantId && g.homeId === p.homeId && g.state !== 'queued' && g.state !== 'declined',
    );

    let verdict: { state: GrantState; summary?: string; reason: string };
    if (used) {
      verdict = { state: 'declined', reason: HOME_USED_REASON };
    } else {
      const pitch: PitchIn = { name: p.name, ...(typeof p.link === 'string' ? { link: p.link } : {}), image: p.image, pitch: p.pitch };
      const live = isCount(q.body.live) ? q.body.live : 0;
      const v = await d.judge(pitch, { live, slots: await d.slots() });
      verdict = { state: v.decision === 'grant' ? 'approved_waiting' : 'declined', summary: v.summary, reason: v.reason };
    }
    const r = await d.door.fund('POST', `/v1/fund/grants/${p.grantId}`, verdict);
    if (r.status !== 200) throw new Error(`posting the verdict for grant ${short(p.grantId)} answered ${r.status} ${errOf(r)}`);
  };
}

// ---- the cycle ----

export interface CycleDeps {
  door: DoorClient;
  /** The fund's own wallet address, for the public report `PUT /v1/fund/public` takes. */
  address: string;
  balance: () => Promise<bigint>;
  now: () => number;
  state: FundState;
  save: () => void;
  problem: (key: string, msg: string) => void;
  judgeOne: () => Promise<void>;
}

/** One pass. Never throws: every failure is a `problem` and the pass goes on with the next grant. */
export async function cycle(d: CycleDeps): Promise<void> {
  await new Pass(d).run();
}

class Pass {
  private readonly t: number;
  private offersP?: Promise<Offer[] | undefined>;
  private balanceP?: Promise<bigint | undefined>;

  constructor(private readonly d: CycleDeps) {
    this.t = d.now();
  }

  private get s(): FundState {
    return this.d.state;
  }

  private problem(key: string, msg: string): void {
    try {
      this.d.problem(key, msg);
    } catch {
      // a broken reporter must not stop the pass
    }
  }

  private async safe(key: string, f: () => Promise<void>, about = ''): Promise<void> {
    try {
      await f();
    } catch (e) {
      this.problem(key, `${about}${errText(e)}`);
    }
  }

  async run(): Promise<void> {
    for (const g of Object.values(this.s.grants)) if (g.pending) await this.safe('door', () => this.flush(g), `grant ${short(g.grantId)}: `);
    if (this.s.stopAll) await this.safe('intake', () => this.closeIntake());
    else await this.safe('judge', () => this.d.judgeOne());
    const waiting = await this.list('approved_waiting');
    const active = await this.list('active');
    await this.safe('stop', () => this.stops(waiting, active));
    for (const g of this.live()) await this.safe('lease', () => this.tend(g), `grant ${short(g.grantId)}: `);
    for (const a of active ?? []) {
      if (!this.s.grants[a.grantId]) this.problem('grant', `grant ${a.grantId} is active at the door but the fund has no record of it; not paying it`);
    }
    if (waiting) {
      await this.safe('expire', () => this.expire(waiting));
      if (!this.s.stopAll) await this.safe('open', () => this.openOldest(waiting));
    }
    for (const g of Object.values(this.s.grants)) {
      if (g.watchUntil !== undefined && g.watchUntil > this.t && !g.renewedByGrantee) await this.safe('lease', () => this.watch(g), `grant ${short(g.grantId)}: `);
    }
    for (const g of Object.values(this.s.grants)) {
      if (g.openUnknown !== undefined && g.endedAt === undefined) this.heldProblem(g);
    }
  }

  private heldProblem(g: FundGrant): void {
    const when = new Date(g.opening?.at ?? g.openUnknown!).toISOString();
    this.problem(
      'open-unknown',
      `grant ${g.grantId}: an open on offer ${g.opening?.offerId ?? 'unknown'} at ${when} got no answer, and the host now says a home with these keys is running. The fund may have paid for it and pays nothing more for this grant. Drew: look at the grant and stop it.`,
    );
  }

  // -- local records --

  /** Grants with a lease the fund is paying for: opened, not ended, not completed. */
  private live(): FundGrant[] {
    return Object.values(this.s.grants).filter((g) => g.leaseId !== undefined && g.endedAt === undefined && g.watchUntil === undefined);
  }

  private record(id: string): FundGrant {
    const g: FundGrant = { grantId: id, fundTicks: 0, reopened: false };
    this.s.grants[id] = g;
    return g;
  }

  private mayPay(g: FundGrant): boolean {
    return (
      !this.s.stopAll &&
      !this.s.stopped.includes(g.grantId) &&
      g.endedAt === undefined &&
      g.watchUntil === undefined &&
      g.openUnknown === undefined &&
      g.fundTicks < GRANT_HOURS
    );
  }

  private rollDay(): void {
    const day = new Date(this.t).toISOString().slice(0, 10);
    if (this.s.spend.day !== day) this.s.spend = { day, micro: '0' };
  }

  private spent(): bigint {
    this.rollDay();
    return BigInt(this.s.spend.micro);
  }

  private addSpend(price: bigint): void {
    this.s.spend.micro = (this.spent() + price).toString();
  }

  // -- the door's grant log --

  /** Queues `patch` for the door, saves, and sends it. A failed send is sent again next cycle. */
  private async change(g: FundGrant, patch: DoorPatch): Promise<void> {
    g.pending = { ...g.pending, ...patch };
    this.d.save();
    await this.safe('door', () => this.flush(g), `grant ${short(g.grantId)}: `);
  }

  private async flush(g: FundGrant): Promise<void> {
    const patch = g.pending;
    if (!patch) return;
    if (!ID.test(g.grantId)) {
      delete g.pending;
      this.d.save();
      return this.problem('door', 'a fund record has a grant id that is not 32 hex characters; its update is dropped');
    }
    const a = await this.d.door.fund('POST', `/v1/fund/grants/${g.grantId}`, patch);
    if (a.status === 200) {
      delete g.pending;
      this.d.save();
      return;
    }
    if (a.status === 400 || a.status === 404 || a.status === 409) {
      // Sending it again would get the same answer.
      delete g.pending;
      this.d.save();
      return this.problem('door', `the door refused update ${JSON.stringify(patch)} for grant ${g.grantId}: ${a.status} ${errOf(a)}; dropped`);
    }
    this.problem('door', `the door answered ${a.status} to an update for grant ${g.grantId}; sending it again next cycle`);
  }

  private async list(state: GrantState): Promise<DoorGrant[] | undefined> {
    let a: Answer;
    try {
      a = await this.d.door.fund('GET', `/v1/fund/grants?state=${state}`);
    } catch (e) {
      this.problem('grants', `listing ${state} grants: ${errText(e)}`);
      return undefined;
    }
    if (a.status !== 200 || !isObj(a.body) || !Array.isArray(a.body.grants)) {
      this.problem('grants', `listing ${state} grants answered ${a.status}`);
      return undefined;
    }
    const out: DoorGrant[] = [];
    for (const g of a.body.grants as unknown[]) {
      if (!isObj(g) || g.state !== state) continue;
      if (typeof g.grantId !== 'string' || !ID.test(g.grantId)) {
        this.problem('grants', `the door listed a ${state} grant whose id is not 32 hex characters; skipped`);
        continue;
      }
      out.push(g as DoorGrant);
    }
    return out;
  }

  private async closeIntake(): Promise<void> {
    const bal = await this.balance();
    if (bal === undefined) return;
    const a = await this.d.door.fund('PUT', '/v1/fund/public', { address: this.d.address, balanceMicro: bal.toString(), grantsLeft: 0, open: false });
    if (a.status !== 200) this.problem('intake', `closing intake answered ${a.status} ${errOf(a)}`);
  }

  private balance(): Promise<bigint | undefined> {
    this.balanceP ??= this.d.balance().then(
      (b) => {
        if (typeof b === 'bigint' && b >= 0n) return b;
        this.problem('balance', 'the balance read is not a whole number of micro-USDC');
        return undefined;
      },
      (e) => {
        this.problem('balance', `the balance read failed: ${errText(e)}`);
        return undefined;
      },
    );
    return this.balanceP;
  }

  private offers(): Promise<Offer[] | undefined> {
    this.offersP ??= (async () => {
      let a: Answer;
      try {
        a = await this.d.door.get('/v1/offers');
      } catch (e) {
        this.problem('offers', `GET /v1/offers: ${errText(e)}`);
        return undefined;
      }
      const list = Array.isArray(a.body) ? a.body : isObj(a.body) && Array.isArray(a.body.offers) ? a.body.offers : undefined;
      if (a.status !== 200 || !list) {
        this.problem('offers', `GET /v1/offers answered ${a.status}`);
        return undefined;
      }
      return list.map(readOffer).filter((o: Offer | undefined): o is Offer => o !== undefined);
    })();
    return this.offersP;
  }

  // -- stops and expiry --

  private async stops(waiting: DoorGrant[] | undefined, active: DoorGrant[] | undefined): Promise<void> {
    const listed = new Set([...(waiting ?? []), ...(active ?? [])].map((g) => g.grantId));
    const ids = new Set<string>();
    if (this.s.stopAll) {
      for (const id of listed) ids.add(id);
      for (const g of Object.values(this.s.grants)) if (g.endedAt === undefined && g.watchUntil === undefined) ids.add(g.grantId);
    } else {
      for (const id of this.s.stopped) ids.add(id);
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !ID.test(id)) {
        this.problem('stop', 'the stop list holds an id that is not 32 hex characters; ignored');
        continue;
      }
      const rec = this.s.grants[id];
      if (rec && (rec.endedAt !== undefined || rec.watchUntil !== undefined)) continue;
      // A stop for a grant still queued (or unknown) waits until the door shows it approved.
      if (!rec && !listed.has(id)) continue;
      await this.end(rec ?? this.record(id), 'stopped');
    }
  }

  private async end(g: FundGrant, state: 'ended_early' | 'stopped' | 'expired'): Promise<void> {
    g.endedAt = this.t;
    delete g.backoffUntil;
    delete g.nextReadAt;
    await this.change(g, { state });
  }

  private async expire(waiting: DoorGrant[]): Promise<void> {
    for (const w of waiting) {
      const rec = this.s.grants[w.grantId];
      if (rec && (rec.leaseId !== undefined || rec.endedAt !== undefined || rec.watchUntil !== undefined || rec.openUnknown !== undefined)) continue;
      if (this.t - approvedAt(w) > WAIT_MS) await this.end(rec ?? this.record(w.grantId), 'expired');
    }
  }

  // -- money --

  /** Counts one paid hour: the grant's count, the lease's count, the day's spend; completes at 720. */
  private async counted(g: FundGrant, price: bigint, extra: DoorPatch): Promise<void> {
    g.fundTicks += 1;
    g.leaseTicks = (g.leaseTicks ?? 0) + 1;
    g.lastPaidAt = this.t;
    delete g.backoffUntil;
    this.addSpend(price);
    const patch: DoorPatch = { ...extra, paidHours: g.fundTicks };
    if (g.fundTicks >= GRANT_HOURS) {
      g.watchUntil = this.t + WATCH_MS;
      g.nextReadAt = this.t + READ_EVERY_MS;
      patch.state = 'completed';
    }
    await this.change(g, patch);
  }

  /** The next lease read: when the next tick comes due, and at least once an hour. */
  private readAgainAt(g: FundGrant, paidThrough: unknown, intervalSeconds: number): void {
    g.nextReadAt =
      typeof paidThrough === 'number' && Number.isFinite(paidThrough)
        ? Math.min(paidThrough - (intervalSeconds * 1000) / 2, this.t + READ_EVERY_MS)
        : this.t;
  }

  private backOff(g: FundGrant): void {
    g.backoffUntil = this.t + BACKOFF_MS;
    this.d.save();
  }

  /** `POST /v1/rent` for `g`'s home on `offer`. Answers the door's answer, or the error a request threw. */
  private async rent(g: FundGrant, offer: Offer, home: { sshKeys: string[]; image: string }): Promise<Answer | Error> {
    try {
      return await this.d.door.pay('/v1/rent', { offerId: offer.offerId, home: { sshKeys: home.sshKeys, image: home.image } });
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  /** A paid open whose answer carries no usable lease id: the hour is counted as spent, the grant ends. */
  private async paidUnusable(g: FundGrant, price: bigint): Promise<void> {
    delete g.opening;
    g.fundTicks += 1;
    g.lastPaidAt = this.t;
    this.addSpend(price);
    g.endedAt = this.t;
    this.problem('open', `grant ${g.grantId}: the door took payment for an open but answered no usable lease id; ending the grant`);
    await this.change(g, { state: 'ended_early', paidHours: g.fundTicks });
  }

  private async openOldest(waiting: DoorGrant[]): Promise<void> {
    const ready = waiting
      .filter((w) => {
        const rec = this.s.grants[w.grantId];
        return !rec || (rec.leaseId === undefined && rec.endedAt === undefined && rec.watchUntil === undefined && rec.openUnknown === undefined);
      })
      .filter((w) => !this.s.stopped.includes(w.grantId))
      .sort((a, b) => approvedAt(a) - approvedAt(b));
    const w = ready[0];
    if (!w) return;
    const rec0 = this.s.grants[w.grantId];
    if ((rec0?.backoffUntil ?? 0) > this.t) return;
    const home = homeOf(w);
    if (!home) return this.problem('open', `grant ${w.grantId} has no usable keys or image; not opening it`);
    const offers = await this.offers();
    if (!offers) return;
    // After an unanswered open, only the same offer: its host refuses a second home on these keys.
    // That retry does not need a free slot, since the host checks home_in_use before it counts slots.
    const pinned = rec0?.opening;
    const offer = pinned
      ? offers.find((o) => o.offerId === pinned.offerId && o.images.includes(home.image))
      : offers.find((o) => o.free > 0 && o.images.includes(home.image));
    if (!offer) {
      if (pinned) this.problem('open', `grant ${short(w.grantId)}: an earlier open on offer ${pinned.offerId} got no answer and that offer is not listed now; waiting for it, not opening anywhere else`);
      return;
    }
    const bal = await this.balance();
    if (bal === undefined) return;
    const live = this.live();
    if (!commitmentOk(bal, live.map((g) => ({ hoursLeft: GRANT_HOURS - g.fundTicks })), offer.tick)) {
      return this.problem('commitment', `the balance (${bal} micro-USDC) cannot cover grant ${short(w.grantId)} on top of ${live.length} live; it waits`);
    }
    if (!dayCapOk(this.spent(), live.length + 1, offer.tick, offer.tick)) {
      return this.problem('daycap', `the day cap leaves no room to open grant ${short(w.grantId)} today`);
    }

    const g = rec0 ?? this.record(w.grantId);
    g.home = home;
    // Saved before the request: an answer lost to a timeout or a crash leaves this marker behind.
    g.opening = { offerId: offer.offerId, at: pinned?.at ?? this.t };
    this.d.save();
    const a = await this.rent(g, offer, home);
    switch (rentOutcome(a, pinned !== undefined)) {
      case 'opened': {
        const ok = a as Answer;
        delete g.opening;
        offer.free -= 1;
        const leaseId = isObj(ok.body) ? ok.body.leaseId : undefined;
        if (typeof leaseId !== 'string' || !ID.test(leaseId)) return this.paidUnusable(g, offer.tick);
        g.leaseId = leaseId;
        g.leaseTicks = 0;
        this.readAgainAt(g, ok.body.paidThrough, offer.intervalSeconds);
        return this.counted(g, offer.tick, { state: 'active', leaseId });
      }
      case 'lost':
        this.backOff(g);
        return this.problem('open', `grant ${short(g.grantId)}: the open on offer ${offer.offerId} got no answer (${errText(a)}); trying that offer again in 5 minutes`);
      case 'held':
        g.openUnknown = this.t;
        this.d.save();
        return this.heldProblem(g);
      case 'in_use':
        delete g.opening;
        this.problem('open', `grant ${short(g.grantId)}: a home with these keys is already running; the grant ends`);
        return this.end(g, 'ended_early');
      case 'refused':
        delete g.opening;
        this.backOff(g);
        return this.problem('open', `grant ${short(g.grantId)}: the open answered ${(a as Answer).status} ${errOf(a as Answer)}; trying again in 5 minutes`);
      case 'refused_still_unknown':
        this.backOff(g);
        return this.problem('open', `grant ${short(g.grantId)}: the retry answered ${(a as Answer).status} ${errOf(a as Answer)}; the earlier open is still unknown, trying offer ${offer.offerId} again in 5 minutes`);
    }
  }

  /** Reads a live grant's lease (when a read is due), then re-opens it, ends it, or pays its next hour. */
  private async tend(g: FundGrant): Promise<void> {
    if (!this.mayPay(g)) return;
    if ((g.backoffUntil ?? 0) > this.t) return;
    if ((g.nextReadAt ?? 0) > this.t) return;
    const leaseId = g.leaseId!;
    if (!ID.test(leaseId)) return this.problem('lease', `grant ${g.grantId} holds a lease id that is not 32 hex characters; not paying it`);

    const r = await this.d.door.get(`/v1/leases/${leaseId}`);
    const lease = isObj(r.body) ? r.body.lease : undefined;
    if (r.status !== 200 || !isObj(lease) || !isCount(lease.paidIntervals) || typeof lease.state !== 'string') {
      g.nextReadAt = this.t + BACKOFF_MS;
      return this.problem('lease', `grant ${short(g.grantId)}: reading lease ${short(leaseId)} answered ${r.status}`);
    }
    const paid = lease.paidIntervals;

    // A tick sent last time whose answer never came: the host's count says whether it was paid.
    if (g.inflight) {
      const f = g.inflight;
      delete g.inflight;
      if (f.leaseId === leaseId && paid > f.index) await this.counted(g, BigInt(f.price), {});
      else this.d.save();
      if (!this.mayPay(g)) return;
    }

    if (paid > (g.leaseTicks ?? g.fundTicks) && !g.renewedByGrantee) {
      g.renewedByGrantee = true;
      await this.change(g, { renewedByGrantee: true });
    }

    if (lease.state === 'closed' || lease.state === 'done') {
      // A re-open whose answer was lost is tried again on its offer; otherwise the second close ends it.
      if (g.reopened && g.opening === undefined) return this.end(g, 'ended_early');
      return this.reopen(g, r.body.offer);
    }
    if (r.body.stopped === true) {
      g.nextReadAt = this.t + BACKOFF_MS;
      return this.problem('tick', `grant ${short(g.grantId)}: the door stopped lease ${short(leaseId)}; no tick until it closes and re-opens`);
    }
    const offer = readOffer(r.body.offer);
    if (!offer) {
      g.nextReadAt = this.t + BACKOFF_MS;
      return this.problem('price', `grant ${short(g.grantId)}: lease ${short(leaseId)} has no usable tick price; nothing paid`);
    }
    if (!tickDue(lease as { state: string; paidThrough?: number }, offer.intervalSeconds, this.t)) {
      this.readAgainAt(g, lease.paidThrough, offer.intervalSeconds);
      this.d.save();
      return;
    }
    if (!dayCapOk(this.spent(), this.live().length, offer.tick, offer.tick)) {
      g.nextReadAt = this.t + BACKOFF_MS;
      return this.problem('daycap', `grant ${short(g.grantId)}: the day cap is reached; tick ${paid} not paid`);
    }
    await this.payTick(g, leaseId, paid, offer);
  }

  private async payTick(g: FundGrant, leaseId: string, index: number, offer: Offer): Promise<void> {
    if (!this.mayPay(g)) return;
    // Saved before the request: if the answer is lost, the next read of the host's count settles it.
    g.inflight = { leaseId, index, price: offer.tick.toString() };
    this.d.save();
    let a: Answer;
    try {
      a = await this.d.door.pay(`/v1/leases/${leaseId}/ticks`, { index });
    } catch (e) {
      this.backOff(g);
      return this.problem('tick', `grant ${short(g.grantId)} tick ${index}: no answer (${errText(e)}); the host's count decides at the next read, in 5 minutes`);
    }
    delete g.inflight;
    if (a.status === 200) {
      this.readAgainAt(g, isObj(a.body) ? a.body.paidThrough : undefined, offer.intervalSeconds);
      return this.counted(g, offer.tick, {});
    }
    if (a.status === 409 && isObj(a.body) && a.body.error === 'duplicate') {
      this.d.save();
      return;
    }
    this.backOff(g);
    this.problem('tick', `grant ${short(g.grantId)} tick ${index} answered ${a.status} ${errOf(a)}; trying again in 5 minutes`);
  }

  /**
   * The one re-open a grant gets after its lease closes, with the same keys. A definite refusal ends the
   * grant; a lost answer is tried again on the same offer only, as an open is.
   */
  private async reopen(g: FundGrant, leaseOffer: unknown): Promise<void> {
    if (!this.mayPay(g)) return;
    const home = g.home;
    if (!home) {
      this.problem('open', `grant ${g.grantId}: its lease closed and the fund has no keys on record to re-open it; ending the grant`);
      return this.end(g, 'ended_early');
    }
    const offers = await this.offers();
    if (!offers) return;
    const pinned = g.opening;
    let offer: Offer | undefined;
    if (pinned) {
      offer = offers.find((o) => o.offerId === pinned.offerId && o.images.includes(home.image));
    } else {
      const fits = offers.filter((o) => o.free > 0 && o.images.includes(home.image));
      const same = isObj(leaseOffer) ? leaseOffer.offerId : undefined;
      offer = fits.find((o) => o.offerId === same) ?? fits[0];
    }
    if (!offer) {
      g.nextReadAt = this.t + BACKOFF_MS;
      return this.problem(
        'open',
        pinned
          ? `grant ${short(g.grantId)}: an earlier re-open on offer ${pinned.offerId} got no answer and that offer is not listed now; waiting for it, not opening anywhere else`
          : `grant ${short(g.grantId)}: its lease closed and no offer has a free home slot; waiting to re-open`,
      );
    }
    if (!dayCapOk(this.spent(), this.live().length, offer.tick, offer.tick)) {
      g.nextReadAt = this.t + BACKOFF_MS;
      return this.problem('daycap', `grant ${short(g.grantId)}: the day cap leaves no room to re-open today`);
    }
    // Saved before the request: a crash or a lost answer can never lead to a re-open somewhere else.
    g.reopened = true;
    g.opening = { offerId: offer.offerId, at: pinned?.at ?? this.t };
    this.d.save();
    const a = await this.rent(g, offer, home);
    switch (rentOutcome(a, pinned !== undefined)) {
      case 'opened': {
        const ok = a as Answer;
        delete g.opening;
        offer.free -= 1;
        const leaseId = isObj(ok.body) ? ok.body.leaseId : undefined;
        if (typeof leaseId !== 'string' || !ID.test(leaseId)) return this.paidUnusable(g, offer.tick);
        g.leaseId = leaseId;
        g.leaseTicks = 0;
        this.readAgainAt(g, ok.body.paidThrough, offer.intervalSeconds);
        return this.counted(g, offer.tick, { leaseId });
      }
      case 'lost':
        this.backOff(g);
        return this.problem('open', `grant ${short(g.grantId)}: the re-open on offer ${offer.offerId} got no answer (${errText(a)}); trying that offer again in 5 minutes`);
      case 'held':
        g.openUnknown = this.t;
        this.d.save();
        return this.heldProblem(g);
      case 'refused_still_unknown':
        this.backOff(g);
        return this.problem('open', `grant ${short(g.grantId)}: the re-open retry answered ${(a as Answer).status} ${errOf(a as Answer)}; the earlier re-open is still unknown, trying offer ${offer.offerId} again in 5 minutes`);
      case 'in_use':
      case 'refused': {
        delete g.opening;
        const r = a as Answer;
        this.problem('open', `grant ${short(g.grantId)}: the re-open answered ${r.status} ${errOf(r)}; ending the grant`);
        return this.end(g, 'ended_early');
      }
    }
  }

  /** After completion: read the lease about once an hour, only to see whether the grantee renewed. */
  private async watch(g: FundGrant): Promise<void> {
    if ((g.nextReadAt ?? 0) > this.t || !g.leaseId || !ID.test(g.leaseId)) return;
    g.nextReadAt = this.t + READ_EVERY_MS;
    const r = await this.d.door.get(`/v1/leases/${g.leaseId}`);
    const lease = isObj(r.body) ? r.body.lease : undefined;
    if (r.status !== 200 || !isObj(lease) || !isCount(lease.paidIntervals)) {
      this.d.save();
      return this.problem('lease', `grant ${short(g.grantId)}: reading lease ${short(g.leaseId)} after completion answered ${r.status}`);
    }
    if (lease.paidIntervals > (g.leaseTicks ?? g.fundTicks)) {
      g.renewedByGrantee = true;
      return this.change(g, { renewedByGrantee: true });
    }
    this.d.save();
  }
}
