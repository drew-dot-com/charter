// The allowance biller: one pass over the live allowances, run every 60 s. For each one a person approved,
// it pulls USDC from their account with the spend permission (about a day of ticks at a time) and pays the
// home's hourly tick through the door, exactly as the grant fund's paymaster does. It never opens a fresh
// home or names another host's offer, it pays nothing while a grant pays the home, and when an allowance
// ends it revokes the permission and sends the unspent credit back to the account.
//
// Crash safety: every send (pull, tick, re-open, refund) is recorded in the state file before it goes out,
// and a send whose answer was lost is settled from what the chain or the host shows, never sent again blind.
// One allowance's error is a problem and the pass goes on with the next.
import { permissionKey, type AllowanceState, type EndReason, type SignedPermission } from '../door/allowances.js';
import { BASE_USDC, type Answer, type DoorClient } from '../fund/door-client.js';
import { MAX_TICK_MICRO, tickDue } from '../fund/paymaster.js';
import { NotSent, Unencodable, type Chain } from './chain.js';
import type { AllowEntry, AllowState, Ending } from './state.js';

/** A pull is at most this many ticks, less the credit already held. */
export const PULL_TICKS = 24n;
/** A home whose lease stayed closed this long ends its allowance. */
export const LAPSE_END_MS = 7 * 86_400_000;
/** After the account was short, the next pull is tried this much later. */
export const SHORT_RETRY_MS = 3_600_000;
/** After a refused tick or re-open, the lease is left alone this long. */
export const BACKOFF_MS = 5 * 60_000;
/** A pull with no answer whose spend the chain does not show yet is waited for this long, then dropped. */
export const PULL_SETTLE_MS = 10 * 60_000;
/**
 * No pull starts this close to the end of the permission's period, so a pull never lands in a period other
 * than the one it was booked to (a pull's receipt wait is 2 minutes).
 */
export const PERIOD_EDGE_MS = 5 * 60_000;
/** The longest the biller goes without reading a running lease. */
const READ_EVERY_MS = 3_600_000;
/** A tick or re-open with no answer whose lease or home cannot be read is dropped (booked as spent) after this. */
export const IN_FLIGHT_GIVE_UP_MS = 3_600_000;
/** The door record's reason while the home's price is above what the person approved. */
export const PRICE_ROSE = 'price rose above what was approved';
/** The operator's commands, run on the box. */
const CMD = 'docker exec charter-allow node dist/allow/main.js';

const ID = /^[0-9a-f]{32}$/;
const HOME_ID = /^[0-9a-f]{16}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const IMAGES = ['charter-home', 'charter-hermes'];
/** The states the biller acts on. `waiting` has no permission yet; the rest are over. */
const HANDLED: AllowanceState[] = ['approved', 'active', 'short', 'spent_for_period', 'stopping'];

const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);
const errOf = (a: Answer): string => (isObj(a.body) && typeof a.body.error === 'string' ? a.body.error.slice(0, 64) : 'no error field');
const short = (id: string): string => id.slice(0, 8);

/** A tick price the biller will pay: a decimal string, more than 0, at most MAX_TICK_MICRO. */
export function billablePrice(x: unknown): bigint | undefined {
  if (typeof x !== 'string' || !/^\d{1,12}$/.test(x)) return undefined;
  const p = BigInt(x);
  return p > 0n && p <= MAX_TICK_MICRO ? p : undefined;
}

/**
 * What to pull so the credit covers a tick: nothing when it already does; else up to PULL_TICKS ticks less
 * the credit, capped by what the permission has left this period; nothing when that cap leaves less than
 * the one tick needed.
 */
export function pullNeed(creditMicro: bigint, tickMicro: bigint, remainingMicro: bigint): bigint {
  if (creditMicro >= tickMicro) return 0n;
  const want = PULL_TICKS * tickMicro - creditMicro;
  const need = want < remainingMicro ? want : remainingMicro;
  return need < tickMicro - creditMicro ? 0n : need;
}

export interface BillerDeps {
  door: DoorClient;
  chain: Chain;
  state: AllowState;
  save(): void;
  now(): number;
  problem(key: string, msg: string): void;
  /** Allowance ids Drew stopped by hand (stops.json). */
  stops: Set<string>;
}

