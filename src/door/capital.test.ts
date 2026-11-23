import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapitalBook, capitalAtRisk } from './capital.js';
import { capitalAllocator, HOSTS_FILE, HostRegistry } from './hosts.js';

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

test('R10: a host whose deposits are mostly charged still gets a top-up, and the proven cap counts only its unspent balance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capital-'));
  const registry = new HostRegistry(join(dir, HOSTS_FILE));
  const ids = ['https://a.example', 'https://b.example'].map((u) => {
    const r = registry.register(u, 0);
    if (r === 'bad_url') throw new Error(u);
    registry.probeResult(r.hostId, true, 0);
    return r.hostId;
  });
  const [a, b] = ids as [string, string];
  const book = new CapitalBook(join(dir, 'capital.json'));
  // Two 0.50 deposits into a's channel, 0.95 of them already paid to a for ticks.
  book.deposited(a, 500_000n);
  book.deposited(a, 500_000n);
  const charged = new Map([[a, 950_000n]]);
  const atRisk = capitalAtRisk(book, (h) => charged.get(h) ?? 0n);
  assert.equal(atRisk(a), 50_000n);
  assert.equal(atRisk(b), 0n);
  const caps = { probeDeposit: 100_000n, hostDeposit: 500_000n, probeCap: 1_000_000n, hostCap: 1_000_000n };
  const alloc = capitalAllocator({ registry, locked: atRisk, ...caps });
  assert.equal(alloc(a), 500_000n, 'a tops up: only its unspent 0.05 counts');
  assert.equal(alloc(b), 500_000n, 'and b still fits under the 1 USDC cap beside it');
  const raw = capitalAllocator({ registry, locked: (h) => book.locked(h), ...caps });
  assert.equal(raw(b), 'over_cap', 'counting spent deposits would have frozen the tier');
  // Charged past what the book holds (a resync from chain) floors at 0.
  charged.set(a, 2_000_000n);
  assert.equal(atRisk(a), 0n);
});

