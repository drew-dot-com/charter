import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoorLedger, TICK_TXS_FILE } from './ledger.js';
import { OFFER } from '../tenant/test-host.js';
import { snapshotOffer } from './ledger.js';

const H = '0x' + 'cd'.repeat(32);
const open = (l: DoorLedger, id: string) => l.open({ leaseId: id, offerId: 'h:o', createdAt: 1, offer: snapshotOffer(OFFER) });

test('tickTx appends one line per call next to the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-'));
  const l = new DoorLedger(join(dir, 'ledger.json'));
  open(l, 'L1');
  l.renterTick('L1');
  l.renterTick('L1');
  l.tickTx('L1', H, 5);
  const lines = readFileSync(join(dir, TICK_TXS_FILE), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { leaseId: 'L1', tick: 2, tx: H, at: 5 });
  l.renterTick('L1');
  l.tickTx('L1', H, 6);
  assert.equal(readFileSync(join(dir, TICK_TXS_FILE), 'utf8').trim().split('\n').length, 2);
});

test('tickTx never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-'));
  mkdirSync(join(dir, TICK_TXS_FILE));
  const l = new DoorLedger(join(dir, 'ledger.json'));
  open(l, 'L1');
  l.renterTick('L1');
  assert.doesNotThrow(() => l.tickTx('L1', H, 5));
  assert.equal(l.get('L1')!.ticksPaidByRenter, 1);
});
