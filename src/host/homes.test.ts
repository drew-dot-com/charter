import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import {
  HomeError,
  HomeStore,
  HOME_RETENTION_MS,
  allocatePort,
  createDisk,
  diskPath,
  ensureVolume,
  freeBytes,
  removeVolume,
  sweepDue,
  volumeName,
} from './homes.js';

type Call = { args: string[]; env: Record<string, string> };

function fake(reply: (args: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: Call[] = [];
  const exec: Exec = async (args, env) => {
    calls.push({ args, env });
    const r = reply(args);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

test('allocatePort gives 22000 first, skips taken ports and fills gaps', () => {
  assert.equal(allocatePort([]), 22000);
  assert.equal(allocatePort([22000]), 22001);
  assert.equal(allocatePort([22000, 22002]), 22001);
  assert.equal(allocatePort(new Set([22000, 22001, 22002])), 22003);
});

test('names and paths follow the pinned shapes', () => {
  assert.equal(volumeName('h1'), 'charter-home-h1');
  assert.equal(diskPath('/var/homes', 'h1'), '/var/homes/h1/disk.img');
});

test('createDisk runs truncate then mkfs with the pinned flags', async () => {
  const t = fake();
  const m = fake();
  const order: string[] = [];
  const truncate: Exec = async (a, e) => (order.push('truncate'), t.exec(a, e));
  const mkfs: Exec = async (a, e) => (order.push('mkfs'), m.exec(a, e));
  await createDisk({ truncate, mkfs }, '/h/disk.img', 2);
  assert.deepEqual(order, ['truncate', 'mkfs']);
  assert.deepEqual(t.calls[0]!.args.slice(-3), ['-s', '2G', '/h/disk.img']);
  assert.deepEqual(m.calls[0]!.args, ['-F', '-q', '-m', '0', '-E', 'root_owner=10001:10001', '/h/disk.img']);
  const bad = fake(() => ({ code: 1, stderr: 'no space' }));
  await assert.rejects(
    createDisk({ truncate: t.exec, mkfs: bad.exec }, '/h/disk.img', 2),
    (e: unknown) => e instanceof HomeError && e.code === 'mkfs_failed' && /no space/.test(e.message),
  );
});

test('createDisk refuses an existing file and labels a truncate failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'charter-disk-'));
  const ok = fake();
  const existing = join(dir, 'disk.img');
  await writeFile(existing, 'paid data');
  await assert.rejects(
    createDisk({ truncate: ok.exec, mkfs: ok.exec }, existing, 2),
    (e: unknown) => e instanceof HomeError && e.code === 'disk_exists',
  );
  assert.equal(ok.calls.length, 0);
  const bad = fake(() => ({ code: 1, stderr: 'eperm' }));
  await assert.rejects(
    createDisk({ truncate: bad.exec, mkfs: ok.exec }, join(dir, 'new.img'), 2),
    (e: unknown) => e instanceof HomeError && e.code === 'mkfs_failed' && e.message === 'truncate: eperm',
  );
});

test('ensureVolume throws volume_failed when create fails', async () => {
  const f = fake(() => ({ code: 1, stderr: ' boom\n' }));
  await assert.rejects(
    ensureVolume(f.exec, 'v', '/h/disk.img'),
    (e: unknown) => e instanceof HomeError && e.code === 'volume_failed' && e.message === 'boom',
  );
});

test('ensureVolume creates the loop volume only when inspect fails', async () => {
  const miss = fake((a) => ({ code: a[1] === 'inspect' ? 1 : 0 }));
  await ensureVolume(miss.exec, 'charter-home-h1', '/h/disk.img');
  assert.equal(miss.calls.length, 2);
  assert.deepEqual(miss.calls[0]!.args, ['volume', 'inspect', 'charter-home-h1']);
  const a = miss.calls[1]!.args.join(' ');
  assert.ok(a.includes('--opt type=ext4 --opt device=/h/disk.img --opt o=loop'), a);
  assert.ok(a.startsWith('volume create --driver local'), a);
  assert.equal(miss.calls[1]!.args.at(-1), 'charter-home-h1');
  const hit = fake();
  await ensureVolume(hit.exec, 'charter-home-h1', '/h/disk.img');
  assert.equal(hit.calls.length, 1);
});

test('removeVolume forces removal and ignores errors', async () => {
  const f = fake(() => ({ code: 1, stderr: 'gone' }));
  await removeVolume(f.exec, 'v');
  assert.deepEqual(f.calls[0]!.args, ['volume', 'rm', '-f', 'v']);
});

test('freeBytes reports a positive number for a real directory', async () => {
  assert.ok((await freeBytes(tmpdir())) > 0);
});

test('HomeStore round-trips through its file like LeaseStore', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'charter-homes-')), 'homes.json');
  const s = new HomeStore(file);
  assert.equal(s.get('h1'), undefined);
  s.put({ homeId: 'h1', port: 22000, createdAt: 5, paidOnce: false });
  const again = new HomeStore(file);
  assert.deepEqual(again.get('h1'), { homeId: 'h1', port: 22000, createdAt: 5, paidOnce: false });
  assert.equal(again.all().length, 1);
  again.delete('h1');
  assert.equal(new HomeStore(file).get('h1'), undefined);
});

test('sweepDue: an unpaid home with no live lease is due at once, a paid one exactly 7 days after its close, a live one never', () => {
  const T = 1_000_000;
  const s = new HomeStore();
  s.put({ homeId: 'unpaid', port: 22000, createdAt: 0, paidOnce: false, lastClosedAt: T });
  s.put({ homeId: 'paid', port: 22001, createdAt: 0, paidOnce: true, lastClosedAt: T });
  s.put({ homeId: 'live', port: 22002, createdAt: 0, paidOnce: true, lastClosedAt: T });
  // A disk made before a failed create, or for a lease that lapsed unpaid: never closed through the loop.
  s.put({ homeId: 'orphan', port: 22003, createdAt: 0, paidOnce: false });
  // Paid and never closed: still in use as far as the record knows.
  s.put({ homeId: 'paidOpen', port: 22004, createdAt: 0, paidOnce: true });
  const ids = (now: number) => sweepDue(s, new Set(['live']), now).map((r) => r.homeId).sort();
  assert.deepEqual(ids(T), ['orphan', 'unpaid']);
  assert.deepEqual(ids(T + HOME_RETENTION_MS - 1), ['orphan', 'unpaid']);
  assert.deepEqual(ids(T + HOME_RETENTION_MS), ['orphan', 'paid', 'unpaid']);
  assert.deepEqual(ids(T + 10 * HOME_RETENTION_MS), ['orphan', 'paid', 'unpaid']);
  assert.deepEqual(sweepDue(s, new Set(['live', 'unpaid', 'paid', 'orphan']), T + 10 * HOME_RETENTION_MS), []);
});
