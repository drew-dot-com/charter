import type { StateStore } from './state.js';
import { XError, type XClient } from './x.js';

export const COMMAND_MAX_AGE_MS = 10 * 60_000;
export const HEARTBEAT_MAX_AGE_MS = 15 * 60_000;

export interface TgUpdate { updateId: number; chatId: string; text: string; date: number }

export interface Telegram {
  send(text: string): Promise<void>;
  /** `date` is in seconds. An update with no text message comes back with empty chatId and text so the offset can still move past it. */
  updates(offset?: number, timeoutS?: number): Promise<TgUpdate[]>;
}

/** Telegram Bot API over fetch. The token sits in the URL path, so no URL or token ever goes into an error. */
export function telegramClient(token: string, fetchFn: typeof fetch = fetch, chatId = ''): Telegram {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method: string, init?: RequestInit, query = ''): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${base}/${method}${query}`, init);
    } catch {
      throw new Error(`telegram ${method}: request failed`);
    }
    if (!res.ok) throw new Error(`telegram ${method}: HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new Error(`telegram ${method}: bad response`);
    }
  }
  return {
    async send(text) {
      await call(
        'sendMessage',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) },
      );
    },
    async updates(offset, timeoutS = 30) {
      const q = new URLSearchParams({ timeout: String(timeoutS) });
      if (offset !== undefined) q.set('offset', String(offset));
      const body = (await call('getUpdates', undefined, `?${q}`)) as { ok?: boolean; result?: unknown };
      if (!body || body.ok !== true || !Array.isArray(body.result)) throw new Error('telegram getUpdates: not ok');
      const out: TgUpdate[] = [];
      for (const u of body.result as Array<Record<string, any>>) {
        if (typeof u?.update_id !== 'number') continue;
        const m = u.message;
        if (m && typeof m.text === 'string' && m.chat?.id !== undefined && typeof m.date === 'number') {
          out.push({ updateId: u.update_id, chatId: String(m.chat.id), text: m.text, date: m.date });
        } else {
          out.push({ updateId: u.update_id, chatId: '', text: '', date: 0 });
        }
      }
      return out;
    },
  };
}

const USAGE = 'usage: /delete <post id or https://x.com/<handle>/status/<id>>';
const ID = /^\d+$/;
const URL_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/\s]+\/status\/(\d+)(?:[/?#]\S*)?$/i;

export interface CommandDeps {
  state: StateStore;
  x: Pick<XClient, 'delete'>;
  chatId: string;
  now: number;
  status: () => string;
}

/** Returns the reply, or null to ignore (another chat, or not a command). */
export async function handleCommand(cmd: { text: string; chatId: string; date: number }, deps: CommandDeps): Promise<string | null> {
  if (cmd.chatId !== deps.chatId) return null;
  const [head = '', arg = ''] = cmd.text.trim().split(/\s+/, 2);
  if (!head.startsWith('/')) return null;
  const name = head.split('@')[0]!.toLowerCase();

  // /pause always works, however old.
  if (name === '/pause') {
    deps.state.update((s) => void (s.paused = true));
    return 'Paused. Nothing will post or reply until /resume.';
  }
  if (deps.now - cmd.date * 1000 > COMMAND_MAX_AGE_MS) return 'stale command, resend';

  switch (name) {
    case '/resume':
      deps.state.update((s) => void (s.paused = false));
      return 'Resumed.';
    case '/status':
      return deps.status();
    case '/delete': {
      const id = ID.test(arg) ? arg : URL_RE.exec(arg)?.[1];
      if (!id) return USAGE;
      try {
        await deps.x.delete(id);
        return `Deleted ${id}.`;
      } catch (e) {
        return e instanceof XError ? `Delete failed: X status ${e.status}` : 'Delete failed.';
      }
    }
    default:
      return 'commands: /pause /resume /status /delete';
  }
}

export interface BotDeps {
  tg: Telegram;
  state: StateStore;
  x: Pick<XClient, 'delete'>;
  chatId: string;
  now: () => number;
  status: () => string;
  signal: AbortSignal;
  /** Wait after a failed poll. Default 5000. */
  retryMs?: number;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

/** Long-polls until aborted. The heartbeat is written after every successful poll, even an empty one. */
export async function runBot(deps: BotDeps): Promise<void> {
  const { tg, state, signal } = deps;
  const aborted = new Promise<'abort'>((resolve) => {
    if (signal.aborted) resolve('abort');
    else signal.addEventListener('abort', () => resolve('abort'), { once: true });
  });
  let offset: number | undefined;
  while (!signal.aborted) {
    let batch: TgUpdate[];
    try {
      const poll = tg.updates(offset, 30);
      poll.catch(() => {});
      const r = await Promise.race([poll, aborted]);
      if (r === 'abort') return;
      batch = r;
    } catch {
      await wait(deps.retryMs ?? 5000, signal);
      continue;
    }
    try {
      state.update((s) => void (s.heartbeatAt = deps.now()));
    } catch {
      // A failed write must not stop the bot; the next poll retries it.
    }
    for (const u of batch) {
      // Move past this update first, so a bad one is never re-processed.
      offset = Math.max(offset ?? 0, u.updateId + 1);
      try {
        const reply = await handleCommand(u, { state, x: deps.x, chatId: deps.chatId, now: deps.now(), status: deps.status });
        if (reply !== null) await tg.send(reply);
      } catch {
        // One bad update never stops the loop.
      }
    }
  }
}
