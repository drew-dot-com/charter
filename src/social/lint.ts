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

const SCHEME_URL = /https?:\/\/[^\s]+/gi;
const BARE_DOMAIN = /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;
const PLACEHOLDER = '\u0001';
const WORD = '\\p{L}\\p{N}_';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase host without scheme, path or a leading "www.". */
function hostOf(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0]!.replace(/^www\./, '');
}

/** Scheme-less, lowercased, no trailing slash: "basescan.org/tx/0x..". */
function canonical(raw: string): string {
  return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/** Every link in the text (with or without scheme), plus the text with each replaced by a placeholder. */
function extractLinks(text: string): { links: string[]; stripped: string } {
  const links: string[] = [];
  const take = (m: string): string => {
    const clean = m.replace(TRAILING_PUNCT, '');
    links.push(clean);
    return PLACEHOLDER + m.slice(clean.length);
  };
  const stripped = text.replace(SCHEME_URL, take).replace(BARE_DOMAIN, take);
  return { links, stripped };
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

/** Digits with thousands commas removed. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
}

/** Lowercase, compatibility-fold, drop zero-width characters, so disguised words still match. */
function foldForWords(text: string): string {
  return text.normalize('NFKC').replace(/[​-‏⁠﻿­]/g, '').toLowerCase();
}

/** Deterministic gate: returns the reasons a text may not be published. Empty means pass. */
export function lint(text: string, ctx: LintCtx): string[] {
  const out: string[] = [];
  if (text.trim() === '') return ['empty text'];

  if (/[‒–—―]|--/.test(text)) out.push('contains a dash');
  if (/\$\p{L}/u.test(text)) out.push('contains a $ticker');
  if (/#[\p{L}\p{N}_]/u.test(text)) out.push('contains a hashtag');

  const { links, stripped } = extractLinks(text);
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

  const folded = foldForWords(text);
  for (const word of ctx.rules.banned) {
    const w = foldForWords(word).trim();
    if (!w) continue;
    const pre = `(?<![${WORD}])`;
    const post = `(?![${WORD}])`;
    if (new RegExp(pre + escapeRe(w) + post, 'u').test(folded)) {
      out.push(`banned word: ${w}`);
      continue;
    }
    const letters = Array.from(w).filter((c) => /\S/u.test(c));
    if (letters.length > 1 && new RegExp(pre + letters.map(escapeRe).join('[ .]') + post, 'u').test(folded)) {
      out.push(`banned word spelled out: ${w}`);
    }
  }

  const known = new Set(ctx.facts.facts.flatMap((f) => numbersIn(f.text)));
  for (const n of new Set(numbersIn(stripped))) {
    if (!known.has(n)) out.push(`number not in the facts: ${n}`);
  }

  return out;
}
