import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A tenant who agreed to be named. `handle` has no leading '@'. */
export interface Optin { name: string; handle?: string }
/** Keys are lowercased: wallet addresses for renters, grant ids, host ids. */
export interface Optins { renters: Record<string, Optin>; grants: Record<string, Optin>; hosts: Record<string, Optin> }
export interface Rules { banned: string[] }
export interface ConfigFiles { factsMd: string; rules: Rules; optins: Optins; blocklist: Set<string> }

export const DEFAULT_BANNED = ['token', 'airdrop', 'presale', 'guarantee', 'escape', 'jailbreak', 'unfenced', 'toon'];

/** The file's text, or undefined when it does not exist. Any other read error propagates. */
function read(dir: string, name: string): string | undefined {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

const bare = (h: string): string => h.trim().replace(/^@+/, '');

function optinMap(raw: unknown): Record<string, Optin> {
  const out: Record<string, Optin> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const { name, handle } = v as { name?: unknown; handle?: unknown };
    if (typeof name !== 'string' || !name.trim()) continue;
    const o: Optin = { name: name.trim() };
    if (typeof handle === 'string' && bare(handle)) o.handle = bare(handle);
    out[k.trim().toLowerCase()] = o;
  }
  return out;
}

/**
 * Loads the files Drew edits: facts.md, rules.json, optins.json, blocklist.json. An absent file takes its default
 * (nobody opted in, nobody blocked); a file that exists but does not parse throws, so a typo never opens the gates.
 * The effective banned list is the union of DEFAULT_BANNED and
 * the words in rules.json (lowercased, deduped): the file can add words, never remove one, and `toon` is always present.
 * blocklist.json must be an array of strings; any other shape throws.
 */
export function loadConfigFiles(dir: string): ConfigFiles {
  const factsMd = read(dir, 'facts.md') ?? '';

  const rulesText = read(dir, 'rules.json');
  const rulesRaw = rulesText === undefined ? undefined : (JSON.parse(rulesText) as { banned?: unknown });
  const fromFile = Array.isArray(rulesRaw?.banned) ? rulesRaw.banned.filter((w): w is string => typeof w === 'string') : undefined;
  const banned = [...new Set([...DEFAULT_BANNED, ...(fromFile ?? []), 'toon'].map((w) => w.trim().toLowerCase()).filter(Boolean))];

  const optText = read(dir, 'optins.json');
  const optRaw = (optText === undefined ? {} : JSON.parse(optText)) as Record<string, unknown>;
  const optins: Optins = { renters: optinMap(optRaw.renters), grants: optinMap(optRaw.grants), hosts: optinMap(optRaw.hosts) };

  const blockText = read(dir, 'blocklist.json');
  const blockRaw = blockText === undefined ? [] : (JSON.parse(blockText) as unknown);
  if (!Array.isArray(blockRaw) || blockRaw.some((h) => typeof h !== 'string')) throw new Error('blocklist.json must be an array of handle strings');
  const blocklist = new Set((blockRaw as string[]).map((h) => bare(h).toLowerCase()).filter(Boolean));

  return { factsMd, rules: { banned }, optins, blocklist };
}
