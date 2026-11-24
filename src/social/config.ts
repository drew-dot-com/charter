/** Parsing for charter-social's environment. See docs/superpowers/specs/2026-11-24-charter-x-account-design.md section 9. */

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

function list(v: string | undefined): Set<string> {
  return new Set((v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
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
  const geminiCallsCapDay = positive(env.GEMINI_CALLS_CAP_DAY, 200, 'GEMINI_CALLS_CAP_DAY', missing);

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
      firstParty: list(env.FIRST_PARTY_PAYERS),
      probes: list(env.PROBE_PAYERS),
      siteUrl: get('CHARTER_SITE_URL'),
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
