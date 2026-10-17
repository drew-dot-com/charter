import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToonClientPayer, PacketRefusedError, KeyFileError, serialized, type Payer } from './payer.js';

const SEAL = 'http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp';
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

test('sealKey and amount reach client.send as sealTo and amount', async () => {
  const s = setup(fulfilled(200, '{"ok":true}', 5000n));
  try {
    const payer = await ToonClientPayer.create(
      { connectorUrl: 'https://connector.mainnet.toonprotocol.dev', keyFile: s.keyFile, channelStore: join(s.dir, 'store.json'), chain: 'solana' },
      { createClient: s.createClient },
    );
    const ans = await payer.send(DEST, { method: 'POST', path: '/open', body: { n: 1 } }, { sealKey: SEAL, amount: 5000n });
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.dest, DEST);
    assert.deepEqual(s.sent[0]!.opts, { amount: 5000n, sealTo: SEAL });
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
    const ans = await payer.send(DEST, { method: 'GET', path: '/' }, { sealKey: SEAL, amount: 0n });
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
      payer.send(DEST, { method: 'POST', path: '/x' }, { sealKey: SEAL, amount: 1n }),
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
  const one = (n: number) => p.send('d', { method: 'POST', path: '/x', body: { n } }, { sealKey: 's', amount: 1n });
  const results = await Promise.allSettled([one(0), one(1), one(2), one(3)]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'], 'a failed send does not block the queue');
});
