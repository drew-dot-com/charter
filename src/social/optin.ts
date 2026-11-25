// Self-service opt-in: a renter, grantee or host agrees to be named by posting at the account. Everything here is
// code. An opt-in mention is never shown to a model, and nothing its author typed is kept except their handle.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HOST_PREFIX, OPTIN_PREFIX, X_HANDLE, optinHash } from '../door/optin-codes.js';
import type { ConfigFiles, Optin, Optins } from './files.js';
import { hourlyAlertDue, publish, tell } from './publish.js';
import type { LoopDeps } from './replies.js';
import type { Sources } from './sources.js';
import type { Mention } from './x.js';

export const SELF_OPTINS_FILE = 'self-optins.json';

/** One binding the service wrote. `handle` has no '@' and keeps X's own casing. */
export interface SelfOptin { handle: string; at: number; mentionId: string }
type Section = 'renters' | 'grants' | 'hosts';
const SECTIONS: Section[] = ['renters', 'grants', 'hosts'];
/** Keys are lowercased: payer wallets for renters, grant ids, host ids. Same shape as optins.json. */
export type SelfOptins = Record<Section, Record<string, SelfOptin>>;

const empty = (): SelfOptins => ({ renters: {}, grants: {}, hosts: {} });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The service's own opt-in file, in its state dir. Drew's optins.json is never written. */
export class SelfOptinStore {
  constructor(private readonly file: string) {}

  /** Nobody when the file is absent. A file that does not parse, or holds anything but bindings, throws: fail closed. */
  read(): SelfOptins {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw e;
    }
    const bad = new Error(`${SELF_OPTINS_FILE} is malformed`);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw bad;
    }
    if (!isObj(raw)) throw bad;
    const out = empty();
    for (const s of SECTIONS) {
      const sec = raw[s];
      if (sec === undefined) continue;
      if (!isObj(sec)) throw bad;
      for (const [k, v] of Object.entries(sec)) {
        if (!isObj(v) || typeof v.handle !== 'string' || !X_HANDLE.test(v.handle) || typeof v.at !== 'number' || typeof v.mentionId !== 'string') throw bad;
        out[s][k.toLowerCase()] = { handle: v.handle, at: v.at, mentionId: v.mentionId };
      }
    }
    return out;
  }

  /** Re-reads, applies `fn`, writes through a temp file and a rename. */
  update(fn: (s: SelfOptins) => void): SelfOptins {
    const s = this.read();
    fn(s);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    return s;
  }
}

const bannedIn = (handle: string, banned: readonly string[]): boolean => {
  const h = handle.toLowerCase();
  return banned.some((w) => w.trim() && h.includes(w.trim().toLowerCase()));
};

/**
 * The opt-ins in force: the self opt-ins, named by their handle, with Drew's optins.json laid over them (his entry
 * wins for the same key). A self opt-in whose handle is on the blocklist, or holds a banned word, is left out.
 */
export function mergeOptins(config: Optins, self: SelfOptins, rules: { blocklist: ReadonlySet<string>; banned: readonly string[] }): Optins {
  const out: Optins = { renters: {}, grants: {}, hosts: {} };
  for (const s of SECTIONS) {
    const sec: Record<string, Optin> = {};
    for (const [k, v] of Object.entries(self[s])) {
      if (rules.blocklist.has(v.handle.toLowerCase()) || bannedIn(v.handle, rules.banned)) continue;
      sec[k.toLowerCase()] = { name: v.handle, handle: v.handle };
    }
    out[s] = { ...sec, ...config[s] };
  }
  return out;
}

/** The config files as loaded, with the self opt-ins merged into `optins`. */
export function withSelfOptins(files: ConfigFiles, self: SelfOptins): ConfigFiles {
  return { ...files, optins: mergeOptins(files.optins, self, { blocklist: files.blocklist, banned: files.rules.banned }) };
}

export type ParsedOptin = { kind: 'code'; code: string; stop: boolean } | { kind: 'host'; hostId: string; stop: boolean } | { kind: 'malformed' };

const MARK = new RegExp(`${OPTIN_PREFIX}|${HOST_PREFIX}`, 'i');
const CODE = new RegExp(`(?<![a-z0-9-])${OPTIN_PREFIX}[0-9a-f]{32}(?![a-z0-9])`, 'g');
const HOST = new RegExp(`(?<![a-z0-9-])${HOST_PREFIX}([0-9a-f]{64})(?![a-z0-9])`, 'g');

/**
 * Null for a mention that is not about opting in. Anything carrying an opt-in word is one, so it is handled here and
 * never by a model: exactly one well-formed code or host id, or `malformed`. `stop` as a whole word asks to undo.
 */
export function parseOptin(text: string): ParsedOptin | null {
  const t = String(text ?? '').normalize('NFKC').toLowerCase();
  if (!MARK.test(t)) return null;
  const codes = new Set([...t.matchAll(CODE)].map((m) => m[0]));
  const hosts = new Set([...t.matchAll(HOST)].map((m) => m[1]!));
  if (codes.size + hosts.size !== 1) return { kind: 'malformed' };
  const stop = /(?<![a-z0-9])stop(?![a-z0-9])/.test(t);
  const [code] = codes;
  if (code !== undefined) return { kind: 'code', code, stop };
  return { kind: 'host', hostId: [...hosts][0]!, stop };
}

/** The fixed replies. No model writes them and nothing from the mention is in them. */
export const OPTIN_REPLY = {
  bound: 'Noted. I will name this account when I post about its time on Charter. To undo it, post the same line with the word stop.',
  unbound: 'Done. I will not name this account again.',
};

