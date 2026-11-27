import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lease } from '../types.js';
import { fixTickPrices, LeaseStore, leasePrices } from './store.js';

const L: Lease = { id: 'a', offerId: 'o', job: { image: 'i', args: {} }, state: 'running', createdAt: 1, paidIntervals: 2 };

test('a file-backed store persists, leaves no temp file, and is shared by two instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'charter-store-'));
  const file = join(dir, 'leases.json');
  const a = new LeaseStore(file);
  const b = new LeaseStore(file);
  assert.deepEqual(a.all(), []);
  a.put(L);
  assert.deepEqual(b.get('a'), L);
  b.put({ ...L, id: 'b' });
  assert.equal(a.all().length, 2);
  assert.deepEqual(await readdir(dir), ['leases.json']);
});

test('a memory store works with no path', () => {
  const s = new LeaseStore();
  s.put(L);
  assert.deepEqual(s.get('a'), L);
  assert.equal(s.get('z'), undefined);
});

test('fixTickPrices fixes live leases with no price at the current one and touches nothing else', () => {
  const s = new LeaseStore();
  s.put(L);
  s.put({ ...L, id: 'priced', tickPrice: '5000' });
  s.put({ ...L, id: 'closed', state: 'closed', closedReason: 'missed_tick' });
  s.put({ ...L, id: 'booting', state: 'awaiting_first_tick' });
  fixTickPrices(s, 7000n);
  assert.equal(s.get('a')!.tickPrice, '7000');
  assert.equal(s.get('priced')!.tickPrice, '5000');
  assert.equal(s.get('closed')!.tickPrice, undefined);
  assert.equal(s.get('booting')!.tickPrice, '7000');
});

test('leasePrices: a raised host price never reaches a lease fixed lower; an unknown lease pays the current price', () => {
  const s = new LeaseStore();
  s.put(L);
  fixTickPrices(s, 7000n);
  let current = 11000n;
  const price = leasePrices(s, () => current);
  assert.equal(price('a'), 7000n);
  assert.equal(price('nope'), 11000n);
  current = 6000n;
  assert.equal(price('a'), 6000n);
});
