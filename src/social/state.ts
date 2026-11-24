import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LogRow { at: number; kind: 'post' | 'reply' | 'skip' | 'error'; text: string; id?: string }

export interface SocialState {
  initialized: boolean;
  /** Event ids done: posted, skipped or given up. */
  seen: string[];
  /** Event id or reply key to failed X attempts. */
  attempts: Record<string, number>;
  mentionSinceId?: string;
  repliedConversations: string[];
  /** UTC YYYY-MM-DD the counters below belong to. */
  day: string;
  postsToday: number;
  repliesToday: number;
  authorRepliesToday: Record<string, number>;
  spendUsdToday: number;
  geminiCallsToday: number;
  capAlerted: boolean;
  paused: boolean;
  heartbeatAt?: number;
  /** Alert key to epoch ms, for "at most once an hour" alerts. Time based: it survives the day rollover. */
  alertedAt: Record<string, number>;
  week: { key: string; hoursPaidAtStart: number; summaryPosted: boolean; reportSent: boolean };
  /** The last 500 rows. */
  log: LogRow[];
}

const LOG_MAX = 500;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function fresh(day: string): SocialState {
  return {
    initialized: false,
    seen: [],
    attempts: {},
    repliedConversations: [],
    day,
    postsToday: 0,
    repliesToday: 0,
    authorRepliesToday: {},
    spendUsdToday: 0,
    geminiCallsToday: 0,
    capAlerted: false,
    paused: false,
    alertedAt: {},
    week: { key: '', hoursPaidAtStart: 0, summaryPosted: false, reportSent: false },
    log: [],
  };
}

/** The service's own state, one JSON file. Shared by the bot and the loops, so every update re-reads it first. */
export class StateStore {
  constructor(private readonly file: string, private readonly now: () => number) {}

  /** The file's state with the day rollover applied (not written until the next update). */
  get(): SocialState {
    return this.load();
  }

  update(fn: (s: SocialState) => void): SocialState {
    const s = this.load();
    fn(s);
    if (s.log.length > LOG_MAX) s.log = s.log.slice(-LOG_MAX);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    return s;
  }

  private load(): SocialState {
    const day = utcDay(this.now());
    let s = fresh(day);
    let text: string | undefined;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') s = this.setAside(day);
    }
    if (text !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      if (!isObj(raw)) s = this.setAside(day);
      else s = checked(raw, day);
    }
    if (s.day !== day) {
      // New UTC day: the counters restart. paused, seen, replies, heartbeat, alerts, week and log carry over.
      s.day = day;
      s.postsToday = 0;
      s.repliesToday = 0;
      s.authorRepliesToday = {};
      s.spendUsdToday = 0;
      s.geminiCallsToday = 0;
      s.capAlerted = false;
    }
    return s;
  }

  /** An unreadable or malformed file: keep it for Drew as `<file>.corrupt-<ms>` (best effort) and start paused, so caps and pauses are not silently forgotten. */
  private setAside(day: string): SocialState {
    try {
      renameSync(this.file, `${this.file}.corrupt-${this.now()}`);
    } catch {
      // Best effort.
    }
    const s = fresh(day);
    s.paused = true;
    return s;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNumMap = (v: unknown): v is Record<string, number> => isObj(v) && Object.values(v).every((x) => typeof x === 'number' && Number.isFinite(x));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const KINDS = ['post', 'reply', 'skip', 'error'];
const isLogRow = (v: unknown): v is LogRow =>
  isObj(v) && isNum(v.at) && typeof v.kind === 'string' && KINDS.includes(v.kind) && typeof v.text === 'string' && (v.id === undefined || typeof v.id === 'string');

/** Each field of the file that has the wrong type falls back to its fresh default; `paused` falls back to true. */
function checked(raw: Record<string, unknown>, day: string): SocialState {
  const d = fresh(day);
  const w = raw.week;
  const week =
    isObj(w) && typeof w.key === 'string' && isNum(w.hoursPaidAtStart) && typeof w.summaryPosted === 'boolean' && typeof w.reportSent === 'boolean'
      ? { key: w.key, hoursPaidAtStart: w.hoursPaidAtStart, summaryPosted: w.summaryPosted, reportSent: w.reportSent }
      : d.week;
  const s: SocialState = {
    initialized: typeof raw.initialized === 'boolean' ? raw.initialized : d.initialized,
    seen: isStrs(raw.seen) ? raw.seen : d.seen,
    attempts: isNumMap(raw.attempts) ? raw.attempts : d.attempts,
    repliedConversations: isStrs(raw.repliedConversations) ? raw.repliedConversations : d.repliedConversations,
    day: typeof raw.day === 'string' ? raw.day : d.day,
    postsToday: isNum(raw.postsToday) ? raw.postsToday : d.postsToday,
    repliesToday: isNum(raw.repliesToday) ? raw.repliesToday : d.repliesToday,
    authorRepliesToday: isNumMap(raw.authorRepliesToday) ? raw.authorRepliesToday : d.authorRepliesToday,
    spendUsdToday: isNum(raw.spendUsdToday) ? raw.spendUsdToday : d.spendUsdToday,
    geminiCallsToday: isNum(raw.geminiCallsToday) ? raw.geminiCallsToday : d.geminiCallsToday,
    capAlerted: typeof raw.capAlerted === 'boolean' ? raw.capAlerted : d.capAlerted,
    paused: raw.paused === undefined ? d.paused : typeof raw.paused === 'boolean' ? raw.paused : true,
    alertedAt: isNumMap(raw.alertedAt) ? raw.alertedAt : d.alertedAt,
    week,
    log: Array.isArray(raw.log) && raw.log.every(isLogRow) ? raw.log : d.log,
  };
  if (typeof raw.mentionSinceId === 'string') s.mentionSinceId = raw.mentionSinceId;
  if (isNum(raw.heartbeatAt)) s.heartbeatAt = raw.heartbeatAt;
  return s;
}
