import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { access, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Exec } from '../exec.js';

export interface HomeRecord {
  homeId: string;
  port: number;
  createdAt: number;
  paidOnce: boolean;
  lastClosedAt?: number;
  /**
   * 2: a root home. Its disk holds `home/`, `root/` and `sys/<image>/{usr,etc,var}`, mounted over the
   * box's own, and the box runs as root. Absent: the first layout, the whole disk at /home/tenant.
   */
  layout?: 2;
  /** Layout 2: the images whose system folders are already on the disk. */
  sys?: string[];
}

/** The default home disk size; a host sets its own with CHARTER_HOME_DISK_GIB. */
export const HOME_DISK_GIB = 2;
/** The largest disk a host may offer: a bound on one tenant's share, not a tuning value. */
export const HOME_DISK_GIB_MAX = 64;
export const HOME_RETENTION_MS = 7 * 86_400_000;
export const HOME_FREE_FLOOR_BYTES = 3 * 1024 ** 3;
export const HOME_PORT_BASE = 22000;
/** The last port a home may take: a bounded range, so a public host opens a known set. */
export const HOME_PORT_LAST = 22099;

export class HomeError extends Error {
  constructor(
    readonly code: 'mkfs_failed' | 'no_disk' | 'volume_failed' | 'disk_exists' | 'attach_failed' | 'no_port',
    message: string,
  ) {
    super(message);
    this.name = 'HomeError';
  }
}

/** Home records by id; same temp-and-rename file pattern as LeaseStore. */
export class HomeStore {
  private mem = new Map<string, HomeRecord>();

  constructor(private readonly file?: string) {}

  private load(): Map<string, HomeRecord> {
    if (!this.file) return this.mem;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw e;
    }
    const list = JSON.parse(raw) as HomeRecord[];
    return new Map(list.map((r) => [r.homeId, r]));
  }

  private save(map: Map<string, HomeRecord>): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...map.values()]), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(id: string): HomeRecord | undefined {
    return this.load().get(id);
  }

  all(): HomeRecord[] {
    return [...this.load().values()];
  }

  put(rec: HomeRecord): void {
    const map = this.load();
    map.set(rec.homeId, rec);
    this.save(map);
  }

  delete(id: string): void {
    const map = this.load();
    if (map.delete(id)) this.save(map);
  }
}

export function allocatePort(taken: Iterable<number>): number {
  const used = new Set(taken);
  let p = HOME_PORT_BASE;
  while (used.has(p)) p++;
  if (p > HOME_PORT_LAST) throw new HomeError('no_port', `home port range ${HOME_PORT_BASE}-${HOME_PORT_LAST} is full`);
  return p;
}

export function volumeName(homeId: string): string {
  return `charter-home-${homeId}`;
}

export function diskPath(homesDir: string, homeId: string): string {
  return join(homesDir, homeId, 'disk.img');
}

/** Sparse file plus an ext4 filesystem, no reserved blocks (a tenant disk, not a root fs). */
export async function createDisk(
  tools: { truncate: Exec; mkfs: Exec },
  file: string,
  gib: number,
  /** uid:gid of the disk's top folder: the tenant's for the first layout, root's for a root home. */
  owner = '10001:10001',
): Promise<void> {
  // Never touch an existing image: mkfs would wipe a paid home.
  const exists = await access(file).then(() => true, () => false);
  if (exists) throw new HomeError('disk_exists', file);
  const t = await tools.truncate(['-s', `${gib}G`, file], {});
  if (t.code !== 0) throw new HomeError('mkfs_failed', `truncate: ${t.stderr}`);
  // In the first layout nothing in the box can chown, so the tenant uid must own the disk's root from format time.
  const m = await tools.mkfs(['-F', '-q', '-m', '0', '-E', `root_owner=${owner}`, file], {});
  if (m.code !== 0) throw new HomeError('mkfs_failed', m.stderr);
}

/** The loop device a disk image is attached to, from `losetup -j` output, or undefined. */
export function loopDevice(out: string): string | undefined {
  return /^(\/dev\/loop\d+)(?::|\s*$)/m.exec(out)?.[1];
}

/**
 * The image's loop device, attaching it when it is not attached. docker's local driver hands its
 * options to mount(2), which has no `loop` option, so the host attaches the image itself.
 */
export async function attachDisk(losetup: Exec, file: string): Promise<string> {
  const j = await losetup(['-j', file], {});
  if (j.code !== 0) throw new HomeError('attach_failed', j.stderr.trim());
  const attached = loopDevice(j.stdout);
  if (attached) return attached;
  const a = await losetup(['--find', '--show', file], {});
  if (a.code !== 0) throw new HomeError('attach_failed', a.stderr.trim());
  const dev = loopDevice(a.stdout);
  if (!dev) throw new HomeError('attach_failed', `losetup printed ${JSON.stringify(a.stdout.trim())}`);
  return dev;
}

export async function detachDisk(losetup: Exec, device: string): Promise<void> {
  await losetup(['-d', device], {});
}

export async function ensureVolume(docker: Exec, name: string, device: string): Promise<void> {
  const inspect = () => docker(['volume', 'inspect', '-f', '{{index .Options "device"}}', name], {});
  const r = await inspect();
  if (r.code === 0) {
    if (r.stdout.trim() === device) return;
    // The loop number can change after a reboot: point the volume at the device the disk has now.
    // A volume still in use stays on the old device, which may now back another file: never go on.
    const rm = await docker(['volume', 'rm', '-f', name], {});
    if (rm.code !== 0) throw new HomeError('volume_failed', rm.stderr.trim());
  }
  const c = await docker(
    ['volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', `device=${device}`, name],
    {},
  );
  if (c.code !== 0) throw new HomeError('volume_failed', c.stderr.trim());
  // create returns an existing volume of the same name without comparing options: check what it made.
  const after = await inspect();
  if (after.code !== 0 || after.stdout.trim() !== device) {
    throw new HomeError('volume_failed', `${name} is on ${after.stdout.trim() || 'nothing'}, not ${device}`);
  }
}

export async function removeVolume(docker: Exec, name: string): Promise<void> {
  await docker(['volume', 'rm', '-f', name], {});
}

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * How much the home disks under `homesDir` may still grow: each image is sparse, so its full
 * size minus what it holds today is space a tenant can take without asking. Free space is only
 * free for a new disk once this is set aside, or a few part-empty homes filling up later would
 * leave the host with none. A missing directory, or one with no disks, is 0.
 */
export async function pendingGrowthBytes(homesDir: string): Promise<number> {
  const names = await readdir(homesDir).catch(() => [] as string[]);
  let total = 0;
  for (const name of names) {
    const s = await stat(diskPath(homesDir, name)).catch(() => undefined);
    if (!s?.isFile()) continue;
    // `blocks` counts 512-byte units whatever the filesystem's block size.
    total += Math.max(0, s.size - s.blocks * 512);
  }
  return total;
}

/**
 * Homes to remove: no live lease, and either never paid (a disk left by a failed create or an
 * unpaid lapse) or paid and closed for HOME_RETENTION_MS.
 */
export function sweepDue(store: HomeStore, liveHomeIds: Set<string>, now: number): HomeRecord[] {
  return store.all().filter((r) => {
    if (liveHomeIds.has(r.homeId)) return false;
    if (!r.paidOnce) return true;
    return r.lastClosedAt !== undefined && r.lastClosedAt + HOME_RETENTION_MS <= now;
  });
}