/** One pass. Never throws: every failure is a `problem` and the pass goes on with the next allowance. */
export async function cycle(d: BillerDeps): Promise<void> {
  const problem = (key: string, msg: string) => {
    try {
      d.problem(key, msg);
    } catch {
      // a broken reporter must not stop the pass
    }
  };
  let a: Answer;
  try {
    a = await d.door.fund('GET', '/v1/biller/allowances');
  } catch (e) {
    return problem('door', `listing allowances: ${errText(e)}`);
  }
  if (a.status !== 200 || !isObj(a.body) || !Array.isArray(a.body.allowances)) return problem('door', `listing allowances answered ${a.status}`);
  // People approve the address the door names. A biller holding another key could never pull from them, and
  // what it did would not match what they approved: it does nothing until the two agree.
  const named = a.body.spender;
  if (typeof named !== 'string' || named.toLowerCase() !== d.chain.spender.toLowerCase()) {
    return problem('spender_mismatch', `the door names ${typeof named === 'string' ? named.slice(0, 42) : 'no'} spender (CHARTER_ALLOW_ADDRESS) but this biller's key is ${d.chain.spender}; nothing done. Set CHARTER_ALLOW_ADDRESS to the biller's address, or mount the right key (docs/ops.md, Allowances).`);
  }
  // One permission on chain held by two allowances would book each one's pulls to both: act on neither.
  const holders = new Map<string, number>();
  const keyOf = (raw: unknown): string | undefined => {
    const q = isObj(raw) && HANDLED.includes(raw.state) && isObj(raw.signed) && isObj(raw.signed.permission) ? raw.signed.permission : undefined;
    return q && typeof q.account === 'string' && typeof q.salt === 'string' ? permissionKey(q.account, q.salt) : undefined;
  };
  for (const raw of a.body.allowances as unknown[]) {
    const k = keyOf(raw);
    if (k) holders.set(k, (holders.get(k) ?? 0) + 1);
  }
  for (const raw of a.body.allowances as unknown[]) {
    if (!isObj(raw) || typeof raw.allowanceId !== 'string' || !ID.test(raw.allowanceId)) {
      problem('allowance', 'the door listed an allowance whose id is not 32 hex characters; skipped');
      continue;
    }
    if (!HANDLED.includes(raw.state)) continue;
    const k = keyOf(raw);
    if (k && (holders.get(k) ?? 0) > 1) {
      problem('allowance', `allowance ${raw.allowanceId} carries the same permission as another live allowance; neither is acted on. Drew: look at both with \`${CMD} status\` and end the wrong one with \`${CMD} stop <allowanceId>\` (docs/ops.md, Allowances).`);
      continue;
    }
    try {
      await new One(d, raw as DoorAllowance, problem).run();
    } catch (e) {
      problem('allowance', `allowance ${short(raw.allowanceId)}: ${errText(e)}`);
    }
  }
}

/** An allowance as `GET /v1/biller/allowances` lists it, after the checks in `One.valid`. */
interface DoorAllowance {
  allowanceId: string;
  state: AllowanceState;
  homeId: string;
  sshKeys: string[];
  image: string;
  tickMicro: string;
  signed: SignedPermission;
  hoursPaid: number;
  [k: string]: unknown;
}

interface Home { leaseId: string | null; offerId: string | null; hostKnown: boolean; grantLive: boolean }

type Status = Awaited<ReturnType<Chain['status']>>;

/** One allowance's turn in a pass. */
class One {
  private readonly t: number;
  private readonly id: string;
  private e!: AllowEntry;
  /** Hours paid, counted here and posted to the door's record (which `post` compares against). */
  private hours = 0;

  constructor(
    private readonly d: BillerDeps,
    private readonly a: DoorAllowance,
    private readonly problem: (key: string, msg: string) => void,
  ) {
    this.t = d.now();
    this.id = a.allowanceId;
  }

  private get p(): SignedPermission {
    return this.a.signed;
  }

  private get credit(): bigint {
    return BigInt(this.e.creditMicro);
  }

  private save(): void {
    this.d.save();
  }

  /** Why the door's record cannot be acted on, or undefined when it can. */
  private invalid(): string | undefined {
    const a = this.a as Record<string, any>;
    if (typeof a.homeId !== 'string' || !HOME_ID.test(a.homeId)) return 'its homeId is not 16 hex characters';
    const s = a.signed;
    if (!isObj(s) || !isObj(s.permission)) return 'it holds no signed permission';
    const q = s.permission;
    if (typeof q.account !== 'string' || !ADDRESS.test(q.account)) return 'its permission names no account';
    if (typeof q.spender !== 'string' || q.spender.toLowerCase() !== this.d.chain.spender.toLowerCase()) return 'its permission names a spender that is not this biller';
    if (typeof q.token !== 'string' || q.token.toLowerCase() !== BASE_USDC.toLowerCase()) return 'its permission is not for USDC on Base';
    if (!Array.isArray(a.sshKeys) || a.sshKeys.length < 1 || a.sshKeys.length > 8 || !a.sshKeys.every((k: unknown) => typeof k === 'string' && k.length > 0)) return 'it has no usable keys';
    if (typeof a.image !== 'string' || !IMAGES.includes(a.image)) return 'it has no usable image';
    this.hours = isCount(a.hoursPaid) ? a.hoursPaid : 0;
    return undefined;
  }

