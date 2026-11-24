import type { SocialConfig } from './config.js';
import type { SocialState, StateStore } from './state.js';
import { HEARTBEAT_MAX_AGE_MS, type Telegram } from './telegram.js';
import { costOf, XError, type XClient } from './x.js';

export type PublishResult = 'posted' | 'dry_run' | 'paused' | 'kill_switch_offline' | 'cap' | 'spend_cap' | 'failed';

export interface PublishDeps {
  state: StateStore;
  x: Pick<XClient, 'post'>;
  tg: Telegram;
  cfg: Pick<SocialConfig, 'dryRun' | 'spendCapUsdDay'>;
  now: () => number;
}

export interface PublishItem {
  kind: 'event' | 'summary' | 'reply';
  /** Event id, summary key or `reply:<mention id>`: the key failed attempts are counted under. */
  key: string;
  text: string;
  /** Reply only: the post replied to. */
  replyTo?: string;
  /** Reply only: the author's X user id, for the per-author cap. */
  author?: string;
  /** Reply only: X conversation_id, reserved for good before the X call. */
  conversationId?: string;
}

export const MAX_EVENT_POSTS_DAY = 4;
export const MAX_REPLIES_DAY = 20;
export const MAX_REPLIES_AUTHOR_DAY = 2;
export const MAX_ATTEMPTS = 3;

const HOUR_MS = 3_600_000;
const KILL_SWITCH_ALERT = 'kill_switch_offline';

export const postUrl = (id: string): string => `https://x.com/i/status/${id}`;

/**
 * Whether X would price the text as a post with a URL. Conservative: anything that looks like a link, a scheme or a
 * bare domain (X links those too), counts.
 */
export function hasLink(text: string): boolean {
  return /http|basescan\.org|x\.com|[a-z0-9-]\.[a-z]{2,}/i.test(text);
}

/** Best effort: a failing Telegram never changes what the caller does. */
export async function tell(tg: Telegram, text: string): Promise<void> {
  try {
    await tg.send(text);
  } catch {
    // best effort
  }
}

