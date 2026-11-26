#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSocialConfig } from './config.js';
import { fetchOffers } from './facts.js';
import { loadConfigFiles } from './files.js';
import { LEADS_TICK_MS, leadsTick } from './leads.js';
import { EVENT_TICK_MS, eventTick, MENTION_TICK_MS, mentionTick, WEEKLY_TICK_MS, weeklyTick } from './loops.js';
import { geminiModel } from './model.js';
import { SELF_OPTINS_FILE, SelfOptinStore, withSelfOptins } from './optin.js';
import { hourlyAlertDue, postUrl, tell } from './publish.js';
import type { LoopDeps } from './replies.js';
import { readSources } from './sources.js';
import { StateStore, type SocialState } from './state.js';
import { runBot, telegramClient } from './telegram.js';
import { XClient } from './x.js';

/** X, the door's offers. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Telegram's getUpdates long-polls for 30 s, so its calls get room past that. */
export const TELEGRAM_FETCH_TIMEOUT_MS = 45_000;
/** Lets the bot write a fresh heartbeat before the first tick, so a restart does not read as a dead kill switch. */
export const FIRST_TICK_DELAY_MS = 60_000;

const HOUR_MS = 3_600_000;
const errText = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

/** `base` with a time limit on every call, keeping any signal the caller passed. */
export function timedFetch(ms: number, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const limit = AbortSignal.timeout(ms);
    return base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
  };
}

/** The Gemini call budget: one state update per call, refused once today's count reaches the cap. */
export function geminiAllowance(state: StateStore, cap: number): () => boolean {
  return () => {
    let ok = false;
    state.update((s) => {
      if (s.geminiCallsToday >= cap) return;
      s.geminiCallsToday += 1;
      ok = true;
    });
    return ok;
  };
}

function lastRow(s: SocialState, kind: 'post' | 'reply'): string {
  const r = [...s.log].reverse().find((row) => row.kind === kind);
  if (!r) return 'none';
  const what = r.id ? `${postUrl(r.id)} ${r.text}` : r.text;
  return `${new Date(r.at).toISOString()} ${what}`.slice(0, 300);
}

/** The /status answer: paused or live, DRY_RUN, last post, last reply, today's spend, missing settings. */
export function statusText(
  s: SocialState,
  o: { dryRun: boolean; missing: string[]; spendCapUsdDay?: number; geminiCallsCapDay?: number; now: number },
): string {
  const beat = s.heartbeatAt === undefined ? 'never' : `${Math.round((o.now - s.heartbeatAt) / 1000)} s ago`;
  return [
    `charter-social: ${s.paused ? 'PAUSED' : 'live'}, DRY_RUN ${o.dryRun ? 'on' : 'off'}`,
    `last post: ${lastRow(s, 'post')}`,
    `last reply: ${lastRow(s, 'reply')}`,
    `today: ${s.postsToday} event posts, ${s.repliesToday} replies`,
    `spend today: ${s.spendUsdToday.toFixed(3)} of ${o.spendCapUsdDay ?? '?'} USD`,
    `gemini calls today: ${s.geminiCallsToday} of ${o.geminiCallsCapDay ?? '?'}`,
    `heartbeat: ${beat}`,
    `missing settings: ${o.missing.length ? o.missing.join(', ') : 'none'}`,
  ].join('\n');
}

/** Runs `tick` every `everyMs` after each run ends, so a slow tick never overlaps itself. Stops on abort. */
export function schedule(
  name: string,
  everyMs: number,
  firstDelayMs: number,
  tick: () => Promise<void>,
  onError: (name: string, e: unknown) => Promise<void>,
  signal: AbortSignal,
): void {
  let timer: NodeJS.Timeout | undefined;
  const run = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      await tick();
    } catch (e) {
      await onError(name, e).catch(() => {});
    }
    if (!signal.aborted) timer = setTimeout(run, everyMs);
  };
  timer = setTimeout(run, firstDelayMs);
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
}

