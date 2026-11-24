// One biller loop per data dir. Two loops on one state.json would each book the same pulls to credit and
// refund pooled money, so the loop takes loop.lock (created with `wx`) before its first cycle and holds it
// until it exits. The operator's commands (stop, status, resolve-refund) never take it.
//
// The lock names the process (pid) and the machine or container it runs in (hostname). Inside one container
// a live pid means a loop is running; a pid that is gone, or our own pid (the container restarted and this is
// pid 1 again), is stale. A pid from another container (a `docker compose run` beside the service) cannot be
// checked, so the holder rewrites `at` every 30 s and a lock from elsewhere is stale only when `at` is older
// than 5 minutes.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILE = 'loop.lock';
export const LOCK_BEAT_MS = 30_000;
export const LOCK_STALE_MS = 5 * 60_000;

export interface LockWho {
  pid: number;
  host: string;
  now(): number;
  /** Whether a process with this pid is running here. */
  alive(pid: number): boolean;
}

export interface HeldLock {
  /** True while the lock file is still this process's. */
  mine(): boolean;
  /** Rewrites `at`, so a loop in another container sees this one is alive. False when the lock is no longer ours. */
  beat(): boolean;
  /** Removes the lock file if it is still ours. */
  release(): void;
}

/** Another loop holds the data dir. */
export class LockHeld extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LockHeld';
  }
}

interface Body { pid: number; host: string; nonce: string; at: number }

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function defaultWho(): LockWho {
  return { pid: process.pid, host: hostname(), now: Date.now, alive: processAlive };
}

function read(file: string): Body | undefined {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as Body;
    if (typeof b === 'object' && b !== null && Number.isSafeInteger(b.pid) && typeof b.host === 'string' && typeof b.nonce === 'string' && typeof b.at === 'number') return b;
  } catch {
    // missing, torn or not JSON
  }
  return undefined;
}

/** Why the lock on file is stale (takeable), or undefined when a live loop holds it. */
function staleWhy(file: string, b: Body | undefined, w: LockWho): string | undefined {
  if (!b) {
    // Torn (a crash between create and write) or not ours to read: judged by its age.
    let age = Infinity;
    try {
      age = w.now() - statSync(file).mtimeMs;
    } catch {
      // gone meanwhile
    }
    return age > LOCK_STALE_MS ? 'unreadable and old' : undefined;
  }
  if (b.host === w.host) {
    if (b.pid === w.pid) return 'left by an earlier run with this pid';
    return w.alive(b.pid) ? undefined : `pid ${b.pid} is gone`;
  }
  return w.now() - b.at > LOCK_STALE_MS ? `its holder on ${b.host} has not beaten for over ${LOCK_STALE_MS / 60_000} minutes` : undefined;
}

/**
 * Takes the data dir's loop lock, taking over a stale one. Throws LockHeld when a live loop holds it.
 * `log` hears about a takeover.
 */
export function takeLock(dir: string, w: LockWho = defaultWho(), log: (msg: string) => void = () => {}): HeldLock {
  const file = join(dir, LOCK_FILE);
  const nonce = randomBytes(8).toString('hex');
  const body = (): string => JSON.stringify({ pid: w.pid, host: w.host, nonce, at: w.now() } satisfies Body);
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, body(), { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i === 1) throw e;
    }
    const b = read(file);
    const why = staleWhy(file, b, w);
    if (why === undefined) {
      throw new LockHeld(
        `another biller loop holds ${file} (pid ${b?.pid ?? '?'} on ${b?.host ?? '?'}); two loops would book the same pulls twice, so this one does not run. `
        + `Use the commands (stop, status, resolve-refund), which take no lock. If no loop is running, remove ${file}.`,
      );
    }
    log(`taking over a stale loop lock (${why})`);
    try {
      unlinkSync(file);
    } catch {
      // someone else removed it: the wx create below decides
    }
  }
  const mine = (): boolean => read(file)?.nonce === nonce;
  return {
    mine,
    beat: () => {
      if (!mine()) return false;
      const tmp = `${file}.${nonce}.tmp`;
      writeFileSync(tmp, body(), { mode: 0o600 });
      renameSync(tmp, file);
      return true;
    },
    release: () => {
      if (existsSync(file) && mine()) unlinkSync(file);
    },
  };
}
