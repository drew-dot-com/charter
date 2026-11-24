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
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SocialState>;
      s = { ...s, ...raw };
    } catch {
      // Missing or unreadable: start fresh.
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
}
