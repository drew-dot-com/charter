import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { access, chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import { FETCH_IMAGE, HOME_IMAGE, homeIdOf, MAX_SCRIPT_BYTES, normalizeSshKeys, PYTHON_IMAGE } from '../jobs.js';
import type { HomeAccess, JobSpec } from '../types.js';
import { onionHostname, publishHiddenService, retireHiddenService, type AnonDeps } from './anon.js';
import {
  allocatePort,
  attachDisk,
  createDisk,
  detachDisk,
  diskPath,
  ensureVolume,
  freeBytes as statFreeBytes,
  HOME_DISK_GIB,
  HOME_FREE_FLOOR_BYTES,
  HomeError,
  removeVolume,
  volumeName,
  type HomeRecord,
  type HomeStore,
} from './homes.js';

export type RunnerErrorCode = 'image_not_allowed' | 'arg_not_allowed' | 'bad_input' | 'bad_output' | 'boot_failed';

export class RunnerError extends Error {
  constructor(
    public readonly code: RunnerErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RunnerError';
  }
}

export interface Runner {
  /** Creates the container without starting it: nothing of the job runs yet. Rejects on boot failure. */
  create(leaseId: string, job: JobSpec): Promise<void>;
  /** Starts a created container. Rejects with `boot_failed` when docker cannot. */
  start(leaseId: string): Promise<void>;
  /** Resolves with the container's exit code. */
  exited(leaseId: string): Promise<number>;
  stop(leaseId: string): Promise<void>;
  /** Bytes of /out/result.json. */
  output(leaseId: string): Promise<Buffer>;
  alive(leaseId: string): Promise<boolean>;
  /** The home's record (a fresh port if new), its disk if the file is missing, and its volume. */
  ensureHome(homeId: string): Promise<HomeRecord>;
  /** Exposes the home's sshd on its onion. */
  publishHome(homeId: string): Promise<void>;
  /** Drops the onion service, keeping its keys. */
  retireHome(homeId: string): Promise<void>;
  /** How to reach the home, once anon has published its hostname. */
  homeAccess(homeId: string): Promise<HomeAccess | null>;
  /** Volume, directory, then record: the home is gone for good. */
  removeHome(homeId: string): Promise<void>;
  /** Tells the box how far it is paid, in epoch ms. */
  writePaidThrough(homeId: string, paidThrough: number): Promise<void>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Largest result.json the host will read back from a job. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What homeIdOf yields; anything else could escape homesDir. */
const HOME_ID = /^[0-9a-f]{16}$/;

/** What a job image may be given and how it is fenced in. */
export interface JobProfile {
  /** Job arg names a tenant may set. Anything else is refused, so a tenant cannot reach the host's env. */
  args: string[];
  /** Largest value of any one arg, in UTF-8 bytes. */
  maxArgBytes: number;
  /**
   * `proxy`: the default bridge, with the host's proxy handed in. `none`: no network at all.
   * `home`: the homes bridge, whose only way out is the Anyone proxies.
   */
  network: 'proxy' | 'none' | 'home';
  /** Default 256. */
  pidsLimit?: number;
  /** Extra `docker create` flags for this image only. */
  flags: string[];
}

export interface HomeRunnerOpts {
  homesDir: string;
  /** The docker network homes join. */
  network: string;
  /** Its gateway, where anon listens for SOCKS, HTTP tunnels and DNS. */
  gateway: string;
  socksPort: number;
  httpPort: number;
  homes: HomeStore;
  anon: AnonDeps;
  /** losetup runs as root (`sudo -n losetup` on the host): docker gets a loop device, not the image. */
  tools: { truncate: Exec; mkfs: Exec; losetup: Exec };
  offerJson: string;
  connectorUrl: string;
  freeBytes?: (dir: string) => Promise<number>;
  now?: () => number;
}

/**
 * The python wrapper kills a script after CHARTER_WALL_SECONDS (its own default is 600 s, built for 30 s
 * intervals). The paid time ends the job now, so the host sets the cap far past any lease: 30 days.
 */
export const PYTHON_WALL_SECONDS = 2_592_000;

export const JOB_PROFILES: Record<string, JobProfile> = {
  [FETCH_IMAGE]: { args: ['URLS'], maxArgBytes: 16 * 1024, network: 'proxy', flags: ['--tmpfs', '/tmp'] },
  [PYTHON_IMAGE]: {
    args: ['SCRIPT'],
    maxArgBytes: MAX_SCRIPT_BYTES,
    // Renter code: no network, so it can reach no one, and nothing it writes can outgrow the caps.
    network: 'none',
    flags: ['--tmpfs', '/tmp:size=64m', '--memory-swap', '1g', '--ulimit', 'fsize=8388608', '-e', `CHARTER_WALL_SECONDS=${PYTHON_WALL_SECONDS}`],
  },
  [HOME_IMAGE]: {
    args: ['SSH_KEYS'],
    maxArgBytes: 9 * 1024,
    network: 'home',
    pidsLimit: 512,
    // A home outlives its process: docker brings the box back after a crash or a host reboot.
    flags: ['--tmpfs', '/tmp:size=256m', '--tmpfs', '/run', '--restart', 'unless-stopped'],
  },
};

function profileFor(image: string, allowArgs?: string[]): JobProfile {
  const p = JOB_PROFILES[image] ?? JOB_PROFILES[FETCH_IMAGE]!;
  return allowArgs ? { ...p, args: allowArgs } : p;
}

function name(leaseId: string): string {
  if (!ID.test(leaseId)) throw new RunnerError('bad_input', 'lease id');
  return `charter-${leaseId}`;
}

function checkHomeId(homeId: string): string {
  if (!HOME_ID.test(homeId)) throw new RunnerError('bad_input', 'home id');
  return homeId;
}

/** The home's network, disk, port, read-only charter dir and box env, after the shared flags. */
function homeArgs(profile: JobProfile, rec: HomeRecord, homeId: string, leaseId: string, h: HomeRunnerOpts): string[] {
  if (profile.network !== 'home') throw new RunnerError('bad_input', 'not a home profile');
  const http = `http://${h.gateway}:${h.httpPort}`;
  const env = [
    `HTTP_PROXY=${http}`,
    `HTTPS_PROXY=${http}`,
    `ALL_PROXY=socks5h://${h.gateway}:${h.socksPort}`,
    'NO_PROXY=127.0.0.1,localhost',
    'NODE_USE_ENV_PROXY=1',
    `CHARTER_LEASE_ID=${leaseId}`,
    `CHARTER_HOME_ID=${homeId}`,
    `CHARTER_OFFER_JSON=${h.offerJson}`,
    `CHARTER_CONNECTOR_URL=${h.connectorUrl}`,
    'CHARTER_PAID_THROUGH_FILE=/charter/paid-through',
  ];
  return [
    '--network', h.network,
    '--dns', h.gateway,
    // Loopback only: the onion service is the one way in.
    '-p', `127.0.0.1:${rec.port}:2222`,
    '--mount', `type=volume,src=${volumeName(homeId)},dst=/home/tenant`,
    '-v', `${join(h.homesDir, homeId, 'charter')}:/charter:ro`,
    ...env.flatMap((e) => ['-e', e]),
  ];
}

/** A loopback proxy on the host is reached from the container as host.docker.internal. */
function containerProxy(proxy: string): string {
  const u = new URL(proxy);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
    u.hostname = 'host.docker.internal';
    return u.toString().replace(/\/$/, '');
  }
  return proxy;
}

export function dockerRunner(opts: {
  exec: Exec;
  outRoot: string;
  allow: string[];
  proxy?: string;
  /** Overrides every image's allowed arg names. For tests. */
  allowArgs?: string[];
  /** An OCI runtime for every job, such as `runsc` (gVisor). Default: docker's own. */
  runtime?: string;
  /** Without it the host serves no homes. */
  home?: HomeRunnerOpts;
}): Runner {
  const { exec, outRoot, allow, proxy, runtime } = opts;
  const docker = (args: string[]) => exec(args, {});
  const needHome = (): HomeRunnerOpts => {
    if (!opts.home) throw new RunnerError('image_not_allowed', HOME_IMAGE);
    return opts.home;
  };
  const record = (h: HomeRunnerOpts, homeId: string): HomeRecord => {
    const rec = h.homes.get(homeId);
    if (!rec) throw new RunnerError('bad_input', 'no home record');
    return rec;
  };

  /** ensureHome's work; only ever run through `chain`. */
  async function makeHome(homeId: string): Promise<HomeRecord> {
    const h = needHome();
    checkHomeId(homeId);
    const existing = h.homes.get(homeId);
    // Stored only once its disk and volume exist, so a refused or failed call leaves nothing behind.
    const rec: HomeRecord = existing ?? {
      homeId,
      port: allocatePort(h.homes.all().map((r) => r.port)),
      createdAt: (h.now ?? Date.now)(),
      paidOnce: false,
    };
    const dir = join(h.homesDir, homeId);
    const disk = diskPath(h.homesDir, homeId);
    let madeDir = false;
    let madeDisk = false;
    let device: string | undefined;
    try {
      const missing = await access(disk).then(() => false, () => true);
      if (missing) {
        await mkdir(h.homesDir, { recursive: true });
        const free = await (h.freeBytes ?? statFreeBytes)(h.homesDir);
        // A sparse disk can grow to its full size: keep the floor even then.
        if (free - HOME_DISK_GIB * 1024 ** 3 < HOME_FREE_FLOOR_BYTES) throw new RunnerError('boot_failed', 'no disk');
        madeDir = (await mkdir(dir, { recursive: true })) !== undefined;
        madeDisk = true;
        await createDisk(h.tools, disk, HOME_DISK_GIB);
      }
      // Every call, not only on create: after a reboot the disk is detached and its loop number may differ.
      device = await attachDisk(h.tools.losetup, disk);
      await ensureVolume(exec, volumeName(homeId), device);
      // docker create needs the bind source to exist.
      await mkdir(join(dir, 'charter'), { recursive: true });
    } catch (e) {
      // An unformatted image would pass the next call's exists check and never get mkfs.
      if (madeDisk) {
        await removeVolume(exec, volumeName(homeId));
        if (device) await detachDisk(h.tools.losetup, device);
        await rm(madeDir ? dir : disk, { recursive: true, force: true });
      }
      if (e instanceof RunnerError) throw e;
      throw new RunnerError('boot_failed', e instanceof Error ? e.message : String(e));
    }
    if (!existing) h.homes.put(rec);
    return rec;
  }

  async function detachAttached(h: HomeRunnerOpts, disk: string): Promise<void> {
    const j = await h.tools.losetup(['-j', disk], {});
    const dev = /^(\/dev\/loop\d+):/m.exec(j.stdout)?.[1];
    if (j.code === 0 && dev) await detachDisk(h.tools.losetup, dev);
  }

  let chain: Promise<void> = Promise.resolve();
  // A rejected call never poisons the chain.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    async create(leaseId, job) {
      if (!allow.includes(job.image)) throw new RunnerError('image_not_allowed', job.image);
      const cname = name(leaseId);
      const profile = profileFor(job.image, opts.allowArgs);
      const h = profile.network === 'home' ? needHome() : undefined;
      const env: string[] = [];
      for (const [k, v] of Object.entries(job.args)) {
        if (!profile.args.includes(k)) throw new RunnerError('arg_not_allowed', k);
        if (!ENV_NAME.test(k)) throw new RunnerError('bad_input', 'arg name');
        if (v.includes('\0')) throw new RunnerError('bad_input', `${k} has a NUL`);
        if (Buffer.byteLength(v, 'utf8') > profile.maxArgBytes) throw new RunnerError('bad_input', `${k} too large`);
        env.push('-e', `${k}=${v}`);
      }
      let home: { rec: HomeRecord; homeId: string } | undefined;
      if (h) {
        const keys = normalizeSshKeys((job.args.SSH_KEYS ?? '').split('\n'));
        if (!keys) throw new RunnerError('bad_input', 'SSH_KEYS');
        const homeId = homeIdOf(keys);
        home = { rec: record(h, homeId), homeId };
      }

      const argv = [
        'create',
        '--name', cname,
        '--cpus', '1',
        '--memory', '1g',
        '--pids-limit', String(profile.pidsLimit ?? 256),
        '--read-only',
        // No Linux capabilities, and no setuid path back to any.
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
      ];
      // A home writes its own disk; only jobs hand a result back through /out.
      if (!home) {
        const out = join(outRoot, leaseId);
        await mkdir(out, { recursive: true });
        // The job runs as an unprivileged user in the container and must be able to write here.
        await chmod(out, 0o777);
        argv.push('-v', `${out}:/out`);
      }
      argv.push(...profile.flags);
      if (runtime) argv.push('--runtime', runtime);
      if (h && home) {
        argv.push(...homeArgs(profile, home.rec, home.homeId, leaseId, h));
      } else if (profile.network === 'none') {
        argv.push('--network', 'none');
      } else if (proxy) {
        argv.push('--add-host', 'host.docker.internal:host-gateway');
        argv.push('-e', `CHARTER_PROXY=${containerProxy(proxy)}`);
      }
      argv.push(...env, job.image);

      const r = await docker(argv);
      if (r.code !== 0) throw new RunnerError('boot_failed', r.stderr.trim());
    },

    async start(leaseId) {
      const r = await docker(['start', name(leaseId)]);
      if (r.code !== 0) throw new RunnerError('boot_failed', `start: ${r.stderr.trim()}`);
    },

    async exited(leaseId) {
      const r = await docker(['wait', name(leaseId)]);
      const code = Number.parseInt(r.stdout.trim(), 10);
      if (r.code !== 0 || Number.isNaN(code)) {
        throw new RunnerError('boot_failed', `wait: ${r.stderr.trim()}`);
      }
      return code;
    },

    async stop(leaseId) {
      await docker(['rm', '-f', name(leaseId)]);
    },

    async output(leaseId) {
      name(leaseId);
      const file = join(outRoot, leaseId, 'result.json');
      // The container controls this directory: refuse symlinks and anything oversize.
      let handle;
      try {
        const l = await lstat(file);
        if (!l.isFile()) throw new RunnerError('bad_output', 'not a regular file');
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = await handle.stat();
        if (!st.isFile()) throw new RunnerError('bad_output', 'not a regular file');
        if (st.size > MAX_OUTPUT_BYTES) throw new RunnerError('bad_output', 'too large');
        return await handle.readFile();
      } catch (e) {
        if (e instanceof RunnerError) throw e;
        if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new RunnerError('bad_output', 'symlink');
        throw e;
      } finally {
        await handle?.close();
      }
    },

    async alive(leaseId) {
      const r = await docker(['inspect', '-f', '{{.State.Running}}', name(leaseId)]);
      return r.code === 0 && r.stdout.trim() === 'true';
    },

    ensureHome(homeId) {
      // One at a time across all ids: concurrent calls would race on the same disk file or take the same port.
      return serial(() => makeHome(homeId));
    },

    async publishHome(homeId) {
      const h = needHome();
      const rec = record(h, checkHomeId(homeId));
      await publishHiddenService(h.anon, homeId, rec.port);
    },

    async retireHome(homeId) {
      await retireHiddenService(needHome().anon, checkHomeId(homeId));
    },

    async homeAccess(homeId) {
      const host = await onionHostname(needHome().anon, checkHomeId(homeId));
      return host ? { ssh: { host, port: 22, user: 'tenant' } } : null;
    },

    // On the ensureHome chain, so an open that arrives mid-removal waits and builds a fresh disk.
    async removeHome(homeId) {
      const h = needHome();
      checkHomeId(homeId);
      return serial(async () => {
        // First, so anon never serves a conf whose directory is gone.
        await retireHiddenService(h.anon, homeId);
        await removeVolume(exec, volumeName(homeId));
        // A deleted image stays attached and holds its blocks until the loop device lets go.
        await detachAttached(h, diskPath(h.homesDir, homeId));
        await rm(join(h.homesDir, homeId), { recursive: true, force: true });
        h.homes.delete(homeId);
      });
    },

    async writePaidThrough(homeId, paidThrough) {
      if (!Number.isFinite(paidThrough)) throw new RunnerError('bad_input', 'paidThrough');
      const dir = join(needHome().homesDir, checkHomeId(homeId), 'charter');
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'paid-through');
      // Unique per call, so two writes in flight never share a temp file.
      const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      // The box polls this file: it must never see a half-written number.
      await writeFile(tmp, `${Math.floor(paidThrough)}\n`);
      await rename(tmp, file);
    },
  };
}