const NOUN: Record<Section, string> = { renters: 'a renter', grants: 'a grantee', hosts: 'a host' };

/** Who a valid opt-in is for, or why it is refused. Reasons never quote the code. */
function subjectFor(p: Exclude<ParsedOptin, { kind: 'malformed' }>, handle: string, src: Sources, excluded: ReadonlySet<string>): { section: Section; key: string } | { refused: string } {
  if (p.kind === 'host') {
    const h = src.hosts.find((r) => r.hostId === p.hostId);
    if (!h || h.state === 'dropped') return { refused: 'unknown host' };
    const stated = (h.offer as { xHandle?: unknown } | undefined)?.xHandle;
    if (typeof stated !== 'string' || stated.toLowerCase() !== handle.toLowerCase()) return { refused: 'the host offer does not name this handle' };
    return { section: 'hosts', key: h.hostId.toLowerCase() };
  }
  const hash = optinHash(p.code);
  const row = src.optinCodes.find((c) => c.hash === hash);
  if (!row) return { refused: 'unknown code' };
  if (row.kind === 'grant') {
    const g = src.grants.find((x) => x.grantId === row.id);
    return g ? { section: 'grants', key: g.grantId.toLowerCase() } : { refused: 'unknown grant' };
  }
  const lease = src.leases.find((l) => l.leaseId === row.id);
  if (!lease) return { refused: 'unknown lease' };
  // A grant's lease is paid by the fund: its grantee opts in with the grant's code, never as the fund's wallet.
  if (src.grants.some((g) => g.leaseId === lease.leaseId)) return { refused: 'a grant lease: the grant has its own code' };
  if (!lease.payer) return { refused: 'the lease has no payer yet' };
  const payer = lease.payer.toLowerCase();
  if (excluded.has(payer)) return { refused: 'a first-party or probe wallet' };
  return { section: 'renters', key: payer };
}

/**
 * One opt-in mention, start to finish. Refusals are silent on X ('skipped'). A bind or unbind tells Drew, then answers
 * once with fixed text through `publish` (so pause, kill switch, caps and one reply per conversation all hold); the
 * binding stands whether or not that reply goes out. 'retry' = the door's data or the opt-in file could not be read
 * or written.
 */
export async function handleOptin(deps: LoopDeps, m: Mention, parsed: ParsedOptin, files: ConfigFiles): Promise<'replied' | 'silent' | 'skipped' | 'retry'> {
  const now = deps.now();
  const note = (text: string): void => {
    try {
      deps.state.update((s) => void s.log.push({ at: now, kind: 'skip', text: `mention ${m.id}: opt-in: ${text}`, id: m.id }));
    } catch {
      // best effort
    }
  };
  const skip = (reason: string): 'skipped' => (note(reason), 'skipped');
  const wait = async (key: string, why: string): Promise<'retry'> => {
    let due = false;
    try {
      deps.state.update((s) => void (due = hourlyAlertDue(s, key, now)));
    } catch {
      // best effort
    }
    if (due) await tell(deps.tg, `opt-ins wait: ${why}`);
    return 'retry';
  };

  if (!deps.cfg.x.userId) return skip('own user id unknown');
  if (!m.id || !m.authorId) return skip('incomplete mention');
  if (m.authorId === deps.cfg.x.userId) return skip('self');
  const handle = String(m.authorHandle ?? '').trim().replace(/^@+/, '');
  if (!X_HANDLE.test(handle)) return skip('no author handle');
  if (files.blocklist.has(handle.toLowerCase())) return skip('blocklisted author');
  if (bannedIn(handle, files.rules.banned)) return skip('banned word in handle');
  if (parsed.kind === 'malformed') return skip('not one well-formed code or host id');

  const src = deps.sources();
  if ('error' in src) return wait('optin_sources', `door data does not read: ${src.error.slice(0, 200)}`);
  const excluded = new Set([...deps.cfg.firstParty, ...deps.cfg.probes].map((w) => w.toLowerCase()));
  const subject = subjectFor(parsed, handle, src, excluded);
  if ('refused' in subject) return skip(subject.refused);

  let outcome: 'bound' | 'unbound' | string = '';
  try {
    deps.selfOptins.update((s) => {
      const cur = s[subject.section][subject.key];
      const mine = cur !== undefined && cur.handle.toLowerCase() === handle.toLowerCase();
      if (parsed.stop) {
        if (!mine) return void (outcome = 'stop from a handle that is not opted in');
        delete s[subject.section][subject.key];
        outcome = 'unbound';
      } else {
        if (mine) return void (outcome = 'already opted in');
        if (cur !== undefined) return void (outcome = 'already bound to another handle');
        s[subject.section][subject.key] = { handle, at: now, mentionId: m.id };
        outcome = 'bound';
      }
    });
  } catch (e) {
    return wait('optin_store', `${SELF_OPTINS_FILE} does not read or write: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  if (outcome !== 'bound' && outcome !== 'unbound') return skip(outcome);

  const who = `${NOUN[subject.section]} (${subject.key.slice(0, 10)})`;
  note(`${outcome} @${handle} as ${who}`);
  await tell(deps.tg, outcome === 'bound' ? `opt-in: @${handle} is now named as ${who}. To undo it, add the handle to blocklist.json.` : `opt-out: @${handle} is no longer named as ${who}.`);

  if (!m.conversationId) return 'silent';
  const result = await publish(deps, { kind: 'reply', key: `reply:${m.id}`, text: OPTIN_REPLY[outcome], replyTo: m.id, author: m.authorId, conversationId: m.conversationId });
  return result === 'posted' || result === 'dry_run' ? 'replied' : 'silent';
}