  async run(): Promise<void> {
    const bad = this.invalid();
    if (bad) return this.problem('allowance', `allowance ${this.id}: ${bad}; not acted on`);
    this.e = this.d.state.entries[this.id] ??= { allowanceId: this.id, creditMicro: '0' };

    let st: Status;
    try {
      st = await this.d.chain.status(this.p);
    } catch (e) {
      if (e instanceof Unencodable) return this.unusable(errText(e));
      throw e;
    }
    this.settlePull(st);
    if (this.e.pullInFlight) {
      return this.problem('pull', `allowance ${short(this.id)}: a pull of ${this.e.pullInFlight.micro} micro-USDC sent without an answer is not on chain yet; nothing more until it is, or until ${PULL_SETTLE_MS / 60_000} minutes pass`);
    }
    const stopping = this.a.state === 'stopping';
    // An end is pending: a send whose answer was lost and cannot be read back is given up rather than holding
    // the end up (a dead host or an exhausted read budget would otherwise wedge the stop for good).
    const endPending = this.e.ending !== undefined || stopping || this.d.stops.has(this.id) || st.isRevoked || st.isExpired;
    await this.settleTick(endPending);
    await this.settleOpen(endPending);
    // An end already decided: finish it, and pay, open or pull nothing more.
    if (this.e.ending) return this.finish(this.e.ending, st);

    if (stopping || this.d.stops.has(this.id)) return this.stop(st, stopping ? 'stopped' : 'operator');
    if (st.isRevoked || st.isExpired) return this.cancelled(st);
    // Signed with a start still ahead of this box's clock: wait for it, refuse nothing.
    if (st.notYet) return;
    if (this.a.state === 'approved') return this.activate(st);
    return this.tend(st);
  }

  /**
   * The permission cannot be encoded for the contract, so it can never pull, revoke or be read: an approved
   * one is refused, any other ends (no revoke is possible or needed; any credit is refunded).
   */
  private async unusable(why: string): Promise<void> {
    const st: Status = { isRevoked: false, isExpired: true, notYet: false, remainingMicro: 0n, periodSpentMicro: 0n, periodEndsAt: this.t };
    if (this.e.ending) return this.finish(this.e.ending, st);
    if (this.a.state === 'approved') return this.finish({ state: 'refused', endReason: 'cancelled', reason: why }, st);
    const stopping = this.a.state === 'stopping';
    const endReason: EndReason = stopping ? 'stopped' : 'operator';
    if (!stopping && !this.d.stops.has(this.id)) this.problem('allowance', `allowance ${this.id}: ${why}; ended as operator`);
    return this.finish({ state: 'ended', endReason }, st);
  }

  // ---- the door's record ----