/** Sets `alertedAt[key]` and returns true when the key last alerted an hour or more ago (or never). Call inside an update. */
export function hourlyAlertDue(s: SocialState, key: string, now: number): boolean {
  const last = s.alertedAt[key];
  if (last !== undefined && now - last < HOUR_MS) return false;
  s.alertedAt[key] = now;
  return true;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * The one function that may call X's write endpoint. Every check reads the state file fresh, inside one atomic update,
 * in this order: paused, heartbeat (at most 15 minutes old), a key that already used its attempts, the caps for its
 * kind (a summary is exempt from the event cap), the day's spend cap. A reply then reserves its conversation and bumps
 * the reply counters before the X call; those stay reserved whatever X answers. Only `dryRun === false` posts live.
 * A failed X call (XError or any other throw) counts one attempt under `item.key`; at MAX_ATTEMPTS Drew is told and the
 * key is done: later calls with it return 'failed' without calling X. Telegram sends are best effort.
 */
export async function publish(deps: PublishDeps, item: PublishItem): Promise<PublishResult> {
  const { state, tg, cfg } = deps;
  const isReply = item.kind === 'reply';
  if (isReply && (!item.conversationId || !item.author || !item.replyTo)) {
    await tell(tg, `publish refused ${item.key}: a reply needs replyTo, author and conversationId`);
    return 'failed';
  }
  const live = cfg.dryRun === false;
  const cost = costOf('post', { hasUrl: hasLink(item.text) });
  const now = deps.now();

  let verdict: PublishResult | 'go' = 'go';
  let alert: string | undefined;
  let day = '';
  try {
    state.update((s) => {
      day = s.day;
      if (s.paused) return void (verdict = 'paused');
      const age = s.heartbeatAt === undefined ? Number.POSITIVE_INFINITY : now - s.heartbeatAt;
      // A heartbeat from more than the limit in the future is as untrustworthy as a stale one.
      if (!(Math.abs(age) <= HEARTBEAT_MAX_AGE_MS)) {
        verdict = 'kill_switch_offline';
        if (hourlyAlertDue(s, KILL_SWITCH_ALERT, now)) {
          const mins = Number.isFinite(age) ? `${Math.round(age / 60_000)} min old` : 'never written';
          alert = `kill switch offline: the Telegram heartbeat is ${mins}. Nothing posts or replies until it is back.`;
        }
        return;
      }
      if ((s.attempts[item.key] ?? 0) >= MAX_ATTEMPTS) return void (verdict = 'failed');
      if (item.kind === 'event' && s.postsToday >= MAX_EVENT_POSTS_DAY) return void (verdict = 'cap');
      if (isReply) {
        const author = item.author!;
        if (
          s.repliedConversations.includes(item.conversationId!) ||
          s.repliesToday >= MAX_REPLIES_DAY ||
          (s.authorRepliesToday[author] ?? 0) >= MAX_REPLIES_AUTHOR_DAY
        ) {
          return void (verdict = 'cap');
        }
      }
      if (!(s.spendUsdToday + cost <= cfg.spendCapUsdDay)) {
        verdict = 'spend_cap';
        if (!s.capAlerted) {
          s.capAlerted = true;
          alert = `spend cap reached: ${s.spendUsdToday.toFixed(3)} of ${cfg.spendCapUsdDay} USD spent today. Posts and replies stop until the UTC day ends.`;
        }
        return;
      }
      // Reserve. Spend is taken now (so a concurrent publish sees it) and given back if the call fails.
      if (live) s.spendUsdToday += cost;
      if (item.kind === 'event') s.postsToday += 1;
      if (isReply) {
        s.repliedConversations.push(item.conversationId!);
        s.repliesToday += 1;
        s.authorRepliesToday[item.author!] = (s.authorRepliesToday[item.author!] ?? 0) + 1;
      }
    });
  } catch (e) {
    await tell(tg, `publish ${item.key}: state write failed, nothing posted: ${msg(e)}`);
    return 'failed';
  }
  if (alert) await tell(tg, alert);
  if (verdict !== 'go') return verdict;

  const logKind = isReply ? 'reply' : 'post';
  const target = isReply ? `\nin reply to ${postUrl(item.replyTo!)}` : '';

  if (!live) {
    writeLog(state, { at: now, kind: logKind, text: `dry run: ${item.text}` });
    await tell(tg, `${isReply ? 'would reply' : 'would post'}: ${item.text}${target}`);
    return 'dry_run';
  }

  let id: string;
  try {
    id = await deps.x.post(item.text, item.replyTo);
  } catch (e) {
    const status = e instanceof XError ? `X status ${e.status}` : 'no X status';
    let tries = 0;
    try {
      state.update((s) => {
        tries = (s.attempts[item.key] ?? 0) + 1;
        s.attempts[item.key] = tries;
        // Undo the reservation on the same UTC day; a reply's conversation and counters stay taken.
        if (s.day === day) {
          s.spendUsdToday = Math.max(0, s.spendUsdToday - cost);
          if (item.kind === 'event') s.postsToday = Math.max(0, s.postsToday - 1);
        }
        s.log.push({ at: now, kind: 'error', text: `${item.key}: ${status}: ${msg(e)}` });
      });
    } catch {
      // The attempt could not be recorded; the reservation stands, which errs toward not posting.
    }
    if (tries >= MAX_ATTEMPTS) {
      await tell(tg, `gave up on ${item.key} after ${MAX_ATTEMPTS} attempts: ${status}: ${msg(e)}`);
    } else {
      await tell(tg, `post failed ${item.key} (attempt ${tries || '?'} of ${MAX_ATTEMPTS}): ${status}: ${msg(e)}`);
    }
    return 'failed';
  }

  writeLog(state, { at: now, kind: logKind, text: item.text, id });
  await tell(tg, `Posted ${postUrl(id)}\n${item.text}`);
  return 'posted';
}

/** Best effort: the post already happened and its reservation is recorded. */
function writeLog(state: StateStore, row: SocialState['log'][number]): void {
  try {
    state.update((s) => void s.log.push(row));
  } catch {
    // best effort
  }
}
