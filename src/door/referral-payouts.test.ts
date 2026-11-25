import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFERRALS_FILE, ReferralStore } from './referrals.js';
import {
  PAYOUTS_FILE,
  REFERRAL_OPS_FILE,
  PayoutLog,
  applyReferralOps,
  holdOpenIntents,
  payoutOnce,
  type PayoutDeps,
  type SendResult,
} from './referral-payouts.js';

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const C = '0x' + 'cc'.repeat(20);
const TX = ('0x' + '12'.repeat(32)) as `0x${string}`;
const DAY1 = Date.UTC(2026, 10, 25, 12);
const DAY2 = Date.UTC(2026, 10, 26, 12);

interface Rig {
  dir: string;
  d: PayoutDeps;
  sends: Array<{ to: string; amount: bigint }>;
  alerts: string[];
  infos: string[];
  /** What the fake send answers, per address; 'throw' makes it throw. Default: sent. */
  answer: Map<string, SendResult | 'throw'>;
  setNow: (t: number) => void;
  setBalance: (b: bigint | 'throw') => void;
}

function rig(cfg: Partial<PayoutDeps['cfg']> = {}, dir = mkdtempSync(join(tmpdir(), 'payouts-'))): Rig {
  const sends: Rig['sends'] = [];
  const alerts: string[] = [];
  const infos: string[] = [];
  const answer: Rig['answer'] = new Map();
  let now = DAY1;
  let bal: bigint | 'throw' = 100_000_000n;
  const d: PayoutDeps = {
    store: new ReferralStore(join(dir, REFERRALS_FILE)),
    log: new PayoutLog(join(dir, PAYOUTS_FILE)),
    opsFile: join(dir, REFERRAL_OPS_FILE),
    cfg: { minPayout: 100_000n, dailyCap: 5_000_000n, keep: 5_000_000n, ...cfg },
    balance: async () => {
      if (bal === 'throw') throw new Error('rpc down');
      return bal;
    },
    send: async (to, amount) => {
      sends.push({ to, amount });
      const a = answer.get(to) ?? { status: 'sent', tx: TX };
      if (a === 'throw') throw new Error('boom');
      return a;
    },
    now: () => now,
    info: (s) => void infos.push(s),
    alert: async (s) => void alerts.push(s),
  };
  return { dir, d, sends, alerts, infos, answer, setNow: (t) => (now = t), setBalance: (b) => (bal = b) };
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test('below the minimum is not paid; at the minimum is paid in full, intent then sent', async () => {
  const r = rig();
  r.d.store.accrue(A, 99_999n, 1);
  r.d.store.accrue(B, 100_000n, 2);
  await payoutOnce(r.d);
  assert.deepEqual(r.sends, [{ to: B, amount: 100_000n }]);
  assert.equal(r.d.store.owed(B), 0n);
  assert.equal(r.d.store.owed(A), 99_999n);
  const l = lines(join(r.dir, PAYOUTS_FILE));
  assert.deepEqual(
    l.map((x) => x.state),
    ['intent', 'sent'],
  );
  assert.equal(l[0].to, B);
  assert.equal(l[0].amount, '100000');
  assert.equal(l[1].tx, TX);
  assert.equal(r.infos.length, 1);
  assert.match(r.infos[0], new RegExp(TX));
  const p = r.d.log.sentTo(B, 50);
  assert.equal(p.length, 1);
  assert.equal(p[0].amount, 100_000n);
  assert.equal(p[0].state, 'sent');
});

test('addresses are paid by owedSince ascending', async () => {
  const r = rig();
  r.d.store.accrue(C, 100_000n, 3);
  r.d.store.accrue(A, 100_000n, 9);
  r.d.store.accrue(B, 100_000n, 1);
  await payoutOnce(r.d);
  assert.deepEqual(
    r.sends.map((s) => s.to),
    [B, C, A],
  );
});

test('daily cap: an address that does not fit waits, a later one that fits is paid, next day the first is paid', async () => {
  const r = rig({ dailyCap: 250_000n });
  r.d.store.accrue(A, 100_000n, 1);
  r.d.store.accrue(B, 200_000n, 2);
  r.d.store.accrue(C, 100_000n, 3);
  await payoutOnce(r.d);
  assert.deepEqual(
    r.sends.map((s) => s.to),
    [A, C],
  );
  assert.equal(r.d.store.owed(B), 200_000n);
  assert.equal(r.d.log.intendedOn('2026-11-25'), 200_000n);
  r.setNow(DAY2);
  await payoutOnce(r.d);
  assert.deepEqual(
    r.sends.map((s) => s.to),
    [A, C, B],
  );
  assert.equal(r.d.store.owed(B), 0n);
});

test('a payout that would take the wallet below keep: no intent, alert, the next address still considered', async () => {
  const r = rig({ keep: 5_000_000n });
  r.setBalance(5_300_000n);
  r.d.store.accrue(A, 400_000n, 1);
  r.d.store.accrue(B, 200_000n, 2);
  await payoutOnce(r.d);
  assert.deepEqual(r.sends, [{ to: B, amount: 200_000n }]);
  assert.deepEqual(r.alerts, [`referral payout skipped: wallet short for ${A}`]);
  assert.equal(r.d.log.open().length, 0);
  assert.equal(r.d.log.intendedOn('2026-11-25'), 200_000n);
});

test('the balance is read once and lowered by each payout', async () => {
  const r = rig({ keep: 5_000_000n });
  r.setBalance(5_300_000n);
  r.d.store.accrue(A, 200_000n, 1);
  r.d.store.accrue(B, 200_000n, 2);
  await payoutOnce(r.d);
  assert.deepEqual(r.sends, [{ to: A, amount: 200_000n }]);
  assert.deepEqual(r.alerts, [`referral payout skipped: wallet short for ${B}`]);
});

test('an unreadable balance alerts and ends the run', async () => {
  const r = rig();
  r.setBalance('throw');
  r.d.store.accrue(A, 200_000n, 1);
  await payoutOnce(r.d);
  assert.deepEqual(r.sends, []);
  assert.deepEqual(r.alerts, ['referral payout skipped: balance unreadable']);
});

test('reverted: failed line, held, still owed, the next run does not pay it', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.answer.set(A, { status: 'reverted' });
  await payoutOnce(r.d);
  const l = lines(join(r.dir, PAYOUTS_FILE));
  assert.deepEqual(
    l.map((x) => x.state),
    ['intent', 'failed'],
  );
  assert.equal(l[1].reason, 'reverted');
  assert.equal(r.d.store.get(A)?.held, 'transfer reverted');
  assert.equal(r.d.store.owed(A), 200_000n);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /^referral /);
  await payoutOnce(r.d);
  assert.equal(r.sends.length, 1);
});