  /** Posts the fields of `patch` that differ from the door's record. False when the door did not take it. */
  private async post(patch: Record<string, unknown>): Promise<boolean> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && this.a[k] !== v) out[k] = v;
    if (Object.keys(out).length === 0) return true;
    let r: Answer;
    try {
      r = await this.d.door.fund('POST', `/v1/biller/allowances/${this.id}`, out);
    } catch (e) {
      this.problem('door', `allowance ${short(this.id)}: posting ${Object.keys(out).join(', ')}: ${errText(e)}; sent again next cycle`);
      return false;
    }
    if (r.status !== 200) {
      this.problem('door', `allowance ${short(this.id)}: posting ${JSON.stringify(out)} answered ${r.status} ${errOf(r)}`);
      return false;
    }
    Object.assign(this.a, out);
    return true;
  }

  private async home(): Promise<Home> {
    const r = await this.d.door.fund('GET', `/v1/biller/homes/${this.a.homeId}`);
    const b = r.body;
    if (r.status !== 200 || !isObj(b) || typeof b.hostKnown !== 'boolean' || typeof b.grantLive !== 'boolean') {
      throw new Error(`reading home ${this.a.homeId} answered ${r.status}`);
    }
    return {
      leaseId: typeof b.leaseId === 'string' && ID.test(b.leaseId) ? b.leaseId : null,
      offerId: typeof b.offerId === 'string' && b.offerId.length > 0 && b.offerId.length <= 256 ? b.offerId : null,
      hostKnown: b.hostKnown,
      grantLive: b.grantLive,
    };
  }

  private async readLease(leaseId: string): Promise<{ lease: Record<string, any>; body: Record<string, any> }> {
    const r = await this.d.door.get(`/v1/leases/${leaseId}`);
    const lease = isObj(r.body) ? r.body.lease : undefined;
    if (r.status !== 200 || !isObj(lease) || !isCount(lease.paidIntervals) || typeof lease.state !== 'string') {
      throw new Error(`reading lease ${short(leaseId)} answered ${r.status}`);
    }
    return { lease, body: r.body };
  }

  // ---- money held ----

  /** Takes a paid tick or open out of the credit. */
  private spend(micro: bigint): void {
    const c = this.credit;
    if (micro > c) this.problem('credit', `allowance ${short(this.id)}: paid ${micro} micro-USDC with only ${c} in credit; credit set to 0`);
    this.e.creditMicro = (micro > c ? 0n : c - micro).toString();
  }

  /**
   * Books every pull the chain shows: any spend this period above what was booked is a pull that landed
   * unbooked (its answer lost, or given up and landed later), and goes to credit.
   */
  private book(st: Status): void {
    const e = this.e;
    const f = e.pullInFlight;
    const before = JSON.stringify([e.creditMicro, e.periodPulled]);
    let pp = e.periodPulled ?? { periodEndsAt: f?.periodEndsAt ?? st.periodEndsAt, micro: f ? (e.periodSpentSeen ?? '0') : st.periodSpentMicro.toString() };
    if (pp.periodEndsAt !== st.periodEndsAt) pp = { periodEndsAt: st.periodEndsAt, micro: '0' };
    const landed = st.periodSpentMicro - BigInt(pp.micro);
    if (landed > 0n) {
      e.creditMicro = (this.credit + landed).toString();
      pp = { ...pp, micro: st.periodSpentMicro.toString() };
    }
    e.periodPulled = pp;
    if (JSON.stringify([e.creditMicro, e.periodPulled]) !== before) this.save();
  }

  /** Books what the chain shows, then settles the record of a pull sent last time whose answer never came. */
  private settlePull(st: Status): void {
    this.book(st);
    const e = this.e;
    const f = e.pullInFlight;
    if (!f) return;

    const micro = BigInt(f.micro);
    const sentThisPeriod = f.periodEndsAt === undefined || f.periodEndsAt === st.periodEndsAt;
    if (sentThisPeriod) {
      const seen = BigInt(e.periodSpentSeen ?? '0');
      // Not on chain yet and young: it may still be pending, so nothing else is sent for this allowance.
      if (st.periodSpentMicro - seen < micro && this.t - f.at < PULL_SETTLE_MS) return;
      // Landed (booked above) or given up: if it lands later, the period's spend books it then.
    } else if (st.periodSpentMicro < micro) {
      this.problem(
        'pull',
        `allowance ${this.id}: a pull of ${micro} micro-USDC sent at ${new Date(f.at).toISOString()} got no answer and the permission's period has reset since; if it landed before the reset the chain's period spend cannot show it. Drew: look for that spend from ${this.p.permission.account}; if it landed, stop the container (docker compose stop charter-allow), add it to this allowance's creditMicro in data/state.json, then start it again (docs/ops.md, Allowances).`,
      );
    }
    delete e.pullInFlight;
    delete e.periodSpentSeen;
    this.save();
  }

  /**
   * A send with no answer whose lease or home cannot be read. Kept (and the error thrown, so it is a problem
   * this cycle) while it is young and no end is pending; otherwise dropped and booked as spent, so an end
   * is never held up by a host that will not answer: the person bears at most this one tick, never the pool.
   */
  private unreadable(what: 'tick' | 'open', micro: string, at: number | undefined, endPending: boolean, e: unknown): boolean {
    if (!endPending && (at === undefined || this.t - at < IN_FLIGHT_GIVE_UP_MS)) throw e;
    this.spend(BigInt(micro));
    if (what === 'tick') delete this.e.tickInFlight;
    else delete this.e.openInFlight;
    this.save();
    this.problem(what, `allowance ${short(this.id)}: a ${what} of ${micro} micro-USDC got no answer and cannot be checked (${errText(e)}); booked as spent${endPending ? ' so the end can finish' : ' after an hour'}`);
    return true;
  }

  /** A tick sent last time whose answer never came: counted once the host's count passed its index. */
  private async settleTick(endPending: boolean): Promise<void> {
    const f = this.e.tickInFlight;
    if (!f) return;
    if (ID.test(f.leaseId)) {
      let lease: Record<string, any>;
      try {
        ({ lease } = await this.readLease(f.leaseId));
      } catch (e) {
        if (this.unreadable('tick', f.micro, f.at, endPending, e)) await this.post({ creditMicro: this.e.creditMicro });
        return;
      }
      if (lease.paidIntervals > f.index) {
        this.spend(BigInt(f.micro));
        this.hours += 1;
        delete this.e.tickInFlight;
        this.save();
        await this.post({ hoursPaid: this.hours, creditMicro: this.e.creditMicro });
        return;
      }
    }
    delete this.e.tickInFlight;
    this.save();
  }

  /** A re-open sent last time whose answer never came: counted when the home's newest lease is a new, paid one. */
  private async settleOpen(endPending: boolean): Promise<void> {
    const f = this.e.openInFlight;
    if (!f) return;
    let h: Home;
    let lease: Record<string, any> | undefined;
    try {
      h = await this.home();
      if (h.leaseId !== null && h.leaseId !== f.prevLeaseId) ({ lease } = await this.readLease(h.leaseId));
    } catch (e) {
      if (this.unreadable('open', f.micro, f.at, endPending, e)) await this.post({ creditMicro: this.e.creditMicro });
      return;
    }
    if (lease && lease.paidIntervals >= 1) {
      this.spend(BigInt(f.micro));
      this.hours += 1;
      delete this.e.lapsedSince;
      delete this.e.openInFlight;
      this.save();
      await this.post({ leaseId: h.leaseId, hoursPaid: this.hours, creditMicro: this.e.creditMicro });
      return;
    }
    delete this.e.openInFlight;
    this.save();
  }

  /**
   * Sends the credit back to the permission's account, then posts `patch` (an end). A refund whose answer
   * was lost is never sent again; one that certainly sent nothing (NotSent) is tried again next cycle.
   */
  private async finish(decided: Ending, st: Status): Promise<void> {
    // Recorded before anything is sent: whatever is lost from here, later cycles only finish this end.
    if (!this.e.ending) {
      this.e.ending = decided;
      this.save();
    }
    const ending = this.e.ending;
    const r = this.e.refundInFlight;
    if (r) {
      return this.problem(
        'refund',
        `allowance ${this.id}: a refund of ${r.micro} micro-USDC to ${r.to} sent at ${new Date(r.at).toISOString()} got no answer and is not sent again. Drew: check the chain for a USDC transfer from the biller to ${r.to}, then run \`${CMD} resolve-refund ${this.id} sent|unsent|abandon\` (docs/ops.md, Allowances); the allowance does not end until then.`,
      );
    }
    if (!st.isRevoked && !st.isExpired) {
      // Revoked first (mined before this goes on), so nothing more can be spent; then whatever the chain
      // shows was spent is booked, so the refund is exactly what left the account and was not paid out.
      await this.d.chain.revoke(this.p);
      this.book(await this.d.chain.status(this.p));
    }
    const credit = this.credit;
    if (credit > 0n) {
      const to = this.p.permission.account;
      this.e.refundInFlight = { to, micro: credit.toString(), at: this.t };
      this.save();
      try {
        await this.d.chain.refund(to, credit);
      } catch (e) {
        if (e instanceof NotSent) {
          delete this.e.refundInFlight;
          this.save();
          throw new Error(`the refund of ${credit} micro-USDC was not sent (${errText(e)}); trying again next cycle. If it can never land (the account is blacklisted, or the biller lacks the USDC), end it with \`${CMD} resolve-refund ${this.id} abandon\` and settle by hand (docs/ops.md, Allowances)`);
        }
        throw new Error(`the refund of ${credit} micro-USDC to ${to} got no answer (${errText(e)}); not sent again`);
      }
      this.e.creditMicro = '0';
      delete this.e.refundInFlight;
      this.save();
    }
    // The door's record may have moved since the end was decided: `refused` is only a move from `approved`,
    // and `approved -> ended` goes through `stopping` (R1).
    const patch: Ending = ending.state === 'refused' && this.a.state !== 'approved' ? { state: 'ended', endReason: ending.endReason ?? 'cancelled' } : ending;
    if (patch.state === 'ended' && this.a.state === 'approved' && !(await this.post({ state: 'stopping' }))) return;
    const body: Record<string, unknown> = { ...patch, creditMicro: '0' };
    if (patch.state === 'refused') delete body.endReason; // a refusal carries a reason, not an end reason
    await this.post(body);
  }

  // ---- ending ----

  /** The agent's or Drew's stop: revoke on chain if still live, refund, end (`finish` does all three). */
  private async stop(st: Status, endReason: EndReason): Promise<void> {
    await this.finish({ state: 'ended', endReason }, st);
  }

  /** The person revoked it on chain (or it expired). */
  private async cancelled(st: Status): Promise<void> {
    if (this.a.state === 'approved') {
      return this.finish({ state: 'refused', endReason: 'cancelled', reason: st.isRevoked ? 'cancelled before activation' : 'the permission is not in force (before its start or past its end)' }, st);
    }
    await this.finish({ state: 'ended', endReason: 'cancelled' }, st);
  }

  // ---- approval ----

  private async activate(st: Status): Promise<void> {
    const tick = billablePrice(this.a.tickMicro);
    if (tick === undefined) return this.problem('allowance', `allowance ${short(this.id)}: tickMicro ${String(this.a.tickMicro)} is not a price the biller pays; not activated`);
    const seen = { account: this.p.permission.account, remainingMicro: st.remainingMicro.toString(), periodEndsAt: st.periodEndsAt };
    const c = await this.d.chain.canPull(this.p, tick);
    if (c.ok) {
      await this.post({ state: 'active', ...seen });
      return;
    }
    if (c.why === 'invalid') {
      await this.post({ state: 'refused', reason: c.detail, ...seen });
      return;
    }
    if (c.why === 'revoked') {
      await this.post({ state: 'refused', reason: 'cancelled before activation', ...seen });
      return;
    }
    // A refusal the biller cannot read is no reason to refuse a person's approval: keep it and try again.
    if (c.why === 'unknown') return this.problem('pull', `allowance ${short(this.id)}: not activated yet: ${c.detail}`);
    // The approval stands; there is just nothing to pull yet.
    if (!(await this.post({ state: 'active', ...seen }))) return;
    if (c.why === 'short') {
      this.e.nextTryAt = this.t + SHORT_RETRY_MS;
      this.save();
      await this.post({ state: 'short' });
    } else {
      await this.post({ state: 'spent_for_period' });
    }
  }

  // ---- paying ----

  private async tend(st: Status): Promise<void> {
    await this.post({ remainingMicro: st.remainingMicro.toString(), periodEndsAt: st.periodEndsAt, creditMicro: this.e.creditMicro });
    const h = await this.home();
    if (!h.hostKnown) return this.finish({ state: 'ended', endReason: 'home_gone' }, st);
    if (h.grantLive) return; // a grant pays this home; the biller starts at the hour after its last
    if (h.leaseId === null) return this.problem('lease', `allowance ${short(this.id)}: the door has no lease for home ${this.a.homeId}; nothing paid`);

    const lapsedOut = this.e.lapsedSince !== undefined && this.t - this.e.lapsedSince > LAPSE_END_MS;
    if ((this.e.nextReadAt ?? 0) > this.t && !lapsedOut) return;
    const leaseId = h.leaseId;
    const { lease, body } = await this.readLease(leaseId);
    const interval = isObj(body.offer) && Number.isSafeInteger(body.offer.intervalSeconds) && body.offer.intervalSeconds > 0 ? (body.offer.intervalSeconds as number) : 3600;
    const tick = isObj(body.offer) ? billablePrice(body.offer.tickPrice) : undefined;
    // Never more an hour than the price the person saw when they approved.
    const approved = billablePrice(this.a.tickMicro);
    if (tick !== undefined && (approved === undefined || tick > approved)) {
      await this.post({ reason: PRICE_ROSE });
      return this.backOff('price', `lease ${short(leaseId)} asks ${tick} micro-USDC an hour, above the ${String(this.a.tickMicro)} the person approved; nothing paid or re-opened`);
    }

    if (lease.state === 'closed' || lease.state === 'done') {
      if (this.e.lapsedSince === undefined) {
        this.e.lapsedSince = this.t;
        this.save();
      }
      if (this.t - this.e.lapsedSince > LAPSE_END_MS) return this.finish({ state: 'ended', endReason: 'home_gone' }, st);
      if (tick === undefined) return this.backOff('price', `lease ${short(leaseId)} has no usable tick price; not re-opened`);
      return this.reopen(h, leaseId, tick, interval, st);
    }
    if (this.e.lapsedSince !== undefined) {
      delete this.e.lapsedSince;
      this.save();
    }
    if (body.stopped === true) return this.backOff('tick', `the door stopped lease ${short(leaseId)}; no tick until it closes`);
    if (tick === undefined) return this.backOff('price', `lease ${short(leaseId)} has no usable tick price; nothing paid`);
    if (!tickDue(lease as { state: string; paidThrough?: number }, interval, this.t)) {
      this.readAgainAt(lease.paidThrough, interval);
      this.save();
      return;
    }
    if (!(await this.haveCredit(tick, st))) {
      this.e.nextReadAt = this.t + BACKOFF_MS;
      this.save();
      return;
    }
    await this.payTick(leaseId, lease.paidIntervals, tick, interval);
  }

  private backOff(key: string, msg: string): void {
    this.e.nextReadAt = this.t + BACKOFF_MS;
    this.save();
    this.problem(key, `allowance ${short(this.id)}: ${msg}`);
  }

  /** The next lease read: when the next tick comes due, and at least once an hour. */
  private readAgainAt(paidThrough: unknown, intervalSeconds: number): void {
    this.e.nextReadAt =
      typeof paidThrough === 'number' && Number.isFinite(paidThrough)
        ? Math.min(paidThrough - (intervalSeconds * 1000) / 2, this.t + READ_EVERY_MS)
        : this.t;
  }

  /** True when the credit covers `tick`, pulling first if it does not and the permission allows. */
  private async haveCredit(tick: bigint, st: Status): Promise<boolean> {
    const credit = this.credit;
    if (credit >= tick) return true;
    if (this.e.nextTryAt !== undefined && this.e.nextTryAt > this.t) return false;
    if (this.t >= st.periodEndsAt - PERIOD_EDGE_MS) return false; // wait for the next period to pull
    const need = pullNeed(credit, tick, st.remainingMicro);
    if (need === 0n) {
      await this.post({ state: 'spent_for_period', remainingMicro: st.remainingMicro.toString(), periodEndsAt: st.periodEndsAt });
      return false;
    }
    const c = await this.d.chain.canPull(this.p, need);
    if (!c.ok) {
      if (c.why === 'short') {
        this.e.nextTryAt = this.t + SHORT_RETRY_MS;
        this.save();
        await this.post({ state: 'short' });
      } else if (c.why === 'over_limit') {
        await this.post({ state: 'spent_for_period' });
      } else {
        this.problem('pull', `allowance ${short(this.id)}: a pull of ${need} would not go through (${c.why}: ${c.detail}); nothing sent`);
      }
      return false;
    }
    delete this.e.nextTryAt;
    // The checks above took time: the end-of-period guard is checked again on the clock now, and the pull is
    // booked to the period it checked.
    if (this.d.now() >= st.periodEndsAt - PERIOD_EDGE_MS) return false;
    // Saved before the send: if the answer is lost, the period's spend settles it next cycle.
    this.e.pullInFlight = { micro: need.toString(), at: this.t, periodEndsAt: st.periodEndsAt };
    this.e.periodSpentSeen = st.periodSpentMicro.toString();
    this.save();
    let tx: string;
    try {
      ({ tx } = await this.d.chain.pull(this.p, need));
    } catch (e) {
      if (e instanceof NotSent) {
        delete this.e.pullInFlight;
        delete this.e.periodSpentSeen;
        this.save();
        throw new Error(`a pull of ${need} micro-USDC was not sent (${errText(e)})`);
      }
      throw new Error(`a pull of ${need} micro-USDC got no answer (${errText(e)}); the period's spend settles it next cycle`);
    }
    this.e.creditMicro = (credit + need).toString();
    if (this.e.periodPulled?.periodEndsAt === st.periodEndsAt) this.e.periodPulled.micro = (BigInt(this.e.periodPulled.micro) + need).toString();
    else this.e.periodPulled = { periodEndsAt: st.periodEndsAt, micro: (st.periodSpentMicro + need).toString() };
    delete this.e.pullInFlight;
    delete this.e.periodSpentSeen;
    this.save();
    await this.post({
      state: 'active',
      lastPullTx: tx,
      remainingMicro: (st.remainingMicro - need).toString(),
      periodEndsAt: st.periodEndsAt,
      creditMicro: this.e.creditMicro,
    });
    return true;
  }

  private async payTick(leaseId: string, index: number, tick: bigint, interval: number): Promise<void> {
    // Saved before the send: if the answer is lost, the host's count settles it next cycle.
    this.e.tickInFlight = { leaseId, index, micro: tick.toString(), at: this.t };
    this.save();
    let a: Answer;
    try {
      a = await this.d.door.pay(`/v1/leases/${leaseId}/ticks`, { index });
    } catch (e) {
      this.e.nextReadAt = this.t + BACKOFF_MS;
      this.save();
      throw new Error(`tick ${index} on lease ${short(leaseId)} got no answer (${errText(e)}); the host's count settles it next cycle`);
    }
    delete this.e.tickInFlight;
    if (a.status === 200) {
      this.spend(a.paid ?? tick);
      this.hours += 1;
      this.readAgainAt(isObj(a.body) ? a.body.paidThrough : undefined, interval);
      this.save();
      await this.post({ hoursPaid: this.hours, creditMicro: this.e.creditMicro, ...(this.a.reason === PRICE_ROSE ? { reason: '' } : {}) });
      return;
    }
    // duplicate: the host already counted this index. out_of_order: someone else paid it between the read
    // and the tick. Either way nothing was paid and the next read has the host's new count.
    if (a.status === 409 && (errOf(a) === 'duplicate' || errOf(a) === 'out_of_order')) {
      this.save();
      return;
    }
    this.backOff('tick', `tick ${index} on lease ${short(leaseId)} answered ${a.status} ${errOf(a)}; credit unchanged, trying again in 5 minutes`);
  }

  /** Re-opens the closed home on its own offer, with its own keys and image. Never on another offer. */
  private async reopen(h: Home, prevLeaseId: string, tick: bigint, interval: number, st: Status): Promise<void> {
    const offerId = h.offerId;
    if (offerId === null) return this.backOff('open', `home ${this.a.homeId} has no offer on record; not re-opened anywhere`);
    // A closed lease shows its open-time price; the re-open pays the offer's price now, so check that one too.
    const listed = await this.d.door.get('/v1/offers');
    const row = listed.status === 200 && Array.isArray(listed.body) ? listed.body.find((o: unknown) => isObj(o) && o.offerId === offerId) : undefined;
    if (!isObj(row)) return this.backOff('open', `offer ${offerId} is not listed now (GET /v1/offers answered ${listed.status}); not re-opened`);
    const now = billablePrice(row.tickPrice);
    const approved = billablePrice(this.a.tickMicro);
    if (now === undefined || approved === undefined || now > approved) {
      await this.post({ reason: PRICE_ROSE });
      return this.backOff('price', `offer ${offerId} asks ${String(row.tickPrice)} micro-USDC an hour, above the ${String(this.a.tickMicro)} the person approved; not re-opened`);
    }
    if (now > tick) tick = now;
    if (!(await this.haveCredit(tick, st))) {
      this.e.nextReadAt = this.t + BACKOFF_MS;
      this.save();
      return;
    }
    // Saved before the send: if the answer is lost, the home's newest lease settles it next cycle.
    this.e.openInFlight = { offerId, prevLeaseId, micro: tick.toString(), at: this.t };
    this.save();
    let a: Answer;
    try {
      a = await this.d.door.pay('/v1/rent', { offerId, home: { sshKeys: this.a.sshKeys, image: this.a.image } });
    } catch (e) {
      this.e.nextReadAt = this.t + BACKOFF_MS;
      this.save();
      throw new Error(`the re-open on offer ${offerId} got no answer (${errText(e)}); the home's newest lease settles it next cycle`);
    }
    delete this.e.openInFlight;
    if (a.status === 200) {
      this.spend(a.paid ?? tick);
      this.hours += 1;
      delete this.e.lapsedSince;
      this.readAgainAt(isObj(a.body) ? a.body.paidThrough : undefined, interval);
      this.save();
      const leaseId = isObj(a.body) && typeof a.body.leaseId === 'string' && ID.test(a.body.leaseId) ? a.body.leaseId : undefined;
      if (!leaseId) this.problem('open', `allowance ${short(this.id)}: the re-open was paid but answered no usable lease id`);
      await this.post({ leaseId, hoursPaid: this.hours, creditMicro: this.e.creditMicro, ...(this.a.reason === PRICE_ROSE ? { reason: '' } : {}) });
      return;
    }
    if (a.status === 409 && errOf(a) === 'home_host_gone') {
      this.save();
      return this.finish({ state: 'ended', endReason: 'home_gone' }, st);
    }
    this.backOff('open', `the re-open on offer ${offerId} answered ${a.status} ${errOf(a)}; trying again in 5 minutes`);
  }
}
