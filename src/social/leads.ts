import { classifyLead, compose } from './compose.js';
import { buildFactSheet, type FactSheet } from './facts.js';
import { alertHourly, blocked, loadFiles } from './loops.js';
import { tell } from './publish.js';
import { preFilter, type LoopDeps } from './replies.js';
import type { SocialState } from './state.js';
import { costOf, type Mention, type XClient } from './x.js';

export const LEADS_TICK_MS = 10 * 60_000;
export const LEAD_MAX_AGE_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
/** X's smallest search page: a search is only made when the day's read budget can cover a full one. */
const PAGE = 10;

export type LeadsDeps = Omit<LoopDeps, 'x'> & { x: LoopDeps['x'] & Pick<XClient, 'search'> };

const bare = (h: string): string => String(h ?? '').trim().replace(/^@+/, '').toLowerCase();
const idNum = (id: string): bigint => (/^\d+$/.test(id) ? BigInt(id) : -1n);
const msg = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 200);

/** X's own compose page, opened as a reply to `postId` with `text` filled in. Drew posts it himself, by hand. */
export function intentUrl(postId: string, text: string): string {
  return `https://x.com/intent/post?in_reply_to=${encodeURIComponent(postId)}&text=${encodeURIComponent(text)}`;
}

/** What Drew gets: the stranger's post, the draft, and the link that opens X with the reply filled in. */
export function leadMessage(query: string, post: Mention, draft: string): string {
  return [
    `lead (search: ${query})`,
    `@${post.authorHandle}: ${post.text.replace(/\s+/g, ' ').slice(0, 300)}`,
    `https://x.com/i/status/${post.id}`,
    '',
    'draft reply:',
    draft,
    '',
    'To post it yourself, open this (logged in as the Charter account) and press Post:',
    intentUrl(post.id, draft),
  ].join('\n');
}

/** Why a found post is not even judged, or undefined. All in code, before any model call. */
export function leadGate(
  p: Mention,
  s: SocialState,
  ctx: { selfId: string; blocklist: Set<string>; banned: readonly string[]; now: number },
): string | undefined {
  if (!p.id || !p.authorId) return 'incomplete post';
  if (p.authorId === ctx.selfId) return 'self';
  const handle = bare(p.authorHandle);
  if (!handle) return 'no author handle';
  if (ctx.blocklist.has(handle)) return 'blocklisted author';
  if (ctx.banned.some((w) => w.trim() && handle.includes(w.trim().toLowerCase()))) return 'banned word in handle';
  if (!Number.isFinite(p.createdAt) || ctx.now - p.createdAt > LEAD_MAX_AGE_MS) return 'too old';
  if (s.leads.authors.includes(p.authorId)) return 'author already sent as a lead';
  return undefined;
}

/**
 * Every 10 minutes, acting once every `everyHours` (leads.json; no file, no loop). It only reads X and writes to
 * Drew: for each search query it reads the posts newer than the query's cursor (each charged as a read, within the
 * day's read budget), drops what the gate and the pre-filter refuse, asks the checker model whether the author is
 * looking for somewhere to run an agent, drafts a reply through the usual writer, lint and fact check, and sends
 * Drew the post, the draft and a link that opens X with the reply filled in. It never posts: X's API refuses a
 * reply to someone who has not mentioned or quoted the account, and an automated reply to a keyword search is
 * against X's automation rules. Paused, a dead kill switch or a cap: no read, and the run waits.
 */
