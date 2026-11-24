import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homeIdOf, normalizeSshKeys } from '../jobs.js';

export type AllowanceState = 'waiting' | 'approved' | 'active' | 'short' | 'spent_for_period' | 'stopping' | 'refused' | 'ended' | 'expired';

export const LIVE_STATES: AllowanceState[] = ['waiting', 'approved', 'active', 'short', 'spent_for_period', 'stopping'];

export const ALLOWED_MOVES: Record<AllowanceState, AllowanceState[]> = {
  waiting: ['approved', 'expired'],
  approved: ['active', 'refused', 'stopping'],
  active: ['short', 'spent_for_period', 'stopping', 'ended'],
  short: ['active', 'spent_for_period', 'stopping', 'ended'],
  spent_for_period: ['active', 'short', 'stopping', 'ended'],
  stopping: ['ended'],
  refused: [],
  ended: [],
  expired: [],
};

export type EndReason = 'cancelled' | 'stopped' | 'home_gone' | 'operator';

/** A spend permission as @base-org/account returns it, numbers as JSON gives them. */
export interface SignedPermission {
  signature: string;
  chainId: number;
  permissionHash?: string;
  permission: { account: string; spender: string; token: string; allowance: string; period: number; start: number; end: number; salt: string; extraData: string };
}

export interface Allowance {
  allowanceId: string;
  state: AllowanceState;
  homeId: string;
  sshKeys: string[];
  image: 'charter-home' | 'charter-hermes';
  tickMicro: string;
  /** sha256 hex of the owner's token. */
  tokenHash: string;
  createdAt: number;
  updatedAt: number;
  signed?: SignedPermission;
  account?: string;
  reason?: string;
  endReason?: EndReason;
  remainingMicro?: string;
  periodEndsAt?: number;
  creditMicro?: string;
  hoursPaid: number;
  lastPullTx?: string;
  leaseId?: string;
}

/** A state change the table does not allow. */
export class BadMove extends Error {
  constructor(readonly from: AllowanceState, readonly to: AllowanceState) {
    super(`bad move ${from} -> ${to}`);
    this.name = 'BadMove';
  }
}

/** An allowance nobody approved expires this long after it was made. */
export const EXPIRE_MS = 7 * 86_400_000;
export const PERIOD_SECONDS = 2_592_000;
/** Paid hours at which a grant's owner view offers the keep-home link: 720 grant hours minus the last 48. */
export const KEEP_HOME_FROM_HOURS = 672;
export const SUGGESTED_TICKS = 744n;
/** 30 days of the home: an allowance smaller than about a month of rent lets the home lapse every period. */
export const MIN_TICKS = 720n;
export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export function validateRequest(body: unknown): { ok: true; sshKeys: string[]; image: Allowance['image'] } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const image = b.image === undefined ? 'charter-home' : b.image;
  if (image !== 'charter-home' && image !== 'charter-hermes') return { ok: false, error: 'image must be charter-home or charter-hermes' };
  const keys = normalizeSshKeys(b.sshKeys);
  if (!keys) return { ok: false, error: 'sshKeys must be 1 to 8 public key lines' };
  return { ok: true, sshKeys: keys, image };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** ABI `bytes`: 0x and whole bytes. */
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const DIGITS = /^[0-9]{1,78}$/;
/** The SpendPermission struct's types, so the contract (and viem's encoder) can always take what is stored. */
const UINT160 = 2n ** 160n;
const UINT48 = 2 ** 48;
const UINT256 = 2n ** 256n;
/** An ERC-6492 wrapped signature from a smart wallet not yet deployed (a passkey account) runs to thousands of characters. */
export const MAX_SIGNATURE_CHARS = 20_000;
/** extraData: up to 1024 bytes. */
export const MAX_EXTRA_DATA_CHARS = 2 + 2 * 1024;
/** A permission may start at most this far ahead of the door's clock (seconds). */
export const MAX_START_AHEAD_S = 600;

