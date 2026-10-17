import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFFER } from '../tenant/test-host.js';
import { DoorLedger, LEDGER_FILE, snapshotOffer } from './ledger.js';
import { unblockCommand } from './unblock.js';

const ADDR = '0x' + 'ab'.repeat(20);

test('charter-door unblock <address> clears a payer block in the data dir ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-'));
  const l = new DoorLedger(join(dir, LEDGER_FILE));
  l.open({ leaseId: 'a'.repeat(32), offerId: 'x:y', createdAt: 1, offer: snapshotOffer(OFFER) });
  l.loss('a'.repeat(32), 5000n, 'settle_failed', 1_000, ADDR);
  assert.equal(l.payerHasLoss(ADDR, 2_000), true);
  const lines: string[] = [];
  assert.equal(unblockCommand([ADDR.toUpperCase().replace('0X', '0x')], { CHARTER_DATA_DIR: dir }, () => 3_000, (m) => lines.push(m)), 0);
  assert.match(lines.join('\n'), /unblocked/);
  assert.equal(l.payerHasLoss(ADDR, 4_000), false, 'a running door sees it');
  assert.equal(new DoorLedger(join(dir, LEDGER_FILE)).payerHasLoss(ADDR, 4_000), false, 'and so does a restart');
});

test('unblock refuses a bad address and a missing data dir', () => {
  const lines: string[] = [];
  assert.equal(unblockCommand(['nope'], { CHARTER_DATA_DIR: '/tmp/x' }, () => 1, (m) => lines.push(m)), 2);
  assert.equal(unblockCommand([ADDR], {}, () => 1, (m) => lines.push(m)), 2);
  assert.equal(unblockCommand([], { CHARTER_DATA_DIR: '/tmp/x' }, () => 1, (m) => lines.push(m)), 2);
});

test('unblock exits 1 with a clear message when there is no ledger yet, and creates nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-'));
  const lines: string[] = [];
  assert.equal(unblockCommand([ADDR], { CHARTER_DATA_DIR: dir }, () => 1, (m) => lines.push(m)), 1);
  assert.match(lines.join('\n'), /no ledger/);
  assert.deepEqual(readdirSync(dir), []);
});
