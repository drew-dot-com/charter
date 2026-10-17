import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToonClientPayer, PacketRefusedError, KeyFileError, SendTimeoutError, DeadlinePassedError, serialized, type Payer } from './payer.js';

const SEAL = '0x04' + '69'.repeat(64);
const SEAL_URL = 'http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp';
const DEST = 'g.toon.69b2a212547e7a9c.charter-echo';

type Sent = { dest: string; req: unknown; opts: unknown };

function setup(result: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'charter-payer-'));
  const keyFile = join(dir, 'sol.json');
  // A throwaway 64-byte array, not a real key.
  writeFileSync(keyFile, JSON.stringify(Array.from({ length: 64 }, (_, i) => i)));
  const sent: Sent[] = [];
  const configs: Record<string, unknown>[] = [];
  const createClient = async (config: Record<string, unknown>) => {
    configs.push(config);
    return {
      async send(dest: string, req: unknown, opts: unknown) {
        sent.push({ dest, req, opts });
        return result;
      },
    };
  };
  return { dir, keyFile, sent, configs, createClient };
}

const enc = (s: string) => new TextEncoder().encode(s);
const fulfilled = (status: number, text: string, amount?: bigint) => ({
  fulfilled: true,
  transport: 'http',
  status,
  headers: [],
  body: enc(text),
  text: () => text,
  json: () => JSON.parse(text),
  fulfillment: new Uint8Array(32),
  claim: amount === undefined ? undefined : { channelId: 'c', chain: 'solana', cumulative: amount, amount },
});

