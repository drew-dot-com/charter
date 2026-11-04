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
  attachDisk,
  createDisk,
  detachDisk,
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
    ensureVolume(f.exec, 'v', '/dev/loop3'),
    (e: unknown) => e instanceof HomeError && e.code === 'volume_failed' && e.message === 'boom',
  );
});

const INSPECT = ['volume', 'inspect', '-f', '{{index .Options "device"}}', 'charter-home-h1'];

/** docker's volume store for one name: create keeps an existing volume as it is, like the real one. */
function volumes(device?: string, opts: { rmFails?: boolean } = {}) {
  let dev = device;
  return fake((a) => {
    if (a[1] === 'inspect') return dev === undefined ? { code: 1, stderr: 'no such volume' } : { code: 0, stdout: `${dev}\n` };
    if (a[1] === 'rm') {
      if (opts.rmFails) return { code: 1, stderr: 'volume is in use - [abc123]\n' };
      dev = undefined;
      return { code: 0 };
    }
    if (a[1] === 'create') dev ??= a.find((x) => x.startsWith('device='))!.slice('device='.length);
    return { code: 0 };
  });
}

test('ensureVolume creates the volume on the loop device, with no o=loop, only when inspect fails', async () => {
  const miss = volumes();
  await ensureVolume(miss.exec, 'charter-home-h1', '/dev/loop3');
  assert.deepEqual(miss.calls.map((c) => c.args), [
    INSPECT,
    ['volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', 'device=/dev/loop3', 'charter-home-h1'],
    INSPECT,
  ]);
  const hit = volumes('/dev/loop3');
  await ensureVolume(hit.exec, 'charter-home-h1', '/dev/loop3');
  assert.equal(hit.calls.length, 1);
});

test('ensureVolume recreates a volume that points at another loop device', async () => {
  const f = volumes('/dev/loop1');
  await ensureVolume(f.exec, 'charter-home-h1', '/dev/loop4');
  assert.deepEqual(f.calls.map((c) => c.args.slice(0, 2).join(' ')), ['volume inspect', 'volume rm', 'volume create', 'volume inspect']);
  assert.deepEqual(f.calls[1]!.args, ['volume', 'rm', '-f', 'charter-home-h1']);
  assert.ok(f.calls[2]!.args.includes('device=/dev/loop4'));
});

test('ensureVolume refuses to go on when the stale volume cannot be removed', async () => {
  const f = volumes('/dev/loop1', { rmFails: true });
  await assert.rejects(
    ensureVolume(f.exec, 'charter-home-h1', '/dev/loop4'),
    (e: unknown) => e instanceof HomeError && e.code === 'volume_failed' && /in use/.test(e.message),
  );
  assert.ok(!f.calls.some((c) => c.args[1] === 'create'));
});

test('ensureVolume rejects a create that returned the old volume still on the old device', async () => {
  // rm "succeeds" but the volume survives, so create hands back the existing one unchanged.
  const f = fake((a) => (a[1] === 'inspect' ? { code: 0, stdout: '/dev/loop1\n' } : { code: 0 }));
  await assert.rejects(
    ensureVolume(f.exec, 'charter-home-h1', '/dev/loop4'),
    (e: unknown) => e instanceof HomeError && e.code === 'volume_failed' && /\/dev\/loop1, not \/dev\/loop4/.test(e.message),
  );
});

test('attachDisk attaches an unattached image and returns the printed device', async () => {
  const f = fake((a) => ({ code: 0, stdout: a[0] === '-j' ? '' : '/dev/loop7\n' }));
  assert.equal(await attachDisk(f.exec, '/h/disk.img'), '/dev/loop7');
  assert.deepEqual(f.calls.map((c) => c.args), [['-j', '/h/disk.img'], ['--find', '--show', '/h/disk.img']]);
});

test('attachDisk reuses the device an image is already attached to', async () => {
  const f = fake(() => ({ code: 0, stdout: '/dev/loop2: [2049]:131 (/h/disk.img)\n' }));
  assert.equal(await attachDisk(f.exec, '/h/disk.img'), '/dev/loop2');
  assert.equal(f.calls.length, 1);
});

test('attachDisk throws attach_failed on a failed or unparseable losetup', async () => {
  const bad = fake((a) => (a[0] === '-j' ? { code: 0 } : { code: 1, stderr: 'sudo: a password is required\n' }));
  await assert.rejects(
    attachDisk(bad.exec, '/h/disk.img'),
    (e: unknown) => e instanceof HomeError && e.code === 'attach_failed' && /password/.test(e.message),
  );
  const odd = fake((a) => ({ code: 0, stdout: a[0] === '-j' ? '' : 'what\n' }));
  await assert.rejects(attachDisk(odd.exec, '/h/disk.img'), (e: unknown) => e instanceof HomeError && e.code === 'attach_failed');
  const j = fake(() => ({ code: 1, stderr: 'no losetup' }));
  await assert.rejects(attachDisk(j.exec, '/h/disk.img'), (e: unknown) => e instanceof HomeError && e.code === 'attach_failed');
});

test('detachDisk runs losetup -d and ignores errors', async () => {
  const f = fake(() => ({ code: 1, stderr: 'busy' }));
  await detachDisk(f.exec, '/dev/loop2');
  assert.deepEqual(f.calls[0]!.args, ['-d', '/dev/loop2']);
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