export async function leadsTick(deps: LeadsDeps): Promise<void> {
  const now = deps.now();
  const files = await loadFiles(deps, now);
  const cfg = files?.leads;
  if (!files || !cfg || cfg.queries.length === 0) return;

  const last = deps.state.get().leads.lastRunAt;
  if (last !== undefined && now - last >= 0 && now - last < cfg.everyHours * HOUR_MS) return;
  if (await blocked(deps, now)) return;
  deps.state.update((s) => void (s.leads.lastRunAt = now));

  let facts: FactSheet;
  try {
    const src = deps.sources();
    if ('error' in src) throw new Error(`sources: ${src.error}`);
    const offers = await deps.offers();
    const excludePayers = new Set([...deps.cfg.firstParty, ...deps.cfg.probes]);
    facts = buildFactSheet({ src, offers, factsMd: files.factsMd, optins: files.optins, siteUrl: deps.cfg.siteUrl, now, excludePayers });
  } catch (e) {
    await alertHourly(deps, 'leads_facts', `leads wait: no fact sheet: ${msg(e)}`, now);
    return;
  }

  const skip = (p: Mention, reason: string): void => {
    deps.state.update((s) => void s.log.push({ at: now, kind: 'skip', text: `lead ${p.id}: ${reason}`, id: p.id }));
  };

  for (const query of cfg.queries) {
    const st = deps.state.get();
    if (st.leads.sentToday >= cfg.maxPerDay || st.leads.readsToday + PAGE > cfg.maxReadsPerDay) return;
    if (await blocked(deps, deps.now())) return;

    const r = await deps.x.search(query, st.leads.cursors[query]);
    const posts = [...r.posts].sort((a, b) => (idNum(a.id) < idNum(b.id) ? -1 : 1));
    const newest = r.newestId ?? posts[posts.length - 1]?.id;
    deps.state.update((s) => {
      s.spendUsdToday += costOf('read', { count: r.posts.length });
      s.leads.readsToday += r.posts.length;
      if (newest) s.leads.cursors[query] = newest;
      // A query taken out of leads.json loses its cursor.
      for (const q of Object.keys(s.leads.cursors)) if (!cfg.queries.includes(q)) delete s.leads.cursors[q];
    });

    for (const p of posts) {
      const s = deps.state.get();
      if (s.leads.sentToday >= cfg.maxPerDay) return;
      const refused = leadGate(p, s, { selfId: deps.cfg.x.userId, blocklist: files.blocklist, banned: files.rules.banned, now }) ?? preFilter(p.text, files.rules);
      if (refused) {
        skip(p, refused);
        continue;
      }
      if (await blocked(deps, deps.now())) return;

      const input = { text: p.text, authorHandle: p.authorHandle };
      let failed: string | undefined;
      const isLead = await classifyLead(deps.model, deps.cfg.gemini.modelCheck, input, (reason) => void (failed = reason));
      if (failed) {
        skip(p, failed);
        // The day's Gemini budget is gone: nothing more can be judged today.
        if (failed.endsWith('gemini cap')) return;
        continue;
      }
      if (!isLead) {
        // The text is kept so Drew can see what the judge turns down and tune leads.json.
        skip(p, `not a lead: @${bare(p.authorHandle)}: ${p.text.replace(/\s+/g, ' ').slice(0, 160)}`);
        continue;
      }

      const composed = await compose(
        { model: deps.model, writeModel: deps.cfg.gemini.modelWrite, checkModel: deps.cfg.gemini.modelCheck, files, siteHost: deps.cfg.siteUrl },
        { facts, task: 'lead', brief: LEAD_BRIEF, mention: input },
      );
      if ('dropped' in composed) {
        const reasons = composed.dropped.join('; ');
        skip(p, `draft dropped: ${reasons}`);
        if (composed.dropped.some((d) => d.endsWith('gemini cap'))) return;
        continue;
      }

      // The author is recorded before the send, so a Telegram failure can never lead to a second pitch.
      deps.state.update((x) => {
        x.leads.authors.push(p.authorId);
        x.leads.sentToday += 1;
        x.log.push({ at: now, kind: 'lead', text: `@${bare(p.authorHandle)}: ${composed.text}`, id: p.id });
      });
      await tell(deps.tg, leadMessage(query, p, composed.text));
    }
  }
}

/** Trusted text written by code. */
const LEAD_BRIEF =
  'A stranger posted that they are looking for somewhere to run an AI agent. Draft a reply that Drew may post by hand. Say what Charter is, what a home costs, that it needs no signup if a fact says so, and give the site link.';
