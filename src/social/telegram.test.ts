import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state.js';
import { XError } from './x.js';
import { handleCommand, runBot, telegramClient, COMMAND_MAX_AGE_MS, HEARTBEAT_MAX_AGE_MS, type Telegram } from './telegram.js';

const NOW = Date.UTC(2026, 10, 24, 12);
const store = (): StateStore => new StateStore(join(mkdtempSync(join(tmpdir(), 'social-tg-')), 'state.json'), () => NOW);
const secs = (agoMs: number): number => Math.floor((NOW - agoMs) / 1000);

function deps(state: StateStore, deleted: string[] = [], fail?: Error) {
  return {
    state,
    chatId: '42',
    now: NOW,
    status: () => 'all quiet',
    x: {
      delete: async (id: string) => {
        if (fail) throw fail;
        deleted.push(id);
      },
    },
  };
}

test('constants', () => {
  assert.equal(COMMAND_MAX_AGE_MS, 600_000);
  assert.equal(HEARTBEAT_MAX_AGE_MS, 900_000);
});

test('a command from another chat is ignored', async () => {
  const state = store();
  const out = await handleCommand({ text: '/pause', chatId: '7', date: secs(0) }, deps(state));
  assert.equal(out, null);
  assert.equal(state.get().paused, false);
});

test('/pause sets paused even when an hour old', async () => {
  const state = store();
  const out = await handleCommand({ text: '/pause', chatId: '42', date: secs(3_600_000) }, deps(state));
  assert.match(out ?? '', /paused/i);
  assert.equal(state.get().paused, true);
});

test('/pause@BotName works', async () => {
  const state = store();
  await handleCommand({ text: '/pause@CharterBot', chatId: '42', date: secs(0) }, deps(state));
  assert.equal(state.get().paused, true);
});

test('/resume older than 10 minutes is refused with "stale command, resend"', async () => {
  const state = store();
  state.update((s) => void (s.paused = true));
  const out = await handleCommand({ text: '/resume', chatId: '42', date: secs(11 * 60_000) }, deps(state));
  assert.equal(out, 'stale command, resend');
  assert.equal(state.get().paused, true);
});

test('/resume when fresh unpauses', async () => {
  const state = store();
  state.update((s) => void (s.paused = true));
  await handleCommand({ text: '/resume', chatId: '42', date: secs(60_000) }, deps(state));
  assert.equal(state.get().paused, false);
});

test('/delete accepts a post id or an x.com status URL', async () => {
  const state = store();
  const deleted: string[] = [];
  const d = deps(state, deleted);
  const at = secs(1000);
  await handleCommand({ text: '/delete 123456', chatId: '42', date: at }, d);
  await handleCommand({ text: '/delete https://x.com/charter/status/789?s=20', chatId: '42', date: at }, d);
  await handleCommand({ text: '/delete https://twitter.com/charter/status/555', chatId: '42', date: at }, d);
  assert.deepEqual(deleted, ['123456', '789', '555']);
});

test('/delete with neither answers usage', async () => {
  const deleted: string[] = [];
  const d = deps(store(), deleted);
  for (const text of ['/delete', '/delete soon', '/delete https://evil.com/a/status/9']) {
    const out = await handleCommand({ text, chatId: '42', date: secs(0) }, d);
    assert.match(out ?? '', /usage/i);
  }
  assert.deepEqual(deleted, []);
});

test('a failed delete answers with the status, not a throw', async () => {
  const out = await handleCommand({ text: '/delete 5', chatId: '42', date: secs(0) }, deps(store(), [], new XError('nope', 403)));
  assert.match(out ?? '', /403/);
});

test('/status returns deps.status()', async () => {
  assert.equal(await handleCommand({ text: '/status', chatId: '42', date: secs(0) }, deps(store())), 'all quiet');
});

function fakeTg(script: Array<() => Promise<{ updateId: number; chatId: string; text: string; date: number }[]>>, ac: AbortController, endThrows = false) {
  const sent: string[] = [];
  const offsets: Array<number | undefined> = [];
  let i = 0;
  const tg: Telegram = {
    send: async (t) => void sent.push(t),
    updates: async (offset) => {
      offsets.push(offset);
      const step = script[i++];
      if (!step) {
        ac.abort();
        if (endThrows) throw new Error('aborted');
        return [];
      }
      return step();
    },
  };
  return { tg, sent, offsets };
}

test('runBot writes heartbeatAt after an empty poll', async () => {
  const state = store();
  const ac = new AbortController();
  const { tg } = fakeTg([async () => []], ac);
  await runBot({ tg, state, x: { delete: async () => {} }, chatId: '42', now: () => NOW, status: () => 's', signal: ac.signal, retryMs: 0 });
  assert.equal(state.get().heartbeatAt, NOW);
});