test('F-C2: the raw sealKey (never the URL) and the amount reach client.send as sealTo and amount', async () => {
  const s = setup(fulfilled(200, '{"ok":true}', 5000n));
  try {
    const payer = await ToonClientPayer.create(
      { connectorUrl: 'https://connector.mainnet.toonprotocol.dev', keyFile: s.keyFile, channelStore: join(s.dir, 'store.json'), chain: 'solana' },
      { createClient: s.createClient },
    );
    const ans = await payer.send(DEST, { method: 'POST', path: '/open', body: { n: 1 } }, { sealKey: SEAL, sealUrl: SEAL_URL, amount: 5000n });
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.dest, DEST);
    assert.deepEqual(s.sent[0]!.opts, { amount: 5000n, sealTo: SEAL, timeoutMs: 40_000 }, 'the client ends its own send before the wrapper gives up at 45 s');
    // The leading slash is stripped: the connector refuses an absolute target with F00.
    assert.deepEqual(s.sent[0]!.req, { method: 'POST', target: 'open', body: { n: 1 } });
    assert.equal(ans.status, 200);
    assert.deepEqual(ans.body, { ok: true });
    assert.equal(ans.paid, 5000n);
    assert.equal(typeof ans.paid, 'bigint');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('the client is built from the Solana key file and the x402 channel store', async () => {
  const s = setup(fulfilled(200, 'x'));
  try {
    const store = join(s.dir, 'store.json');
    await ToonClientPayer.create(
      { connectorUrl: 'https://c.example', keyFile: s.keyFile, channelStore: store, chain: 'solana' },
      { createClient: s.createClient },
    );
    const c = s.configs[0]!;
    assert.equal(c['connector'], 'https://c.example');
    assert.equal(c['chain'], 'solana');
    assert.equal(c['channelStore'], store);
    assert.equal(c['transport'], 'http');
    assert.equal(c['autoOpenChannel'], true);
    assert.equal(c['facilitatorUrl'], '');
    assert.equal((c['solanaSecretKey'] as Uint8Array).length, 64);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a free route (no claim) is paid 0n, and a plain-text body stays a string', async () => {
  const s = setup(fulfilled(503, 'busy'));
  try {
    const payer = await ToonClientPayer.create(
      { connectorUrl: 'https://c.example', keyFile: s.keyFile, channelStore: join(s.dir, 's.json'), chain: 'solana' },
      { createClient: s.createClient },
    );
    const ans = await payer.send(DEST, { method: 'GET', path: '/' }, { sealKey: SEAL, sealUrl: SEAL_URL, amount: 0n });
    assert.deepEqual(s.sent[0]!.req, { method: 'GET', target: '' });
    assert.equal(ans.status, 503);
    assert.equal(ans.body, 'busy');
    assert.equal(ans.paid, 0n);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a refused packet throws PacketRefusedError with the reject code', async () => {
  const s = setup({ fulfilled: false, transport: 'http', refusedBy: 'destination', code: 'T01', message: 'connection refused' });
  try {
    const payer = await ToonClientPayer.create(
      { connectorUrl: 'https://c.example', keyFile: s.keyFile, channelStore: join(s.dir, 's.json'), chain: 'solana' },
      { createClient: s.createClient },
    );
    await assert.rejects(
      payer.send(DEST, { method: 'POST', path: '/x' }, { sealKey: SEAL, sealUrl: SEAL_URL, amount: 1n }),
      (e: unknown) => e instanceof PacketRefusedError && e.code === 'T01' && e.refusedBy === 'destination',
    );
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('a key file of the wrong shape fails with a fixed message that echoes none of its contents', async () => {
  const secret = 'zq9KEYMATERIALzq9-abcdef0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'charter-payer-'));
  try {
    for (const [chain, body] of [
      ['solana', secret],
      ['solana', `[1,2,${secret}]`],
      ['solana', JSON.stringify(['a', 'b'])],
      ['evm', secret],
      ['evm', '0x1234'],
    ] as const) {
      const keyFile = join(dir, `k-${chain}.txt`);
      writeFileSync(keyFile, body);
      await assert.rejects(
        ToonClientPayer.create(
          { connectorUrl: 'https://c.example', keyFile, channelStore: join(dir, 's.json'), chain },
          { createClient: async () => ({ send: async () => { throw new Error('unreachable'); } }) as never },
        ),
        (e: Error) => {
          assert.ok(e instanceof KeyFileError);
          assert.equal(e.message, `key file is not a valid ${chain} key`);
          for (let i = 0; i + 6 <= body.length; i++) assert.ok(!e.message.includes(body.slice(i, i + 6)), body.slice(i, i + 6));
          return true;
        },
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serialized: concurrent sends never overlap and run in the order they were made', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: number[] = [];
  const inner: Payer = {
    async send(_dest, req) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push((req.body as { n: number }).n);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if ((req.body as { n: number }).n === 1) throw new Error('boom');
      return { status: 200, body: null, paid: 1n };
    },
  };
  const p = serialized(inner);
  const one = (n: number) => p.send('d', { method: 'POST', path: '/x', body: { n } }, { sealKey: 's', sealUrl: 'u', amount: 1n });
  const results = await Promise.allSettled([one(0), one(1), one(2), one(3)]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'], 'a failed send does not block the queue');
});

test('serialized: a tick waiting behind several reads is sent before them, still one at a time', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((r) => (releaseFirst = r));
  const inner: Payer = {
    async send(_dest, req) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const name = (req.body as { n: string }).n;
      order.push(name);
      if (name === 'first') await firstHeld;
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { status: 200, body: null, paid: 1n };
    },
  };
  const p = serialized(inner);
  const send = (n: string, priority?: 'high') =>
    p.send('d', { method: 'POST', path: '/x', body: { n } }, { sealKey: 's', sealUrl: 'u', amount: 1n, ...(priority ? { priority } : {}) });
  const all = [send('first'), send('read1'), send('read2'), send('read3'), send('tick1', 'high'), send('tick2', 'high')];
  await new Promise((r) => setImmediate(r));
  releaseFirst();
  await Promise.all(all);
  assert.deepEqual(order, ['first', 'tick1', 'tick2', 'read1', 'read2', 'read3']);
  assert.equal(maxInFlight, 1);
});

test('serialized: a send that never answers is rejected after the timeout and the queue moves on', async () => {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const order: string[] = [];
  const inner: Payer = {
    send(_dest, req) {
      const n = (req.body as { n: string }).n;
      order.push(n);
      if (n === 'hung') return new Promise(() => undefined);
      return Promise.resolve({ status: 200, body: n, paid: 1n });
    },
  };
  const p = serialized(inner, {
    timeoutMs: 45_000,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (h) => void ((h as { live: boolean }).live = false),
  });
  const one = (n: string) => p.send('d', { method: 'POST', path: '/x', body: { n } }, { sealKey: 's', sealUrl: 'u', amount: 1n });
  const hung = one('hung');
  const next = one('next');
  const hungResult = assert.rejects(hung, (e: Error) => e instanceof SendTimeoutError);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['hung'], 'the next send waits for the hung one');
  assert.equal(timers[0]!.ms, 45_000);
  timers[0]!.fn();
  await hungResult;
  assert.equal((await next).body, 'next');
  assert.deepEqual(order, ['hung', 'next']);
  assert.equal(timers[1]!.live, false, 'a finished send clears its timer');
});

test('R4: a send with a deadline gives the client min(40 s, deadline - now) and refuses under 5 s without calling it', async () => {
  const s = setup(fulfilled(200, '{}', 5000n));
  try {
    const clock = { t: 1_000_000 };
    const payer = await ToonClientPayer.create(
      { connectorUrl: 'https://c.example', keyFile: s.keyFile, channelStore: join(s.dir, 's.json'), chain: 'solana' },
      { createClient: s.createClient, now: () => clock.t },
    );
    const send = (deadline: number) => payer.send(DEST, { method: 'POST', path: '/tick' }, { sealKey: SEAL, sealUrl: SEAL_URL, amount: 5000n, deadline });
    await send(clock.t + 30_000);
    await send(clock.t + 100_000);
    await send(clock.t + 5_000);
    assert.deepEqual(s.sent.map((x) => (x.opts as { timeoutMs: number }).timeoutMs), [30_000, 40_000, 5_000]);
    await assert.rejects(send(clock.t + 4_999), (e: Error) => e instanceof DeadlinePassedError);
    await assert.rejects(send(clock.t - 1), (e: Error) => e instanceof DeadlinePassedError);
    assert.equal(s.sent.length, 3, 'a send too close to its deadline never reaches the client');
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test('R4: serialized skips a send whose deadline passed while it waited, without calling the payer, and the queue moves on', async () => {
  const clock = { t: 1_000_000 };
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((r) => (releaseFirst = r));
  const inner: Payer = {
    async send(_dest, req) {
      const n = (req.body as { n: string }).n;
      order.push(n);
      if (n === 'first') await firstHeld;
      return { status: 200, body: n, paid: 1n };
    },
  };
  const p = serialized(inner, { now: () => clock.t, setTimer: () => ({}), clearTimer: () => undefined });
  const send = (n: string, deadline?: number) =>
    p.send('d', { method: 'POST', path: '/x', body: { n } }, { sealKey: 's', sealUrl: 'u', amount: 1n, priority: 'high', ...(deadline === undefined ? {} : { deadline }) });
  const first = send('first');
  const late = send('late', clock.t + 20_000);
  const close = send('close', clock.t + 24_999);
  const fine = send('fine', clock.t + 60_000);
  const after = send('after');
  const lateResult = assert.rejects(late, (e: Error) => e instanceof DeadlinePassedError);
  const closeResult = assert.rejects(close, (e: Error) => e instanceof DeadlinePassedError);
  await new Promise((r) => setImmediate(r));
  clock.t += 20_000;
  releaseFirst();
  await lateResult;
  await closeResult;
  assert.equal((await fine).body, 'fine');
  assert.equal((await after).body, 'after');
  await first;
  assert.deepEqual(order, ['first', 'fine', 'after'], 'past its deadline, or under 5 s before it, a send is skipped');
});

test('F-I4: serialized times a send with a deadline at min(45 s, deadline - now), so a hung send frees the queue by its deadline', async () => {
  const clock = { t: 1_000_000 };
  const timers: number[] = [];
  const inner: Payer = { send: async () => ({ status: 200, body: 'ok', paid: 1n }) };
  const p = serialized(inner, { now: () => clock.t, setTimer: (_fn, ms) => (timers.push(ms), {}), clearTimer: () => undefined });
  const send = (deadline?: number) =>
    p.send('d', { method: 'POST', path: '/x' }, { sealKey: 's', sealUrl: 'u', amount: 1n, ...(deadline === undefined ? {} : { deadline }) });
  await send();
  await send(clock.t + 30_000);
  await send(clock.t + 100_000);
  assert.deepEqual(timers, [45_000, 30_000, 45_000]);
});

test('F-I4: ToonClientPayer reports channel headroom as deposit minus signed (undefined with no channel), and warm opens the channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'charter-payer-'));
  try {
    const keyFile = join(dir, 'sol.json');
    writeFileSync(keyFile, JSON.stringify(Array.from({ length: 64 }, (_, i) => i)));
    let current: { depositTotal: bigint; signed: bigint } | undefined;
    const calls: string[] = [];
    const client = {
      send: async () => { throw new Error('unused'); },
      describe: async () => (calls.push('describe'), {}),
      channel: {
        current: async () => current,
        open: async () => (calls.push('open'), (current = { depositTotal: 2_000_000n, signed: 0n })),
      },
    };
    const payer = await ToonClientPayer.create(
      { connectorUrl: 'https://c.example', keyFile, channelStore: join(dir, 's.json'), chain: 'solana' },
      { createClient: async () => client as never },
    );
    assert.equal(await payer.headroom(), undefined);
    await payer.warm();
    assert.deepEqual(calls, ['describe', 'open']);
    assert.equal(await payer.headroom(), 2_000_000n);
    current = { depositTotal: 2_000_000n, signed: 1_990_000n };
    assert.equal(await payer.headroom(), 10_000n);
    current = { depositTotal: 1_000n, signed: 2_000n };
    assert.equal(await payer.headroom(), 0n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
