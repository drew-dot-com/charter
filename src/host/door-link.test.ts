import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorWatch, hostRegistrar } from './door-link.js';

const DOOR_URL = 'https://door.example';
const PAYER = `0x${'ab'.repeat(20)}`;

test('doorWatch reads the payer from GET {door}/v1/door, keeps the last good one on a failure', async () => {
  const asked: string[] = [];
  let answer: () => Response = () => Response.json({ payTo: PAYER, network: 'eip155:8453', payer: PAYER });
  const w = doorWatch({ doorUrl: DOOR_URL, log: () => undefined, fetch: (async (u: string) => (asked.push(String(u)), answer())) as typeof fetch });
  assert.equal(w.door(), undefined);
  await w.refresh();
  assert.equal(w.door(), PAYER);
  assert.deepEqual(asked, [`${DOOR_URL}/v1/door`]);
  answer = () => new Response('down', { status: 502 });
  await w.refresh();
  assert.equal(w.door(), PAYER, 'a failed read keeps the address');
  answer = () => Response.json({ payer: 'not an address' });
  await w.refresh();
  assert.equal(w.door(), PAYER, 'a malformed answer keeps the address');
  w.stop();
});

test('hostRegistrar POSTs {url} to /v1/hosts and retries every minute until a 202', async () => {
  const sent: Array<{ url: string; body: unknown }> = [];
  const statuses = [404, 500, 202];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const r = hostRegistrar({
    doorUrl: DOOR_URL,
    hostUrl: 'https://host.example',
    log: () => undefined,
    fetch: (async (u: string, init: RequestInit) => {
      sent.push({ url: String(u), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: statuses.shift() ?? 202 });
    }) as typeof fetch,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
  });
  assert.equal(await r.register(), false);
  assert.deepEqual(sent, [{ url: `${DOOR_URL}/v1/hosts`, body: { url: 'https://host.example' } }]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 60_000);
  timers[0]!.fn();
  await new Promise((res) => setImmediate(res));
  assert.equal(sent.length, 2);
  timers[1]!.fn();
  await new Promise((res) => setImmediate(res));
  assert.equal(sent.length, 3);
  assert.equal(timers.length, 2, 'no retry after the 202');
  // A change (free home slots) registers again at once, replacing any retry waiting.
  statuses.push(500);
  assert.equal(await r.register(), false);
  assert.equal(await r.register(), true);
  assert.equal(timers[2]!.cancelled, true);
  r.stop();
});