test('runBot keeps polling after updates() throws, with no heartbeat for the failed poll', async () => {
  const state = store();
  const ac = new AbortController();
  const { tg, offsets } = fakeTg(
    [
      async () => {
        throw new Error('boom');
      },
    ],
    ac,
    true,
  );
  await runBot({ tg, state, x: { delete: async () => {} }, chatId: '42', now: () => NOW, status: () => 's', signal: ac.signal, retryMs: 0 });
  assert.equal(offsets.length, 2);
  assert.equal(state.get().heartbeatAt, undefined);
});

test('runBot advances the offset, replies, and survives a bad update', async () => {
  const state = store();
  const ac = new AbortController();
  let calls = 0;
  const { tg, sent, offsets } = fakeTg(
    [
      async () => [
        { updateId: 10, chatId: '42', text: '/delete 9', date: secs(0) },
        { updateId: 11, chatId: '42', text: '/status', date: secs(0) },
      ],
    ],
    ac,
  );
  await runBot({
    tg,
    state,
    x: {
      delete: async () => {
        calls++;
        throw new Error('not an XError');
      },
    },
    chatId: '42',
    now: () => NOW,
    status: () => 'ok',
    signal: ac.signal,
    retryMs: 0,
  });
  assert.equal(calls, 1);
  assert.deepEqual(offsets, [undefined, 12]);
  assert.ok(sent.includes('ok'));
});

test('runBot stops promptly when aborted mid-poll', async () => {
  const state = store();
  const ac = new AbortController();
  const tg: Telegram = { send: async () => {}, updates: () => new Promise(() => {}) };
  const p = runBot({ tg, state, x: { delete: async () => {} }, chatId: '42', now: () => NOW, status: () => 's', signal: ac.signal, retryMs: 0 });
  setTimeout(() => ac.abort(), 10);
  await p;
});

test('telegramClient never leaks the token in errors', async () => {
  const bad = (async () => {
    throw new Error('connect failed https://api.telegram.org/botSECRET/getUpdates');
  }) as unknown as typeof fetch;
  const tg = telegramClient('SECRET', '42', bad);
  await assert.rejects(tg.updates(), (e: Error) => !e.message.includes('SECRET'));
  await assert.rejects(tg.send('x'), (e: Error) => !e.message.includes('SECRET'));
  const notOk = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(telegramClient('SECRET', '42', notOk).send('x'), (e: Error) => !e.message.includes('SECRET') && /401/.test(e.message));
});

test('telegramClient parses updates and keeps non-text ones as empty text', async () => {
  let url = '';
  const f = (async (u: string) => {
    url = u;
    return new Response(
      JSON.stringify({
        ok: true,
        result: [
          { update_id: 1, message: { text: '/pause', date: 100, chat: { id: 42 } } },
          { update_id: 2, edited_message: {} },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const out = await telegramClient('T', '42', f).updates(5, 30);
  assert.deepEqual(out, [
    { updateId: 1, chatId: '42', text: '/pause', date: 100 },
    { updateId: 2, chatId: '', text: '', date: 0 },
  ]);
  assert.match(url, /offset=5/);
  assert.match(url, /timeout=30/);
});

test('telegramClient.send posts the right chat_id and text; empty token or chatId throws', async () => {
  let body = '';
  const f = (async (_u: string, init?: RequestInit) => {
    body = String(init?.body);
    return new Response('{}');
  }) as unknown as typeof fetch;
  await telegramClient('T', '42', f).send('hi');
  assert.deepEqual(JSON.parse(body), { chat_id: '42', text: 'hi' });
  assert.throws(() => telegramClient('T', '', f));
  assert.throws(() => telegramClient('', '42', f));
});

test('a failing state write answers PAUSE FAILED / RESUME FAILED instead of throwing', async () => {
  const state = store();
  state.update = () => {
    throw new Error('disk full');
  };
  const d = deps(state);
  assert.equal(await handleCommand({ text: '/pause', chatId: '42', date: secs(0) }, d), 'PAUSE FAILED, retry /pause');
  assert.equal(await handleCommand({ text: '/resume', chatId: '42', date: secs(0) }, d), 'RESUME FAILED');
});

test('runBot logs one line per failed poll and per failed handler, without the token', async () => {
  const state = store();
  const ac = new AbortController();
  const lines: string[] = [];
  const { tg } = fakeTg(
    [
      async () => {
        throw new Error('telegram getUpdates: HTTP 502');
      },
      async () => [{ updateId: 1, chatId: '42', text: '/status', date: secs(0) }],
    ],
    ac,
    true,
  );
  await runBot({
    tg,
    state,
    x: { delete: async () => {} },
    chatId: '42',
    now: () => NOW,
    status: () => {
      throw new Error('status broke');
    },
    signal: ac.signal,
    retryMs: 0,
    log: (l) => lines.push(l),
  });
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes('HTTP 502')));
  assert.ok(lines.some((l) => l.includes('status broke')));
  assert.ok(lines.every((l) => !l.includes('SECRET')));
});
