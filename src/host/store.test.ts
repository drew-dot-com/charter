import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lease } from '../types.js';
import { LeaseStore } from './store.js';

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
