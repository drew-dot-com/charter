import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReferralOps, PAYOUTS_FILE, PayoutLog, REFERRAL_OPS_FILE } from './referral-payouts.js';
import { REFERRALS_FILE, ReferralStore } from './referrals.js';
import { referralsCommand } from './referrals-command.js';

const A = '0x' + 'ab'.repeat(20);
const B = '0x' + 'cd'.repeat(20);
const HOME = 'e'.repeat(64);
const TX = '0x' + '12'.repeat(32);

/** A data dir with A owed 300000 (100000 paid), B held, and one open intent to B. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'referrals-cmd-'));
  const store = new ReferralStore(join(dir, REFERRALS_FILE));
  store.accrue(A, 400_000n, 1_000);
  store.markPaid(A, 100_000n, 'p0');
  store.accrue(B, 200_000n, 2_000);
  const log = new PayoutLog(join(dir, PAYOUTS_FILE));
  const id = log.intent(B, 150_000n, 3_000);
  store.hold(B, `unresolved payout ${id}`);
  const lines: string[] = [];
  const run = (...args: string[]) => referralsCommand(args, { CHARTER_DATA_DIR: dir }, () => 9_000, (m) => lines.push(m));
  const ops = () => (existsSync(join(dir, REFERRAL_OPS_FILE)) ? readFileSync(join(dir, REFERRAL_OPS_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const apply = () => {
    const s = new ReferralStore(join(dir, REFERRALS_FILE));
    const l = new PayoutLog(join(dir, PAYOUTS_FILE));
    applyReferralOps({ store: s, log: l, opsFile: join(dir, REFERRAL_OPS_FILE), now: () => 10_000 });
    return { store: new ReferralStore(join(dir, REFERRALS_FILE)), log: new PayoutLog(join(dir, PAYOUTS_FILE)) };
  };
  return { dir, id, lines, run, ops, apply };
}

const files = (dir: string) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('list prints each address with earned, paid, owed and held, then the open intents, and writes nothing', () => {
  const f = fixture();
  const before = files(f.dir);
  assert.equal(f.run(), 0);
  assert.equal(f.run('list'), 0);
  const text = f.lines.join('\n');
  assert.match(text, new RegExp(`${A} earned 400000 paid 100000 owed 300000`));
  assert.match(text, new RegExp(`${B} earned 200000 paid 0 owed 200000 held: unresolved payout ${f.id}`));
  assert.match(text, new RegExp(`open ${f.id} 150000 micro-USDC to ${B}`));
  assert.deepEqual(files(f.dir), before);
});

test('list leaves a payout log whose last line is still being written as it is', () => {
  const f = fixture();
  appendFileSync(join(f.dir, PAYOUTS_FILE), '{"state":"sent","id":"');
  const before = files(f.dir);
  assert.equal(f.run('list'), 0);
  assert.match(f.lines.join('\n'), new RegExp(`open ${f.id}`));
  assert.deepEqual(files(f.dir), before);
});

test('list exits 1 when there is no store and no log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'referrals-cmd-'));
  const lines: string[] = [];
  assert.equal(referralsCommand([], { CHARTER_DATA_DIR: dir }, () => 1, (m) => lines.push(m)), 1);
  assert.match(lines.join('\n'), /no referrals/);
  assert.deepEqual(readdirSync(dir), []);
});

test('resolve sent appends one ops line; applied, it marks the payout paid and closes the intent', () => {
  const f = fixture();
  assert.equal(f.run('resolve', f.id, 'sent', TX), 0);
  assert.deepEqual(f.ops(), [{ op: 'resolve', id: f.id, as: 'sent', tx: TX, at: 9_000 }]);
  assert.match(f.lines.join('\n'), /within a minute/);
  assert.equal(new ReferralStore(join(f.dir, REFERRALS_FILE)).get(B)!.paid, 0n, 'the command never writes the store');
  const { store, log } = f.apply();
  assert.equal(store.get(B)!.paid, 150_000n);
  assert.equal(log.get(f.id)!.state, 'sent');
  assert.equal(log.get(f.id)!.tx, TX);
});

test('resolve failed appends one ops line; applied, it fails the intent and pays nothing', () => {
  const f = fixture();
  assert.equal(f.run('resolve', f.id, 'failed'), 0);
  assert.deepEqual(f.ops(), [{ op: 'resolve', id: f.id, as: 'failed', at: 9_000 }]);
  const { store, log } = f.apply();
  assert.equal(log.get(f.id)!.state, 'failed');
  assert.equal(store.get(B)!.paid, 0n);
});

test('resolve of an id that is not an open intent exits 1 and appends nothing', () => {
  const f = fixture();
  assert.equal(f.run('resolve', 'f'.repeat(32), 'failed'), 1);
  assert.match(f.lines.join('\n'), /not an open payout/);
  f.run('resolve', f.id, 'failed');
  f.apply();
  assert.equal(f.run('resolve', f.id, 'sent', TX), 1, 'an id already closed');
  assert.equal(f.ops().length, 1);
});

test('release appends one ops line; applied, the hold is gone', () => {
  const f = fixture();
  assert.equal(f.run('release', B.toUpperCase().replace('0X', '0x')), 0);
  assert.deepEqual(f.ops(), [{ op: 'release', address: B, at: 9_000 }]);
  assert.equal(f.apply().store.get(B)!.held, undefined);
});

test('release of an address with no record exits 1 and appends nothing', () => {
  const f = fixture();
  assert.equal(f.run('release', '0x' + '99'.repeat(20)), 1);
  assert.deepEqual(f.ops(), []);
});

test('bind and unbind append one ops line each; applied, the home is bound then unbound', () => {
  const f = fixture();
  assert.equal(f.run('bind', HOME.toUpperCase(), A), 0);
  assert.deepEqual(f.ops(), [{ op: 'bind', homeId: HOME, address: A, at: 9_000 }]);
  assert.equal(f.apply().store.homeReferrer(HOME), A);
  assert.equal(f.run('unbind', HOME), 0);
  assert.deepEqual(f.ops()[1], { op: 'unbind', homeId: HOME, at: 9_000 });
  assert.equal(f.apply().store.homeReferrer(HOME), undefined);
});

test('bad arguments exit 2 with a usage line and append nothing', () => {
  const f = fixture();
  const bad: string[][] = [
    ['nope'],
    ['list', 'extra'],
    ['resolve', f.id],
    ['resolve', f.id, 'sent'],
    ['resolve', f.id, 'sent', '0x12'],
    ['resolve', f.id, 'sent', TX + '00'],
    ['resolve', f.id, 'failed', TX],
    ['resolve', f.id, 'maybe'],
    ['release'],
    ['release', 'nope'],
    ['bind', 'h1', A],
    ['bind', HOME, 'nope'],
    ['bind', HOME],
    ['unbind', 'h1'],
    ['unbind'],
  ];
  for (const args of bad) {
    f.lines.length = 0;
    assert.equal(f.run(...args), 2, args.join(' '));
    assert.match(f.lines.join('\n'), /usage: charter-door referrals/, args.join(' '));
  }
  assert.deepEqual(f.ops(), []);
  const lines: string[] = [];
  assert.equal(referralsCommand(['list'], {}, () => 1, (m) => lines.push(m)), 2);
  assert.match(lines.join('\n'), /CHARTER_DATA_DIR is required/);
});
