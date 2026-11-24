import { classify, compose } from './compose.js';
import type { SocialConfig } from './config.js';
import type { SocialEvent } from './events.js';
import { buildFactSheet, type FactSheet, type OfferLite } from './facts.js';
import type { ConfigFiles, Optins, Rules } from './files.js';
import { bannedWordRe } from './lint.js';
import type { Model } from './model.js';
import { hourlyAlertDue, MAX_REPLIES_AUTHOR_DAY, MAX_REPLIES_DAY, publish, tell, type PublishDeps } from './publish.js';
import type { Sources } from './sources.js';
import type { LogRow, SocialState } from './state.js';
import type { Mention, XClient } from './x.js';

export const MENTION_MAX_AGE_MS = 24 * 3_600_000;

export interface LoopDeps extends PublishDeps {
  cfg: SocialConfig;
  /** Re-read on every call, so Drew's edits apply on the next tick. */
  files: () => ConfigFiles;
  x: Pick<XClient, 'post' | 'mentions' | 'delete'>;
  model: Model;
  /** readSources(cfg.dataDir) */
  sources: () => Sources | { error: string };
  /** fetchOffers(cfg.doorUrl) */
  offers: () => Promise<OfferLite[]>;
}

const bare = (h: string): string => String(h ?? '').trim().replace(/^@+/, '').toLowerCase();

/** The hard limits on replying (spec section 5), from the state as read now. */
export function replyGate(m: Mention, s: SocialState, ctx: { selfId: string; blocklist: Set<string>; now: number }): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!ctx.selfId) return no('own user id unknown');
  if (!m.id || !m.authorId || !m.conversationId) return no('incomplete mention');
  if (m.authorId === ctx.selfId) return no('self');
  // X can omit the user expansion; an author we cannot name cannot be checked against the blocklist.
  if (!bare(m.authorHandle)) return no('no author handle');
  if (ctx.blocklist.has(bare(m.authorHandle))) return no('blocklisted author');
  if (!Number.isFinite(m.createdAt) || ctx.now - m.createdAt > MENTION_MAX_AGE_MS) return no('too old');
  if (s.repliedConversations.includes(m.conversationId)) return no('conversation already replied');
  if (s.repliesToday >= MAX_REPLIES_DAY) return no('daily reply cap: 20 replies today');
  if ((s.authorRepliesToday[m.authorId] ?? 0) >= MAX_REPLIES_AUTHOR_DAY) return no('author reply cap: 2 replies today');
  return { ok: true };
}

const PATTERNS: [RegExp, string][] = [
  [/\btoken/i, 'token'],
  [/airdrop/i, 'airdrop'],
  [/send me/i, 'send me'],
  [/0x[0-9a-f]{40}/i, 'wallet address'],
  [/ignore (all |previous|prior)/i, 'ignore instructions'],
  [/system prompt/i, 'system prompt'],
  [/you are now/i, 'you are now'],
];
/** Also matched with their letters spaced out, like the banned list. */
const SPACED = ['token', 'airdrop'];

/**
 * Code's first pass over an untrusted mention: the reason to drop it, or null to continue. The text is NFKC-folded
 * first, so fullwidth and other compatibility look-alikes match too.
 */
export function preFilter(text: string, rules: Rules): string | null {
  const t = String(text ?? '').normalize('NFKC');
  for (const [re, name] of PATTERNS) if (re.test(t)) return `pre-filter: ${name}`;
  const folded = t.toLowerCase();
  for (const w of [...SPACED, ...rules.banned]) {
    const word = w.toLowerCase().trim();
    if (word && bannedWordRe(word).test(folded)) return `pre-filter: banned word ${word}`;
  }
  return null;
}

/** Lowercased handles of everyone who opted in, in any section. */
function optedInHandles(optins: Optins): Set<string> {
  const out = new Set<string>();
  for (const section of [optins.renters, optins.grants, optins.hosts]) {
    for (const o of Object.values(section)) if (o.handle && bare(o.handle)) out.add(bare(o.handle));
  }
  return out;
}

/**
 * A synthetic renter_returned event for the author's newest lease, so the fact sheet names them and carries that
 * lease's newest tick tx. Only for a handle on an `optins.renters` entry; never for a probe or first-party wallet.
 */