export function validatePermission(
  body: unknown,
  o: { spender: string; tickMicro: bigint; now: number },
): { ok: true; signed: SignedPermission } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return no('body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== 'string' || b.signature.length < 4 || b.signature.length > MAX_SIGNATURE_CHARS || !BYTES.test(b.signature)) {
    return no(`signature must be 0x and whole bytes of hex, at most ${MAX_SIGNATURE_CHARS} characters`);
  }
  if (b.chainId !== BASE_CHAIN_ID) return no(`chainId must be ${BASE_CHAIN_ID}`);
  if (b.permissionHash !== undefined && (typeof b.permissionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.permissionHash))) return no('permissionHash must be a 0x hex string of 32 bytes');
  const p = b.permission;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return no('permission must be an object');
  const q = p as Record<string, unknown>;
  if (typeof q.account !== 'string' || !ADDRESS.test(q.account)) return no('account must be a 0x address');
  if (typeof q.spender !== 'string' || q.spender.toLowerCase() !== o.spender.toLowerCase()) return no('spender is not this door\'s spender');
  if (typeof q.token !== 'string' || q.token.toLowerCase() !== USDC_BASE.toLowerCase()) return no('token must be USDC on Base');
  if (q.period !== PERIOD_SECONDS) return no(`period must be ${PERIOD_SECONDS}`);
  if (typeof q.allowance !== 'string' || !DIGITS.test(q.allowance)) return no('allowance must be a decimal string');
  if (BigInt(q.allowance) >= UINT160) return no('allowance must fit a uint160');
  if (BigInt(q.allowance) < MIN_TICKS * o.tickMicro) return no(`allowance must be at least ${MIN_TICKS * o.tickMicro} (${MIN_TICKS} ticks, 30 days of the home)`);
  const nowSec = Math.floor(o.now / 1000);
  if (typeof q.start !== 'number' || !Number.isSafeInteger(q.start) || q.start < 0 || q.start >= UINT48) return no('start must be a unix time in seconds that fits a uint48');
  if (q.start > nowSec + MAX_START_AHEAD_S) return no(`start must not be more than ${MAX_START_AHEAD_S / 60} minutes ahead of Charter's clock; check this device's clock and sign again`);
  if (typeof q.end !== 'number' || !Number.isSafeInteger(q.end) || q.end >= UINT48) return no('end must be a unix time in seconds that fits a uint48');
  if (q.end <= o.now / 1000) return no('end must be in the future');
  if (typeof q.salt !== 'string' || !/^0x[0-9a-fA-F]{1,128}$/.test(q.salt) || BigInt(q.salt) >= UINT256) return no('salt must be a 0x hex number that fits a uint256');
  if (typeof q.extraData !== 'string' || q.extraData.length > MAX_EXTRA_DATA_CHARS || !BYTES.test(q.extraData)) return no('extraData must be 0x and whole bytes of hex, at most 1024 bytes');
  const signed: SignedPermission = {
    signature: b.signature,
    chainId: BASE_CHAIN_ID,
    ...(b.permissionHash !== undefined ? { permissionHash: b.permissionHash as string } : {}),
    permission: {
      account: q.account,
      spender: q.spender,
      token: q.token,
      allowance: q.allowance,
      period: q.period,
      start: q.start,
      end: q.end,
      salt: q.salt,
      extraData: q.extraData,
    },
  };
  return { ok: true, signed };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** One spend permission on chain: its account (any case) and salt (any hex spelling of the same number). */
export function permissionKey(account: string, salt: string): string {
  let n: string;
  try {
    n = BigInt(salt).toString(16);
  } catch {
    n = salt.toLowerCase();
  }
  return `${account.toLowerCase()}:${n}`;
}

export class AllowanceStore {
  private readonly items = new Map<string, Allowance>();