test('not_sent: failed line, not held, the next run pays it', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.answer.set(A, { status: 'not_sent', reason: 'nonce too low' });
  await payoutOnce(r.d);
  const l = lines(join(r.dir, PAYOUTS_FILE));
  assert.deepEqual(
    l.map((x) => x.state),
    ['intent', 'failed'],
  );
  assert.equal(l[1].reason, 'nonce too low');
  assert.equal(r.d.store.get(A)?.held, undefined);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /^referral .*nonce too low/);
  r.answer.delete(A);
  await payoutOnce(r.d);
  assert.equal(r.sends.length, 2);
  assert.equal(r.d.store.owed(A), 0n);
});

test('unknown: the intent stays open, the address is held, and a second run never sends to it', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.d.store.accrue(B, 200_000n, 2);
  r.answer.set(A, { status: 'unknown', reason: 'receipt timeout' });
  await payoutOnce(r.d);
  const [open] = r.d.log.open();
  assert.equal(open.to, A);
  assert.equal(r.d.store.get(A)?.held, `unresolved payout ${open.id}`);
  assert.equal(r.d.store.owed(A), 200_000n);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /^referral .*receipt timeout/);
  r.answer.delete(A);
  r.d.store.accrue(B, 200_000n, 3);
  r.d.store.accrue(A, 200_000n, 3);
  await payoutOnce(r.d);
  assert.equal(r.sends.filter((s) => s.to === A).length, 1);
  assert.equal(r.sends.filter((s) => s.to === B).length, 2);
  assert.equal(r.alerts.length, 1, 'the hold is not re-alerted');
});

