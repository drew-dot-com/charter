import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AnonDeps {
  /** Directory Charter's anonrc `%include`s; one `<homeId>.conf` per home. */
  hsDir: string;
  /** Per-home state; each home's hidden-service keys live in `<homeId>/hs`. */
  homesDir: string;
  pidFile: string;
  /** Injectable so tests never signal a real process. */
  kill?: (pid: number, signal: 'SIGHUP') => void;
  /** The process name in /proc/<pid>/comm, undefined when there is no such process. Injectable for tests. */
  readComm?: (pid: number) => Promise<string | undefined>;
}

async function procComm(pid: number): Promise<string | undefined> {
  try {
    return await readFile(`/proc/${pid}/comm`, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

export class AnonError extends Error {
  constructor(
    public readonly code: 'no_pid' | 'bad_hostname',
    message: string,
  ) {
    super(message);
    this.name = 'AnonError';
  }
}

/** The three torrc lines that expose a home's sshd (127.0.0.1:port) on :22 of its onion. */
export function hiddenServiceConf(homesDir: string, homeId: string, port: number): string {
  return [
    `HiddenServiceDir ${homesDir}/${homeId}/hs`,
    'HiddenServiceVersion 3',
    `HiddenServicePort 22 127.0.0.1:${port}`,
  ].join('\n');
}

/** Ask anon to re-read its config (SIGHUP by pid file). */
export async function reloadAnon(d: AnonDeps): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(d.pidFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AnonError('no_pid', `no pid file at ${d.pidFile}`);
    throw e;
  }
  const text = raw.trim();
  if (!/^\d+$/.test(text)) throw new AnonError('no_pid', `pid file ${d.pidFile} holds no pid`);
  const pid = Number(text);
  // A stale pid file may name a process that is no longer anon: never signal anything else.
  const comm = (await (d.readComm ?? procComm)(pid))?.trim();
  if (comm !== 'anon') throw new AnonError('no_pid', `pid ${pid} from ${d.pidFile} is ${comm === undefined ? 'not running' : `${comm}, not anon`}`);
  (d.kill ?? process.kill)(pid, 'SIGHUP');
}

/** Idempotent: rewriting the same conf and HUPing again is harmless. */
export async function publishHiddenService(d: AnonDeps, homeId: string, port: number): Promise<void> {
  const dir = join(d.homesDir, homeId, 'hs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and skipped on an existing dir; anon refuses a looser one.
  await chmod(dir, 0o700);
  await mkdir(d.hsDir, { recursive: true });
  // Written aside and renamed in, so anon never reads half a conf. Dot-prefixed: anon's `%include`
  // skips dotfiles, so a temp file left by a crash is never read as a service.
  const tmp = join(d.hsDir, `.${homeId}.conf.tmp-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, hiddenServiceConf(d.homesDir, homeId, port) + '\n');
  await rename(tmp, join(d.hsDir, `${homeId}.conf`));
  await reloadAnon(d);
}

/** Drops the service from anon but keeps the keys, so the onion address survives a re-publish. */
export async function retireHiddenService(d: AnonDeps, homeId: string): Promise<void> {
  await rm(join(d.hsDir, `${homeId}.conf`), { force: true });
  await reloadAnon(d);
}

/** The home's onion address once anon has published it; undefined before then. */
export async function onionHostname(d: AnonDeps, homeId: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(d.homesDir, homeId, 'hs', 'hostname'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  const name = raw.trim();
  if (!/^[a-z2-7]{56}\.anyone$/.test(name)) throw new AnonError('bad_hostname', `unexpected hostname: ${name}`);
  return name;
}