  constructor(private readonly file: string, private readonly now: () => number) {
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as Allowance;
        if (typeof a !== 'object' || a === null || typeof a.allowanceId !== 'string') continue;
        this.items.set(a.allowanceId, a);
      } catch {
        // a torn line: skip it
      }
    }
    // End a torn last line so the next append starts on a line of its own.
    if (text.length > 0 && !text.endsWith('\n')) appendFileSync(file, '\n');
  }

  private append(a: Allowance): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, JSON.stringify(a) + '\n', { mode: 0o600 });
  }

  add(r: { sshKeys: string[]; image: Allowance['image']; tickMicro: bigint }, token: string): Allowance {
    const t = this.now();
    const a: Allowance = {
      allowanceId: randomBytes(16).toString('hex'),
      state: 'waiting',
      homeId: homeIdOf(r.sshKeys),
      sshKeys: [...r.sshKeys],
      image: r.image,
      tickMicro: r.tickMicro.toString(),
      tokenHash: sha256(token),
      createdAt: t,
      updatedAt: t,
      hoursPaid: 0,
    };
    this.items.set(a.allowanceId, a);
    this.append(a);
    return { ...a };
  }

  get(id: string): Allowance | undefined {
    const a = this.items.get(id);
    return a ? { ...a } : undefined;
  }

  all(): Allowance[] {
    return [...this.items.values()].map((a) => ({ ...a }));
  }

  /** The newest live allowance for the home, after expiring any `waiting` one older than EXPIRE_MS. */
  liveForHome(homeId: string): Allowance | undefined {
    const t = this.now();
    for (const a of [...this.items.values()]) {
      if (a.homeId === homeId && a.state === 'waiting' && t - a.createdAt > EXPIRE_MS) this.update(a.allowanceId, { state: 'expired' });
    }
    let best: Allowance | undefined;
    for (const a of this.items.values()) {
      if (a.homeId !== homeId || !LIVE_STATES.includes(a.state)) continue;
      if (!best || a.createdAt >= best.createdAt) best = a;
    }
    return best ? { ...best } : undefined;
  }

  update(id: string, patch: Partial<Omit<Allowance, 'allowanceId' | 'homeId' | 'sshKeys' | 'image' | 'tokenHash' | 'createdAt'>>): Allowance {
    const cur = this.items.get(id);
    if (!cur) throw new Error(`no allowance ${id}`);
    if (patch.state !== undefined && patch.state !== cur.state && !ALLOWED_MOVES[cur.state].includes(patch.state)) throw new BadMove(cur.state, patch.state);
    const next: Allowance = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    next.updatedAt = this.now();
    this.items.set(id, next);
    this.append(next);
    return { ...next };
  }

  /**
   * The allowance, in any state, that ever stored a permission for this account and salt (one permission on
   * chain), or undefined. Keyed on the permission's own fields, never on a client-sent hash.
   */
  permissionHolder(account: string, salt: string): string | undefined {
    const key = permissionKey(account, salt);
    for (const a of this.items.values()) {
      if (a.signed && permissionKey(a.signed.permission.account, a.signed.permission.salt) === key) return a.allowanceId;
    }
    return undefined;
  }

  tokenOk(id: string, token: string): boolean {
    const a = this.items.get(id);
    if (!a) return false;
    const x = Buffer.from(sha256(token), 'hex');
    const y = Buffer.from(a.tokenHash, 'hex');
    return x.length === y.length && timingSafeEqual(x, y);
  }
}

/**
 * The message an agent forwards to its person: what approving does, what they will meet (a Coinbase sign-up
 * with an email, a pop-up, one signature), and the link. The same words as charter-mcp's allowanceMessage.
 */
export function personMessage(approveUrl: string): string {
  return [
    'I would like your OK to keep my Charter home paid. If you approve, Charter keeps this home paid, up to the amount you choose per 30 days, and you can stop it at any time.',
    'What you will need: a Coinbase sign-up with an email address, a pop-up to allow in your browser, and one signature.',
    `Approve here: ${approveUrl}`,
  ].join('\n\n');
}

/** What the approval page may see: no keys, homeId, token hash, signature or lease id. */
export function pageView(a: Allowance, spender: string): Record<string, unknown> {
  const tick = BigInt(a.tickMicro);
  return {
    allowanceId: a.allowanceId,
    state: a.state,
    image: a.image,
    tickMicro: a.tickMicro,
    suggestedMicro: (SUGGESTED_TICKS * tick).toString(),
    minMicro: (MIN_TICKS * tick).toString(),
    periodDays: 30,
    spender,
    ...(a.account !== undefined ? { account: a.account } : {}),
    ...(a.remainingMicro !== undefined ? { remainingMicro: a.remainingMicro } : {}),
    ...(a.periodEndsAt !== undefined ? { periodEndsAt: a.periodEndsAt } : {}),
    ...(a.creditMicro !== undefined ? { creditMicro: a.creditMicro } : {}),
    hoursPaid: a.hoursPaid,
    ...(a.lastPullTx !== undefined ? { lastPullTx: a.lastPullTx } : {}),
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    ...(a.endReason !== undefined ? { endReason: a.endReason } : {}),
    createdAt: a.createdAt,
  };
}

/** The owner's view: the page view plus the home id and lease id. */
export function ownerView(a: Allowance, spender: string): Record<string, unknown> {
  return { ...pageView(a, spender), homeId: a.homeId, ...(a.leaseId !== undefined ? { leaseId: a.leaseId } : {}) };
}

/** The biller's view: everything but the token hash. */
export function billerView(a: Allowance): Record<string, unknown> {
  const { tokenHash: _t, ...rest } = a;
  return { ...rest };
}