test('send throwing is treated as unknown; payoutOnce never throws', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.answer.set(A, 'throw');
  await payoutOnce(r.d);
  assert.equal(r.d.log.open().length, 1);
  assert.match(r.d.store.get(A)?.held ?? '', /^unresolved payout /);
  r.d.store.release(A);
  await payoutOnce(r.d); // holdOpenIntents puts the hold back before anything is sent
  assert.equal(r.sends.length, 1);
  assert.match(r.d.store.get(A)?.held ?? '', /^unresolved payout /);

  const t = rig();
  t.d.store.accrue(A, 200_000n, 1);
  t.d.alert = async () => {
    throw new Error('alert down');
  };
  t.d.info = () => {
    throw new Error('info down');
  };
  t.answer.set(A, { status: 'reverted' });
  await assert.doesNotReject(payoutOnce(t.d));
  t.d.log = undefined as unknown as PayoutLog;
  await assert.doesNotReject(payoutOnce(t.d));
});

test('a restarted door holds an address whose intent is open and never sends to it', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.d.store.accrue(B, 200_000n, 2);
  const id = r.d.log.intent(A, 200_000n, DAY1); // the door died before the send answered
  const again = rig({}, r.dir);
  assert.deepEqual(
    again.d.log.open().map((p) => p.id),
    [id],
  );
  await holdOpenIntents(again.d);
  assert.equal(again.d.store.get(A)?.held, `unresolved payout ${id}`);
  assert.equal(again.alerts.length, 1);
  await holdOpenIntents(again.d);
  assert.equal(again.alerts.length, 1, 'alerts once per newly held address');
  await payoutOnce(again.d);
  assert.deepEqual(again.sends, [{ to: B, amount: 200_000n }]);
});

test('holdOpenIntents holds an address the store has never seen', async () => {
  const r = rig();
  const id = r.d.log.intent(A, 200_000n, DAY1);
  await holdOpenIntents(r.d);
  assert.equal(r.d.store.get(A)?.held, `unresolved payout ${id}`);
  assert.equal(r.alerts.length, 1);
});

test('PayoutLog: reads back, skips unparseable lines, intendedOn counts failed intents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'payouts-'));
  const f = join(dir, PAYOUTS_FILE);
  const log = new PayoutLog(f);
  const i1 = log.intent(A.toUpperCase().replace('0X', '0x'), 300n, DAY1);
  const i2 = log.intent(A, 200n, DAY1 + 1);
  const i3 = log.intent(B, 50n, DAY2);
  assert.match(i1, /^[0-9a-f]{32}$/);
  log.failed(i1, 'reverted', DAY1 + 5);
  log.sent(i2, TX, DAY1 + 6);
  appendFileSync(f, 'not json\n{"state":"intent"}\n');
  const back = new PayoutLog(f);
  assert.equal(back.intendedOn('2026-11-25'), 500n);
  assert.equal(back.intendedOn('2026-11-26'), 50n);
  assert.deepEqual(
    back.open().map((p) => p.id),
    [i3],
  );
  assert.equal(back.get(i1)?.state, 'failed');
  assert.equal(back.get(i1)?.reason, 'reverted');
  assert.equal(back.get(i1)?.to, A);
  assert.equal(back.get(i2)?.tx, TX);
  assert.equal(back.get('nope'), undefined);
  const id4 = back.intent(A, 7n, DAY2);
  back.sent(id4, TX, DAY2 + 1);
  assert.deepEqual(
    back.sentTo(A, 50).map((p) => p.id),
    [id4, i2],
  );
  assert.deepEqual(
    back.sentTo(A, 1).map((p) => p.id),
    [id4],
  );
  assert.throws(() => back.sent(i1, TX, 1), /not open/);
});

