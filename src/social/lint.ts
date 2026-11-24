import type { FactSheet } from './facts.js';
import type { Rules } from './files.js';

export const X_MAX_CHARS = 280;
/** X wraps every link in t.co, which counts as 23 characters. */
const URL_CHARS = 23;

export interface LintCtx {
  facts: FactSheet;
  rules: Rules;
  siteHost: string;
  replyToHandle?: string;
  selfHandle?: string;
}

const LINK_CHARS = "A-Za-z0-9\\-._~:/?#@!$&'*+,;=%";
const SCHEME_URL = new RegExp(`https?://[${LINK_CHARS}]*`, 'gi');
const BARE_DOMAIN = new RegExp(`(?<![\\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}(?::\\d+)?(?:/[${LINK_CHARS}]*)?`, 'gi');
/** What may directly follow a link token: whitespace, end of text, or sentence punctuation. */
const AFTER_LINK = /^(?:\s|$|[.,!?:;)']+(?:\s|$))/;
const TRAILING_PUNCT = /[.,!?:;)']+$/;
const PLACEHOLDER = '\u0001';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase host without scheme, path or a leading "www.". */
function hostOf(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0]!.replace(/^www\./, '');
}

/** Scheme-less, lowercased, no trailing slash: "basescan.org/tx/0x..". */
function canonical(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/** Every link in the text (with or without scheme), the text with each replaced by a placeholder, and token-level problems. */
function extractLinks(text: string): { links: string[]; stripped: string; problems: string[] } {
  const links: string[] = [];
  const problems: string[] = [];
  const take = (m: string, offset: number, whole: string): string => {
    const clean = m.replace(TRAILING_PUNCT, '');
    if (!AFTER_LINK.test(whole.slice(offset + m.length))) problems.push(`link followed by text: ${clean}`);
    const rest = clean.replace(/^https?:\/\//i, '');
    if (rest.includes('://') || rest.includes('@') || /[!',;*+=](?:[a-z0-9-]+\.)+[a-z]{2,}/i.test(rest.replace(/^[^/?#]*/, ''))) {
      problems.push(`malformed link: ${clean}`);
    }
    links.push(clean);
    return PLACEHOLDER + m.slice(clean.length);
  };
  const stripped = text.replace(SCHEME_URL, take).replace(BARE_DOMAIN, take);
  return { links, stripped, problems };
}

function linkProblem(link: string, ctx: LintCtx): string | undefined {
  const host = hostOf(link);
  const path = canonical(link).slice(host.length);
  if (host === hostOf(ctx.siteHost)) return undefined;
  if (host === 'basescan.org') {
    const ok = ctx.facts.txLinks.some((t) => canonical(t) === canonical(link));
    return ok ? undefined : `basescan link not in the fact sheet: ${link}`;
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const m = /^\/([^/]+)\/status\/\d+$/.exec(path);
    if (m && ctx.selfHandle && m[1]!.toLowerCase() === ctx.selfHandle.toLowerCase()) return undefined;
    return `x.com link is not one of our own posts: ${link}`;
  }
  return `link to a host that is not allowed: ${host}`;
}

/** Numbers; commas are removed only inside proper thousands groups, any other comma separates numbers. */
function numbersIn(text: string): string[] {
  const re = /\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?/g;
  return (text.match(re) ?? []).map((n) => n.replace(/,/g, ''));
}

/**
 * A banned word as a whole word in lowercased text, its letters allowed to be split by any run of non-alphanumerics
 * ("t o k e n", "t.o.k.e.n"), with an optional inflection ("tokens", "escaped", "jailbreaking"). Shared by lint and
 * the reply pre-filter.
 */
export function bannedWordRe(word: string): RegExp {
  const letters = Array.from(word.toLowerCase().trim()).filter((c) => /\S/.test(c));
  return new RegExp('(?<![a-z0-9])' + letters.map(escapeRe).join('[^a-z0-9]*') + '(?:s|es|d|ed|ing)?(?![a-z0-9])');
}

/** Deterministic gate: returns the reasons a text may not be published. Empty means pass. */
export function lint(text: string, ctx: LintCtx): string[] {
  const out: string[] = [];
  if (text.trim() === '') return ['empty text'];

  if (/[^\x20-\x7E\n]/.test(text)) out.push('non-ASCII character');
  if (/[\u2012\u2013\u2014\u2015]|--/.test(text)) out.push('contains a dash');
  if (/[<>`{}|\\^]/.test(text)) out.push('forbidden character');
  if (/\$\p{L}/u.test(text)) out.push('contains a $ticker');
  if (/#[\p{L}\p{N}_]/u.test(text)) out.push('contains a hashtag');

  const { links, stripped, problems } = extractLinks(text);
  out.push(...problems);
  if (links.length > 1) out.push(`more than one link (${links.length})`);
  for (const l of links) {
    const p = linkProblem(l, ctx);
    if (p) out.push(p);
  }

  const length = Array.from(stripped.split(PLACEHOLDER).join('x'.repeat(URL_CHARS))).length;
  if (length > X_MAX_CHARS) out.push(`over ${X_MAX_CHARS} characters (${length})`);

  const allowed = new Set(ctx.facts.mentionable.map((h) => h.toLowerCase()));
  if (ctx.replyToHandle) allowed.add(ctx.replyToHandle.toLowerCase());
  for (const m of text.matchAll(/@(\w+)/g)) {
    if (!allowed.has(m[1]!.toLowerCase())) out.push(`@${m[1]} is not allowed to be mentioned`);
  }

  const folded = text.toLowerCase();
  for (const word of ctx.rules.banned) {
    const w = word.toLowerCase().trim();
    if (w && bannedWordRe(w).test(folded)) out.push(`banned word: ${w}`);
  }

  const known = new Set(ctx.facts.facts.flatMap((f) => numbersIn(f.text)));
  for (const n of new Set(numbersIn(stripped))) {
    if (!known.has(n)) out.push(`number not in the facts: ${n}`);
  }

  return out;
}
