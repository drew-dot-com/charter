/** Parsing for charter-social's environment. See docs/superpowers/specs/2026-11-24-charter-x-account-design.md section 9. */
import { DEFAULT_BANNED } from './files.js';
import { costOf } from './x.js';

export interface SocialConfig {
  x: { consumerKey: string; consumerSecret: string; accessToken: string; accessSecret: string; userId: string };
  gemini: { apiKey: string; modelWrite: string; modelCheck: string };
  telegram: { token: string; chatId: string };
  /** Lowercased addresses. */
  firstParty: Set<string>;
  probes: Set<string>;
  siteUrl: string;
  doorUrl: string;
  dataDir: string;
  stateDir: string;
  configDir: string;
  dryRun: boolean;
  spendCapUsdDay: number;
  /** GEMINI_CALLS_CAP_DAY, default 200. */
  geminiCallsCapDay: number;
}

const REQUIRED = [
  'X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'X_USER_ID',
  'GEMINI_API_KEY', 'GEMINI_MODEL_WRITE', 'GEMINI_MODEL_CHECK',
  'TELEGRAM_BOT_TOKEN_FILE', 'TELEGRAM_CHAT_ID', 'CHARTER_SITE_URL',
] as const;

/** The dearest X write, a post with a link: a smaller daily cap could never post anything. */
const MIN_SPEND_CAP = costOf('post', { hasUrl: true });

const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * A comma-separated wallet list, lowercased. Every entry must be an EVM address: a typo would silently let that
 * wallet's leases read as an outsider's, so it is named in `missing` (first 6 characters only) instead.
 */
function payers(name: string, v: string | undefined, missing: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of (v ?? '').split(',')) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (ADDRESS.test(a)) out.add(a);
    else missing.push(`${name} has a bad address: ${raw.trim().slice(0, 6)}\u2026`);
  }
  return out;
}

/** The host of a site URL, with or without a scheme, lowercased. */
function hostOf(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function positive(v: string | undefined, dflt: number, name: string, missing: string[]): number {
  const s = v?.trim();
  if (!s) return dflt;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    missing.push(`${name} must be a positive number`);
    return dflt;
  }
  return n;
}

/**
 * Parses the environment. Anything required and absent (or invalid) is listed in `missing` and no config is returned,
 * so the service can keep its Telegram bot up and say what is wrong. The Telegram token is read through `readFile`
 * from TELEGRAM_BOT_TOKEN_FILE and is never an env value. DRY_RUN is on unless it is exactly "0".
 */
export function parseSocialConfig(env: NodeJS.ProcessEnv, readFile: (p: string) => string): { config?: SocialConfig; missing: string[] } {
  const missing: string[] = [];
  const get = (k: string): string => (env[k] ?? '').trim();
  for (const k of REQUIRED) if (!get(k)) missing.push(k);

  let token = '';
  const tokenFile = get('TELEGRAM_BOT_TOKEN_FILE');
  if (tokenFile) {
    try {
      token = readFile(tokenFile).trim();
    } catch {
      token = '';
    }
    if (!token) missing.push('TELEGRAM_BOT_TOKEN_FILE');
  }

  const write = get('GEMINI_MODEL_WRITE');
  const check = get('GEMINI_MODEL_CHECK');
  if (write && check && write === check) missing.push('GEMINI_MODEL_CHECK must differ from GEMINI_MODEL_WRITE');

  const spendCapUsdDay = positive(env.SPEND_CAP_USD_DAY, 2, 'SPEND_CAP_USD_DAY', missing);
  if (spendCapUsdDay < MIN_SPEND_CAP) missing.push(`SPEND_CAP_USD_DAY must be at least ${MIN_SPEND_CAP}, the cost of one post with a link`);
  const geminiCallsCapDay = positive(env.GEMINI_CALLS_CAP_DAY, 200, 'GEMINI_CALLS_CAP_DAY', missing);

  // Leases paid by these wallets never produce a post; an empty list would make Drew's own leases outsiders.
  const firstParty = payers('FIRST_PARTY_PAYERS', env.FIRST_PARTY_PAYERS, missing);
  if (firstParty.size === 0 && !missing.some((m) => m.startsWith('FIRST_PARTY_PAYERS'))) missing.push('FIRST_PARTY_PAYERS');
  const probes = payers('PROBE_PAYERS', env.PROBE_PAYERS, missing);

  // Ruling R18: posts link to the site, so its host must not carry a banned word (e.g. toonprotocol).
  const siteUrl = get('CHARTER_SITE_URL');
  if (siteUrl) {
    const host = hostOf(siteUrl);
    const word = DEFAULT_BANNED.find((w) => host.includes(w));
    if (word) missing.push(`CHARTER_SITE_URL host contains a banned word: ${word}`);
  }

  if (missing.length) return { missing };
  return {
    missing,
    config: {
      x: {
        consumerKey: get('X_CONSUMER_KEY'),
        consumerSecret: get('X_CONSUMER_SECRET'),
        accessToken: get('X_ACCESS_TOKEN'),
        accessSecret: get('X_ACCESS_SECRET'),
        userId: get('X_USER_ID'),
      },
      gemini: { apiKey: get('GEMINI_API_KEY'), modelWrite: write, modelCheck: check },
      telegram: { token, chatId: get('TELEGRAM_CHAT_ID') },
      firstParty,
      probes,
      siteUrl,
      doorUrl: get('CHARTER_DOOR_URL') || 'http://charter-door:3701',
      dataDir: get('CHARTER_DATA_DIR') || '/data',
      stateDir: get('STATE_DIR') || '/state',
      configDir: get('CONFIG_DIR') || '/config',
      dryRun: env.DRY_RUN !== '0',
      spendCapUsdDay,
      geminiCallsCapDay,
    },
  };
}