function op(r: Rig, o: Record<string, unknown>): void {
  appendFileSync(r.d.opsFile, JSON.stringify(o) + '\n');
}

test('ops: resolve sent marks paid and closes the intent; the hold stays until release', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.answer.set(A, { status: 'unknown', reason: 'timeout' });
  await payoutOnce(r.d);
  const [p] = r.d.log.open();
  op(r, { op: 'resolve', id: p.id, as: 'sent', tx: TX });
  assert.equal(applyReferralOps(r.d), 1);
  assert.equal(r.d.log.get(p.id)?.state, 'sent');
  assert.equal(r.d.log.get(p.id)?.tx, TX);
  assert.equal(r.d.store.owed(A), 0n);
  assert.match(r.d.store.get(A)?.held ?? '', /^unresolved payout /);
  op(r, { op: 'release', address: A });
  assert.equal(applyReferralOps(r.d), 1);
  assert.equal(r.d.store.get(A)?.held, undefined);
  assert.equal(applyReferralOps(r.d), 0, 'a line is applied once');
  assert.equal(readFileSync(`${r.d.opsFile}.applied`, 'utf8').trim(), '2');
});

test('ops: resolve failed closes the intent and leaves it owed; a resolve for a closed id is skipped', async () => {
  const r = rig();
  r.d.store.accrue(A, 200_000n, 1);
  r.answer.set(A, { status: 'unknown', reason: 'timeout' });
  await payoutOnce(r.d);
  const [p] = r.d.log.open();
  op(r, { op: 'resolve', id: p.id, as: 'failed' });
  op(r, { op: 'resolve', id: p.id, as: 'sent', tx: TX });
  applyReferralOps(r.d);
  assert.equal(r.d.log.get(p.id)?.state, 'failed');
  assert.equal(r.d.log.get(p.id)?.reason, 'operator');
  assert.equal(r.d.store.owed(A), 200_000n);
  assert.match(r.d.store.get(A)?.held ?? '', /^unresolved payout /);
});

test('ops: bind and unbind change homeReferrer; bad and partial lines are not applied', () => {
  const r = rig();
  op(r, { op: 'bind', homeId: 'h1', address: A.toUpperCase().replace('0X', '0x') });
  assert.equal(applyReferralOps(r.d), 1);
  assert.equal(r.d.store.homeReferrer('h1'), A);
  op(r, { op: 'bind', homeId: 'h1', address: B });
  applyReferralOps(r.d);
  assert.equal(r.d.store.homeReferrer('h1'), B);
  op(r, { op: 'unbind', homeId: 'h1' });
  appendFileSync(r.d.opsFile, 'garbage\n{"op":"bind","homeId":"h2"}\n');
  applyReferralOps(r.d);
  assert.equal(r.d.store.homeReferrer('h1'), undefined);
  assert.equal(r.d.store.homeReferrer('h2'), undefined);
  appendFileSync(r.d.opsFile, '{"op":"bind","homeId":"h3","addr'); // still being written
  applyReferralOps(r.d);
  appendFileSync(r.d.opsFile, `ess":"${A}"}\n`);
  applyReferralOps(r.d);
  assert.equal(r.d.store.homeReferrer('h3'), A);
});

test('ops: payoutOnce applies ops first, a missing ops file is nothing to apply', async () => {
  const r = rig();
  assert.equal(applyReferralOps(r.d), 0);
  r.d.store.accrue(A, 200_000n, 1);
  r.d.store.hold(A, 'transfer reverted');
  op(r, { op: 'release', address: A });
  await payoutOnce(r.d);
  assert.deepEqual(r.sends, [{ to: A, amount: 200_000n }]);
});
