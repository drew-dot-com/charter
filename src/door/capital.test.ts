import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapitalBook } from './capital.js';

const A = 'ab'.repeat(32);
const B = 'cd'.repeat(32);

test('locked is deposits signed minus withdrawn, per host, never below 0, and survives a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'capital-')), 'capital.json');
  const book = new CapitalBook(file);
  assert.equal(book.locked(A), 0n);
  book.deposited(A, 100_000n);
  book.deposited(A, 500_000n);
  book.deposited(B, 100_000n);
  book.withdrawn(B, 250_000n);
  assert.equal(book.locked(A), 600_000n);
  assert.equal(book.locked(B), 0n);
  const again = new CapitalBook(file);
  assert.equal(again.locked(A), 600_000n);
  assert.equal(again.locked(B), 0n);
});
