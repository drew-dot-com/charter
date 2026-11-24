import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOCK_FILE, LOCK_STALE_MS, LockHeld, takeLock, type LockWho } from './lock.js';

const dir = () => mkdtempSync(join(tmpdir(), 'allow-lock-'));
const T0 = Date.UTC(2026, 10, 24, 12, 0);
const who = (over: Partial<LockWho> = {}): LockWho => ({ pid: 100, host: 'box', now: () => T0, alive: () => true, ...over });

test('a second loop in the same container refuses while the first one lives', () => {
  const d = dir();
  const first = takeLock(d, who({ pid: 100 }));
  assert.equal(first.mine(), true);
  assert.throws(() => takeLock(d, who({ pid: 200, alive: (p) => p === 100 })), (e: unknown) => e instanceof LockHeld && /another biller loop/.test((e as Error).message) && /pid 100/.test((e as Error).message));
  assert.equal(first.mine(), true, 'the refused one changed nothing');
});

test('a loop in another container refuses while the holder beats, and takes over once it stops beating', () => {
  const d = dir();
  const clock = { t: T0 };
  const first = takeLock(d, who({ host: 'container-a', now: () => clock.t }));
  const second = () => takeLock(d, who({ host: 'container-b', pid: 1, now: () => clock.t, alive: () => true }));
  clock.t += LOCK_STALE_MS - 1000;
  assert.throws(second, LockHeld);
  // Beating keeps it held past the stale age.
  assert.equal(first.beat(), true);
  clock.t += LOCK_STALE_MS - 1000;
  assert.throws(second, LockHeld);
  clock.t += 2000;
  const logs: string[] = [];
  const b = takeLock(d, who({ host: 'container-b', pid: 1, now: () => clock.t }), (m) => logs.push(m));
  assert.equal(b.mine(), true);
  assert.match(logs[0]!, /stale/);
  // The old holder learns it lost the lock and stops.
  assert.equal(first.mine(), false);
  assert.equal(first.beat(), false);
});

test('a stale lock is taken over: a gone pid, or our own pid after a restart', () => {
  const d = dir();
  takeLock(d, who({ pid: 100 }));
  const logs: string[] = [];
  const b = takeLock(d, who({ pid: 200, alive: () => false }), (m) => logs.push(m));
  assert.equal(b.mine(), true);
  assert.match(logs[0]!, /pid 100 is gone/);
  // A restarted container: the new process is pid 200 again and the lock still names pid 200.
  const c = takeLock(d, who({ pid: 200, alive: () => true }));
  assert.equal(c.mine(), true);
  assert.equal(b.mine(), false);
});

test('a torn lock is taken over only once it is old', () => {
  const d = dir();
  const file = join(d, LOCK_FILE);
  writeFileSync(file, '');
  assert.throws(() => takeLock(d, who({ now: () => Date.now() })), LockHeld);
  const old = (Date.now() - LOCK_STALE_MS - 60_000) / 1000;
  utimesSync(file, old, old);
  assert.equal(takeLock(d, who({ now: () => Date.now() })).mine(), true);
});

test('release removes only our own lock', () => {
  const d = dir();
  const file = join(d, LOCK_FILE);
  const a = takeLock(d, who({ pid: 100 }));
  const body = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([body.pid, body.host], [100, 'box']);
  a.release();
  assert.equal(existsSync(file), false);
  const b = takeLock(d, who({ pid: 300 }));
  a.release();
  assert.equal(existsSync(file), true);
  assert.equal(b.mine(), true);
});
