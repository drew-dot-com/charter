import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
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
  /** Job arg names a tenant may set. Anything else is refused, so a tenant cannot reach the host's env. */
  allowArgs?: string[];
}): Runner {
  const { exec, outRoot, allow, proxy } = opts;
  const allowArgs = opts.allowArgs ?? ['URLS'];
  const docker = (args: string[]) => exec(args, {});

  return {
    async create(leaseId, job) {
      if (!allow.includes(job.image)) throw new RunnerError('image_not_allowed', job.image);
      const cname = name(leaseId);
      const env: string[] = [];
      for (const [k, v] of Object.entries(job.args)) {
        if (!allowArgs.includes(k)) throw new RunnerError('arg_not_allowed', k);
        if (!ENV_NAME.test(k)) throw new RunnerError('bad_input', 'arg name');
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
        '--tmpfs', '/tmp',
        '-v', `${out}:/out`,
      ];
      if (proxy) {
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
