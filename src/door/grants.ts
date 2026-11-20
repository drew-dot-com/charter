import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homeIdOf, normalizeSshKeys } from '../jobs.js';

export type GrantState = 'queued' | 'declined' | 'approved_waiting' | 'active' | 'completed' | 'ended_early' | 'stopped' | 'expired';

export interface Grant {
  grantId: string;
  state: GrantState;
  name: string;
  link?: string;
  image: 'charter-home' | 'charter-hermes';
  sshKeys: string[];
  homeId: string;
  /** The raw pitch text. Dropped 30 days after createdAt. */
  pitch?: string;
  /** sha256 hex of the owner's token. */
  tokenHash: string;
  createdAt: number;
  decidedAt?: number;
  summary?: string;
  reason?: string;
  leaseId?: string;
  paidHours: number;
  renewedByGrantee: boolean;
  updatedAt: number;
}

export const ALLOWED_MOVES: Record<GrantState, GrantState[]> = {
  queued: ['declined', 'approved_waiting'],
  approved_waiting: ['active', 'expired', 'stopped', 'ended_early'],
  active: ['completed', 'ended_early', 'stopped'],
  declined: [],
  expired: [],
  completed: [],
  ended_early: [],
  stopped: [],
};

/** A state change the table does not allow. */
export class BadMove extends Error {
  constructor(readonly from: GrantState, readonly to: GrantState) {
    super(`bad move ${from} -> ${to}`);
    this.name = 'BadMove';
  }
}

export const MAX_PITCH = 2000;
export const MAX_NAME = 80;
export const MAX_LINK = 200;
export const PITCH_KEEP_MS = 30 * 86_400_000;

type NewPitch = { name: string; pitch: string; sshKeys: string[]; image: Grant['image']; link?: string };

/** False for a string holding a lone UTF-16 surrogate, which no JSON encoder downstream (the judge's API) accepts. */
export function wellFormed(s: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(s);
}