function receiptEvent(m: Mention, src: Sources, optins: Optins, excluded: ReadonlySet<string>, now: number): SocialEvent | undefined {
  const handle = bare(m.authorHandle);
  const wallets = new Set(
    Object.entries(optins.renters)
      .filter(([w, o]) => o.handle && bare(o.handle) === handle && !excluded.has(w.toLowerCase()))
      .map(([w]) => w.toLowerCase()),
  );
  if (!wallets.size) return undefined;
  const lease = src.leases
    .filter((l) => l.payer && wallets.has(l.payer.toLowerCase()))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!lease?.payer) return undefined;
  return { id: `reply:${m.id}`, kind: 'renter_returned', at: now, leaseId: lease.leaseId, payer: lease.payer, hoursPaid: lease.ticksPaidByRenter };
}

const BRIEF = {
  question: 'Answer the question in the mention, using only the facts. Say less rather than more. If the facts do not answer it, return no candidates.',
  tenant: 'The author is a Charter tenant who opted in to be named, posting about their home. Reply briefly and calmly, using only the facts. If the facts give nothing to say, return no candidates.',
};

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

/**
 * The reply pipeline for one untrusted mention: hard limits, pre-filter, fact sheet, classifier (a `tenant` label
 * stands only for an opted-in handle), writer and checker, then `publish`. Every way out that is not a reply is
 * silence on X. 'skipped' = a hard rule, the pre-filter or publish refused it; 'silent' = it was read and left alone.
 */
export async function handleMention(deps: LoopDeps, m: Mention): Promise<'replied' | 'silent' | 'skipped'> {
  const now = deps.now();
  const skip = (kind: 'skipped' | 'silent', reason: string): 'skipped' | 'silent' => {
    log(deps, { at: now, kind: 'skip', text: `mention ${m.id}: ${reason}`, id: m.id });
    return kind;
  };

  let files: ConfigFiles;
  try {
    files = deps.files();
  } catch (e) {
    await alertHourly(deps, 'reply_config', `replies off: config files do not load: ${(e as Error)?.message ?? e}`, now);
    return skip('skipped', 'config files do not load');
  }

  const gate = replyGate(m, deps.state.get(), { selfId: deps.cfg.x.userId, blocklist: files.blocklist, now });
  if (!gate.ok) return skip('skipped', gate.reason);

  const filtered = preFilter(m.text, files.rules);
  if (filtered) return skip('skipped', filtered);

  // Facts before the classifier, which labels against them. No facts, no reply.
  const excludePayers: ReadonlySet<string> = new Set([...deps.cfg.firstParty, ...deps.cfg.probes]);
  let src: Sources;
  let factsFor: (event?: SocialEvent) => FactSheet;
  let facts: FactSheet;
  try {
    const read = deps.sources();
    if ('error' in read) throw new Error(`sources: ${read.error}`);
    src = read;
    const offers = await deps.offers();
    factsFor = (event) => buildFactSheet({ event, src: read, offers, factsMd: files.factsMd, optins: files.optins, siteUrl: deps.cfg.siteUrl, now, excludePayers });
    facts = factsFor();
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    await alertHourly(deps, 'reply_facts', `replies silent: no fact sheet: ${why}`, now);
    return skip('silent', `no fact sheet: ${why}`);
  }

  const input = { text: m.text, authorHandle: m.authorHandle };
  const notes: string[] = [];
  let label = await classify(deps.model, deps.cfg.gemini.modelCheck, input, facts, (r) => notes.push(r));
  if (notes.length) log(deps, { at: now, kind: 'error', text: `mention ${m.id}: ${notes.join('; ')}` });
  if (label === 'tenant' && !optedInHandles(files.optins).has(bare(m.authorHandle))) label = 'other';
  if (label === 'other') return skip('silent', 'other');
  if (label === 'tenant') {
    // An opted-in renter's reply carries a receipt; a grantee or host gets the plain facts.
    const event = receiptEvent(m, src, files.optins, excludePayers, now);
    if (event) {
      try {
        facts = factsFor(event);
      } catch (e) {
        return skip('silent', `no fact sheet: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
  }

  const composed = await compose(
    { model: deps.model, writeModel: deps.cfg.gemini.modelWrite, checkModel: deps.cfg.gemini.modelCheck, files, siteHost: deps.cfg.siteUrl },
    { facts, task: 'reply', brief: BRIEF[label], mention: input },
  );
  if ('dropped' in composed) {
    const reasons = composed.dropped.join('; ');
    await tell(deps.tg, `reply dropped: ${reasons} (mention ${m.id})`);
    return skip('silent', `reply dropped: ${reasons}`);
  }

  const result = await publish(deps, {
    kind: 'reply',
    key: `reply:${m.id}`,
    text: composed.text,
    replyTo: m.id,
    author: m.authorId,
    conversationId: m.conversationId,
  });
  if (result === 'posted' || result === 'dry_run') return 'replied';
  return skip('skipped', `publish: ${result}`);
}