async function main(): Promise<number> {
  const env = process.env;
  const now = (): number => Date.now();
  const { config, missing } = parseSocialConfig(env, (p) => readFileSync(p, 'utf8'));
  for (const m of missing) console.error(`charter-social: missing setting: ${m}`);

  // The bot is the kill switch: without its token and chat nothing else may run.
  let token = '';
  try {
    token = readFileSync(env.TELEGRAM_BOT_TOKEN_FILE?.trim() ?? '', 'utf8').trim();
  } catch {
    token = '';
  }
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  if (!token || !chatId) {
    console.error('charter-social: TELEGRAM_BOT_TOKEN_FILE must name a readable token file and TELEGRAM_CHAT_ID must be set; exiting');
    return 1;
  }

  const state = new StateStore(join(config?.stateDir ?? (env.STATE_DIR?.trim() || '/state'), 'state.json'), now);
  const tg = telegramClient(token, chatId, timedFetch(TELEGRAM_FETCH_TIMEOUT_MS));
  const x = config ? new XClient(config.x, timedFetch(FETCH_TIMEOUT_MS)) : undefined;
  const dryRun = config?.dryRun ?? env.DRY_RUN !== '0';
  const status = (): string => {
    try {
      return statusText(state.get(), { dryRun, missing, spendCapUsdDay: config?.spendCapUsdDay, geminiCallsCapDay: config?.geminiCallsCapDay, now: now() });
    } catch (e) {
      return `status failed: ${errText(e)}`;
    }
  };

  const ac = new AbortController();
  const stop = (): void => ac.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const bot = runBot({
    tg,
    state,
    x: x ?? { delete: async () => Promise.reject(new Error('X keys are missing')) },
    chatId,
    now,
    status,
    signal: ac.signal,
  });

  if (config && x) {
    const offersFetch = timedFetch(FETCH_TIMEOUT_MS);
    const selfOptins = new SelfOptinStore(join(config.stateDir, SELF_OPTINS_FILE));
    const deps: LoopDeps = {
      state,
      x,
      tg,
      cfg: config,
      now,
      // Drew's files, with the self opt-ins merged under his optins.json. A self opt-in file that does not read throws here.
      files: () => withSelfOptins(loadConfigFiles(config.configDir), selfOptins.read()),
      selfOptins,
      model: geminiModel(config.gemini.apiKey, geminiAllowance(state, config.geminiCallsCapDay)),
      sources: () => readSources(config.dataDir, { allowAddress: config.allowAddress }),
      offers: () => fetchOffers(config.doorUrl, offersFetch),
    };
    // At most one Telegram alert an hour per loop; an in-memory clock covers a state file that cannot be written.
    const lastAlert = new Map<string, number>();
    const onError = async (loop: string, e: unknown): Promise<void> => {
      const text = `loop error: ${loop}: ${errText(e)}`;
      console.error(`charter-social: ${text}`);
      const at = now();
      let due: boolean;
      try {
        due = false;
        state.update((s) => void (due = hourlyAlertDue(s, `loop:${loop}`, at)));
      } catch {
        due = at - (lastAlert.get(loop) ?? 0) >= HOUR_MS;
      }
      if (due) {
        lastAlert.set(loop, at);
        await tell(tg, text);
      }
    };
    schedule('event', EVENT_TICK_MS, FIRST_TICK_DELAY_MS, () => eventTick(deps), onError, ac.signal);
    schedule('mention', MENTION_TICK_MS, FIRST_TICK_DELAY_MS, () => mentionTick(deps), onError, ac.signal);
    schedule('weekly', WEEKLY_TICK_MS, FIRST_TICK_DELAY_MS, () => weeklyTick(deps), onError, ac.signal);
    // Off until config/leads.json exists. It reads X and writes to Drew; it never posts.
    schedule('leads', LEADS_TICK_MS, FIRST_TICK_DELAY_MS, () => leadsTick({ ...deps, x }), onError, ac.signal);
    console.log(`charter-social up: DRY_RUN ${dryRun ? 'on' : 'off'}`);
    await tell(tg, `charter-social started: DRY_RUN ${dryRun ? 'on' : 'off'}`);
  } else {
    console.error('charter-social: loops idle until the missing settings are set; the bot answers /status');
    await tell(tg, `charter-social started with loops idle. missing settings: ${missing.join(', ')}`);
  }

  await bot;
  console.log('charter-social stopped');
  return 0;
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`charter-social: ${errText(e)}`);
      process.exit(1);
    },
  );
}
