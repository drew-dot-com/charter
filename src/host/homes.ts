import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { access, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Exec } from '../exec.js';

export interface HomeRecord {
  homeId: string;
  port: number;
  createdAt: number;
  paidOnce: boolean;
  lastClosedAt?: number;
}

export const HOME_DISK_GIB = 2;
export const HOME_RETENTION_MS = 7 * 86_400_000;
export const HOME_FREE_FLOOR_BYTES = 3 * 1024 ** 3;
export const HOME_PORT_BASE = 22000;

export class HomeError extends Error {
  constructor(
    readonly code: 'mkfs_failed' | 'no_disk' | 'volume_failed' | 'disk_exists',
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
): Promise<void> {
  // Never touch an existing image: mkfs would wipe a paid home.
  const exists = await access(file).then(() => true, () => false);
  if (exists) throw new HomeError('disk_exists', file);
  const t = await tools.truncate(['-s', `${gib}G`, file], {});
  if (t.code !== 0) throw new HomeError('mkfs_failed', `truncate: ${t.stderr}`);
  const m = await tools.mkfs(['-F', '-q', '-m', '0', file], {});
  if (m.code !== 0) throw new HomeError('mkfs_failed', m.stderr);
}

export async function ensureVolume(docker: Exec, name: string, file: string): Promise<void> {
  const r = await docker(['volume', 'inspect', name], {});
  if (r.code === 0) return;
  const c = await docker(
    ['volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', `device=${file}`, '--opt', 'o=loop', name],
    {},
  );
  if (c.code !== 0) throw new HomeError('volume_failed', c.stderr.trim());
}

export async function removeVolume(docker: Exec, name: string): Promise<void> {
  await docker(['volume', 'rm', '-f', name], {});
}

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Closed homes past retention (or never paid), with no live lease. */
export function sweepDue(store: HomeStore, liveHomeIds: Set<string>, now: number): HomeRecord[] {
  return store.all().filter((r) => {
    if (liveHomeIds.has(r.homeId) || r.lastClosedAt === undefined) return false;
    return !r.paidOnce || r.lastClosedAt + HOME_RETENTION_MS <= now;
  });
}
