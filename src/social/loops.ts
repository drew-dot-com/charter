import { compose } from './compose.js';
import { impliedSeen, detectEvents, STALE_EVENT_MS, type SocialEvent } from './events.js';
import { buildFactSheet, type OfferLite } from './facts.js';
import type { ConfigFiles } from './files.js';
import { hourlyAlertDue, MAX_ATTEMPTS, MAX_EVENT_POSTS_DAY, publish, tell } from './publish.js';
import { handleMention, type LoopDeps } from './replies.js';
import type { Sources } from './sources.js';
import type { LogRow, SocialState } from './state.js';
import { HEARTBEAT_MAX_AGE_MS } from './telegram.js';
import { costOf, type Mention } from './x.js';

export const EVENT_TICK_MS = 5 * 60_000;
export const MENTION_TICK_MS = 10 * 60_000;
export const WEEKLY_TICK_MS = 5 * 60_000;
/** Monday, UTC hours. */
export const REPORT_HOUR = 13;
export const SUMMARY_HOUR = 15;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const KILL_SWITCH_ALERT = 'kill_switch_offline';

const msg = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

/** ISO 8601 week of a UTC instant, as "YYYY-Www". */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const fromMonday = (d.getUTCDay() + 6) % 7;
  // The week belongs to the year of its Thursday.
  const thursday = midnight + (3 - fromMonday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Hours paid by outside renters: the same rule as the fact sheet's `totals:hours` (no excluded payer, no grant lease). */
export function outsideHoursPaid(src: Sources, excluded: ReadonlySet<string>): number {
  const grantLeases = new Set(src.grants.map((g) => g.leaseId).filter((x): x is string => !!x));
  return src.leases
    .filter((l) => l.payer && !excluded.has(l.payer.toLowerCase()) && !grantLeases.has(l.leaseId))
    .reduce((n, l) => n + l.ticksPaidByRenter, 0);
}

const excludedPayers = (deps: LoopDeps): ReadonlySet<string> => new Set([...deps.cfg.firstParty, ...deps.cfg.probes]);

function log(deps: LoopDeps, row: LogRow): void {
  try {
    deps.state.update((s) => void s.log.push(row));
  } catch {
    // best effort
  }
}

/** Telegram at most once an hour per key. Best effort. */
async function alertHourly(deps: LoopDeps, key: string, text: string, now: number): Promise<void> {
  let due = false;
  try {
    deps.state.update((s) => void (due = hourlyAlertDue(s, key, now)));
  } catch {
    return;
  }
  if (due) await tell(deps.tg, text);
}

/** The config files, or undefined after an hourly alert: a file that does not parse never opens the gates. */
async function loadFiles(deps: LoopDeps, now: number): Promise<ConfigFiles | undefined> {
  try {
    return deps.files();
  } catch (e) {
    await alertHourly(deps, 'config_files', `config files do not load, nothing posts: ${msg(e)}`, now);
    return undefined;
  }
}

type Block = 'paused' | 'kill_switch_offline' | 'spend_cap';

/**
 * The cheap check before any Gemini call or X read: paused, a heartbeat older than the limit (or that far in the
 * future), or a day's spend that cannot cover `nextCost` (or has reached the cap). Alerts the same way `publish` does:
 * the kill switch once an hour, the spend cap once a day. `publish` re-checks all of it before any X write.
 */
async function blocked(deps: LoopDeps, now: number, nextCost: number): Promise<Block | undefined> {
  let block: Block | undefined;
  let alert: string | undefined;
  const cap = deps.cfg.spendCapUsdDay;
  deps.state.update((s) => {
    if (s.paused) return void (block = 'paused');
    const age = s.heartbeatAt === undefined ? Number.POSITIVE_INFINITY : now - s.heartbeatAt;
    if (!(Math.abs(age) <= HEARTBEAT_MAX_AGE_MS)) {
      block = 'kill_switch_offline';
      if (hourlyAlertDue(s, KILL_SWITCH_ALERT, now)) {
        const mins = Number.isFinite(age) ? `${Math.round(age / 60_000)} min old` : 'never written';
        alert = `kill switch offline: the Telegram heartbeat is ${mins}. Nothing posts or replies until it is back.`;
      }
      return;
    }
    if (!(s.spendUsdToday < cap && s.spendUsdToday + nextCost <= cap)) {
      block = 'spend_cap';
      if (!s.capAlerted) {
        s.capAlerted = true;
        alert = `spend cap reached: ${s.spendUsdToday.toFixed(3)} of ${cap} USD spent today. Posts and replies stop until the UTC day ends.`;
      }
    }
  });
  if (alert) await tell(deps.tg, alert);
  return block;
}

function markSeen(deps: LoopDeps, e: SocialEvent, now: number, reason?: string): void {
  deps.state.update((s) => {
    for (const id of [e.id, ...impliedSeen(e)]) if (!s.seen.includes(id)) s.seen.push(id);
    if (reason) s.log.push({ at: now, kind: 'skip', text: `event ${e.id}: ${reason}`, id: e.id });
  });
}

/** Trusted text written by code: the event's kind, never anything from the data. */
const EVENT_BRIEF: Record<SocialEvent['kind'], string> = {
  renter_returned: 'A renter paid for another hour of the same lease: they came back.',
  milestone: 'A lease reached a milestone of hours paid.',
  grant_approved: 'A grant was approved: a free home for its grantee.',
  host_listed: 'A new host joined and was listed on the network.',
};

const briefFor = (e: SocialEvent): string =>
  `Event kind: ${e.kind}. ${EVENT_BRIEF[e.kind]} Write one post about this event. The facts whose id starts with "event:" describe it.`;

/**
 * Every 5 minutes. Unreadable door data or config skips the tick (one Telegram note an hour) and changes nothing
 * else. The first run marks everything seen and posts nothing. Then, oldest first: a stale event, a host no longer
 * listed, or an event past the day's cap is marked seen unposted; anything else is composed and published. Paused,
 * a dead kill switch or the spend cap stops the tick before any Gemini call and leaves the event for later.
 */
export async function eventTick(deps: LoopDeps): Promise<void> {
  const now = deps.now();
  const src = deps.sources();
  if ('error' in src) {
    await alertHourly(deps, 'event_sources', `event loop skipped: ${src.error}`, now);
    return;
  }
  const files = await loadFiles(deps, now);
  if (!files) return;

  const st = deps.state.get();
  const events = detectEvents(src, new Set(st.seen), deps.cfg);
  if (!st.initialized) {
    deps.state.update((s) => {
      for (const e of events) for (const id of [e.id, ...impliedSeen(e)]) if (!s.seen.includes(id)) s.seen.push(id);
      s.initialized = true;
    });
    return;
  }

  const hostState = new Map(src.hosts.map((h) => [h.hostId, h.state]));
  const excludePayers = excludedPayers(deps);
  let offers: OfferLite[] | undefined;

  for (const e of events) {
    if (now - e.at > STALE_EVENT_MS) {
      markSeen(deps, e, now, 'stale: older than 6 hours');
      continue;
    }
    if (e.kind === 'host_listed') {
      const hs = hostState.get(e.hostId);
      if (hs === 'dropped' || hs === 'hidden') {
        markSeen(deps, e, now, `host is ${hs}`);
        continue;
      }
    }
    if (deps.state.get().postsToday >= MAX_EVENT_POSTS_DAY) {
      // Ruling R6: past the day's cap an event rolls into the weekly totals.
      markSeen(deps, e, now, 'cap: daily event posts used, rolls into the weekly summary');
      continue;
    }
    if (await blocked(deps, now, costOf('post'))) return;

    if (!offers) {
      try {
        offers = await deps.offers();
      } catch (e2) {
        await alertHourly(deps, 'event_offers', `event loop skipped: no offers: ${msg(e2)}`, now);
        return;
      }
    }
    const facts = buildFactSheet({ event: e, src, offers, factsMd: files.factsMd, optins: files.optins, siteUrl: deps.cfg.siteUrl, now, excludePayers });
    const composed = await compose(
      { model: deps.model, writeModel: deps.cfg.gemini.modelWrite, checkModel: deps.cfg.gemini.modelCheck, files, siteHost: deps.cfg.siteUrl },
      { facts, task: 'post', brief: briefFor(e) },
    );
    if ('dropped' in composed) {
      const reasons = composed.dropped.join('; ');
      await tell(deps.tg, `post dropped: ${e.id}: ${reasons}`);
      markSeen(deps, e, now, `dropped: ${reasons}`);
      continue;
    }

    const result = await publish(deps, { kind: 'event', key: e.id, text: composed.text });
    if (result === 'posted' || result === 'dry_run') markSeen(deps, e, now);
    else if (result === 'cap') markSeen(deps, e, now, 'cap: daily event posts used, rolls into the weekly summary');
    else if (result === 'failed') {
      if ((deps.state.get().attempts[e.id] ?? 0) >= MAX_ATTEMPTS) markSeen(deps, e, now, `gave up after ${MAX_ATTEMPTS} attempts`);
    } else return; // paused, kill switch offline, spend cap: the event waits for a later tick
  }
}

/** Snowflake ids compare as integers; anything else sorts first and never advances the cursor. */
function idNum(id: string): bigint {
  return /^\d+$/.test(id) ? BigInt(id) : -1n;
}

/**
 * Every 10 minutes. Paused, a dead kill switch or the spend cap: no read at all, and the since id stays, so the
 * mentions are read next time (the 24 hour age limit still applies). Every read is charged to the day's spend.
 * The first run stores the newest id and replies to nothing. Then each mention, oldest first, goes through
 * `handleMention`, and the since id moves past it; a block that starts mid-tick stops before the next mention.
 */
export async function mentionTick(deps: LoopDeps): Promise<void> {
  const now = deps.now();
  if (await blocked(deps, now, 0)) return;

  const sinceId = deps.state.get().mentionSinceId;
  const r = await deps.x.mentions(sinceId);
  deps.state.update((s) => void (s.spendUsdToday += costOf('read', { count: r.mentions.length })));

  if (sinceId === undefined) {
    const newest = r.newestId ?? [...r.mentions].sort((a, b) => (idNum(b.id) > idNum(a.id) ? 1 : -1))[0]?.id;
    if (newest) deps.state.update((s) => void (s.mentionSinceId = newest));
    return;
  }

  const ordered: Mention[] = [...r.mentions].sort((a, b) => {
    const x = idNum(a.id);
    const y = idNum(b.id);
    return x === y ? a.createdAt - b.createdAt : x < y ? -1 : 1;
  });
  for (const m of ordered) {
    if (await blocked(deps, deps.now(), 0)) return;
    await handleMention(deps, m);
    deps.state.update((s) => {
      if (s.mentionSinceId === undefined || idNum(m.id) > idNum(s.mentionSinceId)) s.mentionSinceId = m.id;
    });
  }
}

/** The Monday report to Drew, from the last 7 days of the log and today's spend. */
export function weeklyReport(s: SocialState, now: number, week: string, cfg: { spendCapUsdDay: number }): string {
  const rows = s.log.filter((r) => r.at > now - WEEK_MS && r.at <= now);
  const posts = rows.filter((r) => r.kind === 'post');
  const dry = posts.filter((r) => r.text.startsWith('dry run: ')).length;
  const replies = rows.filter((r) => r.kind === 'reply').length;
  const mentionSkips = rows.filter((r) => r.kind === 'skip' && /^mention \S+: /.test(r.text));
  const byReason = new Map<string, number>();
  for (const r of mentionSkips) {
    const reason = r.text.replace(/^mention \S+: /, '').split(':')[0]!.trim();
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const reasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  const eventSkips = rows.filter((r) => r.kind === 'skip' && r.text.startsWith('event ')).length;
  const errors = rows.filter((r) => r.kind === 'error').length;
  const partial = s.log.length >= 500 && (s.log[0]?.at ?? 0) > now - WEEK_MS ? '\n(the log keeps 500 rows: counts are partial)' : '';
  return [
    `Weekly report ${week}, last 7 days:`,
    `posts: ${posts.length}${dry ? ` (${dry} dry run)` : ''}`,
    `replies: ${replies}`,
    `mentions seen: ${replies + mentionSkips.length}`,
    `mentions skipped: ${mentionSkips.length}${reasons ? ` (${reasons})` : ''}`,
    `events skipped: ${eventSkips}`,
    `errors: ${errors}`,
    `spend today: ${s.spendUsdToday.toFixed(3)} of ${cfg.spendCapUsdDay} USD (only today's spend is kept)`,
  ].join('\n') + partial;
}

const SUMMARY_BRIEF =
  "Weekly summary. Write one post with this week's totals only: leases running now, hours paid by outside renters this week, hosts listed, grants approved. Name no renter, grantee or host.";

/**
 * Every 5 minutes; acts on Mondays, once per ISO week: the report to Drew from 13:00 UTC, the summary post from
 * 15:00 UTC. `week.hoursPaidAtStart` is the outside hours paid when the last summary went out (or when the service
 * first ran), so "this week" is a diff. A Monday missed entirely, or one that ends before the summary could post,
 * skips that week's summary and takes a new snapshot.
 */
export async function weeklyTick(deps: LoopDeps): Promise<void> {
  const now = deps.now();
  const d = new Date(now);
  const week = isoWeekKey(now);
  const monday = d.getUTCDay() === 1;
  const hour = d.getUTCHours();
  const excluded = excludedPayers(deps);

  let src: Sources | undefined;
  const hoursNow = async (): Promise<number | undefined> => {
    if (!src) {
      const read = deps.sources();
      if ('error' in read) {
        await alertHourly(deps, 'weekly_sources', `weekly loop skipped: ${read.error}`, now);
        return undefined;
      }
      src = read;
    }
    return outsideHoursPaid(src, excluded);
  };

  let s = deps.state.get();
  if (s.week.key !== week) {
    const h = await hoursNow();
    if (h === undefined) return;
    const first = s.week.key === '';
    deps.state.update((st) => {
      if (first || !monday) {
        st.week = { key: week, hoursPaidAtStart: h, summaryPosted: true, reportSent: true };
        if (!first) st.log.push({ at: now, kind: 'skip', text: `weekly ${week}: Monday missed, no summary` });
      } else {
        st.week = { key: week, hoursPaidAtStart: st.week.hoursPaidAtStart, summaryPosted: false, reportSent: false };
      }
    });
    s = deps.state.get();
  }

  if (!monday) {
    if (s.week.summaryPosted && s.week.reportSent) return;
    const h = s.week.summaryPosted ? s.week.hoursPaidAtStart : await hoursNow();
    if (h === undefined) return;
    deps.state.update((st) => {
      if (!st.week.summaryPosted) st.log.push({ at: now, kind: 'skip', text: `weekly ${week}: Monday ended before the summary posted` });
      st.week = { key: week, hoursPaidAtStart: h, summaryPosted: true, reportSent: true };
    });
    return;
  }

  if (hour >= REPORT_HOUR && !s.week.reportSent) {
    await tell(deps.tg, weeklyReport(s, now, week, deps.cfg));
    deps.state.update((st) => void (st.week.reportSent = true));
  }

  if (hour < SUMMARY_HOUR || s.week.summaryPosted) return;
  const done = (h: number): void => {
    deps.state.update((st) => {
      st.week.summaryPosted = true;
      st.week.hoursPaidAtStart = h;
    });
  };

  if (await blocked(deps, now, costOf('post'))) return;
  const files = await loadFiles(deps, now);
  if (!files) return;
  const h = await hoursNow();
  if (h === undefined || !src) return;
  let offers: OfferLite[];
  try {
    offers = await deps.offers();
  } catch (e) {
    await alertHourly(deps, 'weekly_offers', `weekly summary waits: no offers: ${msg(e)}`, now);
    return;
  }
  const facts = buildFactSheet({ src, offers, factsMd: files.factsMd, optins: files.optins, siteUrl: deps.cfg.siteUrl, now, excludePayers: excluded });
  facts.facts.push({ id: 'week:hours', text: `Hours paid by outside renters this week: ${Math.max(0, h - s.week.hoursPaidAtStart)}.` });

  const composed = await compose(
    { model: deps.model, writeModel: deps.cfg.gemini.modelWrite, checkModel: deps.cfg.gemini.modelCheck, files, siteHost: deps.cfg.siteUrl },
    { facts, task: 'post', brief: SUMMARY_BRIEF },
  );
  if ('dropped' in composed) {
    const reasons = composed.dropped.join('; ');
    await tell(deps.tg, `summary dropped: ${week}: ${reasons}`);
    log(deps, { at: now, kind: 'skip', text: `weekly ${week}: dropped: ${reasons}` });
    return done(h);
  }
  const key = `summary:${week}`;
  const result = await publish(deps, { kind: 'summary', key, text: composed.text });
  if (result === 'posted' || result === 'dry_run') return done(h);
  if (result === 'failed' && (deps.state.get().attempts[key] ?? 0) >= MAX_ATTEMPTS) return done(h);
  // Paused, kill switch offline, spend cap, or a failure with attempts left: the next tick tries again.
}
