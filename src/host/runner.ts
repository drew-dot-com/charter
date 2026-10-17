import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import { FETCH_IMAGE, MAX_SCRIPT_BYTES, PYTHON_IMAGE } from '../jobs.js';
import type { JobSpec } from '../types.js';

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
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Largest result.json the host will read back from a job. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a job image may be given and how it is fenced in. */
export interface JobProfile {
  /** Job arg names a tenant may set. Anything else is refused, so a tenant cannot reach the host's env. */
  args: string[];
  /** Largest value of any one arg, in UTF-8 bytes. */
  maxArgBytes: number;
  /** `proxy`: the default bridge, with the host's proxy handed in. `none`: no network at all. */
  network: 'proxy' | 'none';
  /** Extra `docker create` flags for this image only. */
  flags: string[];
}

export const JOB_PROFILES: Record<string, JobProfile> = {
  [FETCH_IMAGE]: { args: ['URLS'], maxArgBytes: 16 * 1024, network: 'proxy', flags: ['--tmpfs', '/tmp'] },
  [PYTHON_IMAGE]: {
    args: ['SCRIPT'],
    maxArgBytes: MAX_SCRIPT_BYTES,
    // Renter code: no network, so it can reach no one, and nothing it writes can outgrow the caps.
    network: 'none',
    flags: ['--tmpfs', '/tmp:size=64m', '--memory-swap', '1g', '--ulimit', 'fsize=8388608'],
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
}): Runner {
  const { exec, outRoot, allow, proxy, runtime } = opts;
  const docker = (args: string[]) => exec(args, {});

  return {
    async create(leaseId, job) {
      if (!allow.includes(job.image)) throw new RunnerError('image_not_allowed', job.image);
      const cname = name(leaseId);
      const profile = profileFor(job.image, opts.allowArgs);
      const env: string[] = [];
      for (const [k, v] of Object.entries(job.args)) {
        if (!profile.args.includes(k)) throw new RunnerError('arg_not_allowed', k);
        if (!ENV_NAME.test(k)) throw new RunnerError('bad_input', 'arg name');
        if (v.includes('\0')) throw new RunnerError('bad_input', `${k} has a NUL`);
        if (Buffer.byteLength(v, 'utf8') > profile.maxArgBytes) throw new RunnerError('bad_input', `${k} too large`);
        env.push('-e', `${k}=${v}`);
      }
      const out = join(outRoot, leaseId);
      await mkdir(out, { recursive: true });
      // The job runs as an unprivileged user in the container and must be able to write here.
      await chmod(out, 0o777);

      const argv = [
        'create',
        '--name', cname,
        '--cpus', '1',
        '--memory', '1g',
        '--pids-limit', '256',
        '--read-only',
        // No Linux capabilities, and no setuid path back to any.
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '-v', `${out}:/out`,
        ...profile.flags,
      ];
      if (runtime) argv.push('--runtime', runtime);
      if (profile.network === 'none') {
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
  };
}
