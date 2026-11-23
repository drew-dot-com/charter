import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sweepOnce } from './sweep.js';

const TO = '0x00000000000000000000000000000000000000aa' as const;
const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

function deps(balance: bigint, transfer?: (to: `0x${string}`, amount: bigint) => Promise<`0x${string}`>) {
  const sent: Array<[string, bigint]> = [];
  const logs: string[] = [];
  const alerts: string[] = [];
  return {
    sent, logs, alerts,
    d: {
      balance: async () => balance,
      transfer: transfer ?? (async (to: `0x${string}`, amount: bigint) => { sent.push([to, amount]); return HASH; }),
      keep: 15_000_000n,
      to: TO,
      log: (s: string) => logs.push(s),
      alert: async (s: string) => { alerts.push(s); },
    },
  };
}

test('sends balance minus keep', async () => {
  const t = deps(40_000_000n);
  assert.equal(await sweepOnce(t.d), HASH);
  assert.deepEqual(t.sent, [[TO, 25_000_000n]]);
  assert.ok(t.logs.some((l) => l.includes(HASH) && l.includes('25000000')));
});

test('sends nothing at or under keep', async () => {
  for (const bal of [15_000_000n, 3n]) {
    const t = deps(bal);
    assert.equal(await sweepOnce(t.d), null);
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.alerts, []);
  }
});

test('a failed transfer alerts and returns null', async () => {
  const t = deps(40_000_000n, async () => { throw new Error('out of gas'); });
  assert.equal(await sweepOnce(t.d), null);
  assert.equal(t.alerts.length, 1);
  assert.match(t.alerts[0]!, /out of gas/);
});

test('a failed balance read alerts and returns null', async () => {
  const t = deps(0n);
  t.d.balance = async () => { throw new Error('rpc down'); };
  assert.equal(await sweepOnce(t.d), null);
  assert.equal(t.alerts.length, 1);
});

test('an alert never carries a URL from the error', async () => {
  const t = deps(40_000_000n, async () => {
    const e = new Error('HTTP request failed.\n\nURL: https://example.invalid/v2/SECRETKEY\nDetails: boom');
    (e as { shortMessage?: string }).shortMessage = 'HTTP request failed. URL: https://example.invalid/v2/SECRETKEY';
    throw e;
  });
  await sweepOnce(t.d);
  assert.equal(t.alerts.length, 1);
  assert.ok(!t.alerts[0]!.includes('SECRETKEY'));
  const t2 = deps(40_000_000n, async () => { throw new Error('bad\nURL: https://example.invalid/v2/SECRETKEY'); });
  await sweepOnce(t2.d);
  assert.ok(!t2.alerts[0]!.includes('SECRETKEY'));
});