export function validatePitch(body: unknown): { ok: true; pitch: NewPitch } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  for (const k of ['name', 'pitch', 'link'] as const) {
    if (typeof b[k] === 'string' && !wellFormed(b[k] as string)) return { ok: false, error: `${k} is not well-formed text (a lone UTF-16 surrogate)` };
  }
  if (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.length > MAX_NAME) return { ok: false, error: `name must be 1 to ${MAX_NAME} characters` };
  if (typeof b.pitch !== 'string' || b.pitch.trim().length < 1 || b.pitch.length > MAX_PITCH) return { ok: false, error: `pitch must be 1 to ${MAX_PITCH} characters` };
  // image is optional: charter-mcp, its CLI and the docs all treat a missing one as charter-home.
  const image = b.image === undefined ? 'charter-home' : b.image;
  if (image !== 'charter-home' && image !== 'charter-hermes') return { ok: false, error: 'image must be charter-home or charter-hermes' };
  const keys = normalizeSshKeys(b.sshKeys);
  if (!keys) return { ok: false, error: 'sshKeys must be 1 to 8 public key lines' };
  let link: string | undefined;
  if (b.link !== undefined) {
    if (typeof b.link !== 'string' || b.link.length > MAX_LINK) return { ok: false, error: `link must be an https URL of at most ${MAX_LINK} characters` };
    let u: URL;
    try {
      u = new URL(b.link);
    } catch {
      return { ok: false, error: 'link must be an https URL' };
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'link must be an https URL' };
    link = b.link;
  }
  return { ok: true, pitch: { name: b.name.trim(), pitch: b.pitch, sshKeys: keys, image, ...(link !== undefined ? { link } : {}) } };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class GrantStore {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly file: string, private readonly now: () => number) {
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const g = JSON.parse(line) as Grant;
        if (typeof g !== 'object' || g === null || typeof g.grantId !== 'string') continue;
        this.grants.set(g.grantId, g);
      } catch {
        // a torn line: skip it
      }
    }
    // A crash mid-write leaves a last line with no newline. Ending it here keeps the next append on a line
    // of its own, so the next record is not glued onto the fragment and lost at the following load.
    if (text.length > 0 && !text.endsWith('\n')) appendFileSync(file, '\n');
  }

  private append(g: Grant): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, JSON.stringify(g) + '\n', { mode: 0o600 });
  }

  add(p: NewPitch, token: string): Grant {
    const t = this.now();
    const g: Grant = {
      grantId: randomBytes(16).toString('hex'),
      state: 'queued',
      name: p.name,
      ...(p.link !== undefined ? { link: p.link } : {}),
      image: p.image,
      sshKeys: [...p.sshKeys],
      homeId: homeIdOf(p.sshKeys),
      pitch: p.pitch,
      tokenHash: sha256(token),
      createdAt: t,
      paidHours: 0,
      renewedByGrantee: false,
      updatedAt: t,
    };
    this.grants.set(g.grantId, g);
    this.append(g);
    return { ...g };
  }

  get(id: string): Grant | undefined {
    const g = this.grants.get(id);
    return g ? { ...g } : undefined;
  }

  all(): Grant[] {
    return [...this.grants.values()].map((g) => ({ ...g }));
  }

  queued(): Grant[] {
    return this.all().filter((g) => g.state === 'queued');
  }

  update(id: string, patch: Partial<Pick<Grant, 'state' | 'summary' | 'reason' | 'leaseId' | 'paidHours' | 'renewedByGrantee' | 'decidedAt'>>): Grant {
    const cur = this.grants.get(id);
    if (!cur) throw new Error(`no grant ${id}`);
    if (patch.state !== undefined && patch.state !== cur.state && !ALLOWED_MOVES[cur.state].includes(patch.state)) throw new BadMove(cur.state, patch.state);
    const next: Grant = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    next.updatedAt = this.now();
    this.grants.set(id, next);
    this.append(next);
    return { ...next };
  }

  /** True once any grant on this home left the queue for approved_waiting (or on from there). */
  homeIdGranted(homeId: string): boolean {
    return this.all().some((g) => g.homeId === homeId && g.state !== 'queued' && g.state !== 'declined');
  }

  tokenOk(id: string, token: string): boolean {
    const g = this.grants.get(id);
    if (!g) return false;
    const a = Buffer.from(sha256(token), 'hex');
    const b = Buffer.from(g.tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Remove the pitch text from grants made more than 30 days ago, and rewrite the file so the text is gone from disk. */
  dropOldPitches(): void {
    const cutoff = this.now() - PITCH_KEEP_MS;
    let changed = false;
    for (const g of this.grants.values()) {
      if (g.pitch !== undefined && g.createdAt < cutoff) {
        delete g.pitch;
        changed = true;
      }
    }
    if (!changed) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, [...this.grants.values()].map((g) => JSON.stringify(g)).join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** What anyone may see: no pitch, no keys, no homeId (it links a grant to a key set), no token hash, the lease id cut to 8. */
export function publicView(g: Grant): Record<string, unknown> {
  const { pitch: _p, sshKeys: _k, homeId: _h, tokenHash: _t, leaseId, ...rest } = g;
  return { ...rest, ...(leaseId !== undefined ? { leaseId: leaseId.slice(0, 8) } : {}) };
}

/** The fund's report is stale (the fund is down or cut off) this long after the door last took it. */
export const FUND_STALE_MS = 10 * 60_000;

export interface FundPublic { address: string; balanceMicro: string; grantsLeft: number; open: boolean }

/**
 * The fund's last report (`fund-public.json`, written by `PUT /v1/fund/public`) as the public sees it, or null
 * when there is none or it does not read. `open` is true only when the fund said so and the door took that
 * report (its own clock, `reportedAt`) within FUND_STALE_MS: a fund that stops reporting closes intake. Grants
 * left is 0 whenever the fund is not open.
 */
export function readFundPublic(file: string, now: number): FundPublic | null {
  let f: unknown;
  try {
    f = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const r = f as Record<string, unknown>;
  if (typeof r.address !== 'string' || typeof r.balanceMicro !== 'string') return null;
  const fresh = typeof r.reportedAt === 'number' && Number.isFinite(r.reportedAt) && now - r.reportedAt <= FUND_STALE_MS;
  const open = r.open === true && fresh;
  const left = typeof r.grantsLeft === 'number' && Number.isSafeInteger(r.grantsLeft) && r.grantsLeft > 0 ? r.grantsLeft : 0;
  return { address: r.address, balanceMicro: r.balanceMicro, grantsLeft: open ? left : 0, open };
}

/** What the grant's owner sees: the public view plus the full lease id. */
export function ownerView(g: Grant): Record<string, unknown> {
  return { ...publicView(g), ...(g.leaseId !== undefined ? { leaseId: g.leaseId } : {}) };
}
