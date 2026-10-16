import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import type { JobSpec } from '../types.js';

export type RunnerErrorCode = 'image_not_allowed' | 'bad_input' | 'boot_failed';

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
  /** Resolves once the container is running, rejects on boot failure. */
  start(leaseId: string, job: JobSpec): Promise<void>;
  /** Resolves with the container's exit code. */
  exited(leaseId: string): Promise<number>;
  stop(leaseId: string): Promise<void>;
  /** Bytes of /out/result.json. */
  output(leaseId: string): Promise<Buffer>;
  alive(leaseId: string): Promise<boolean>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
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
}): Runner {
  const { exec, outRoot, allow, proxy } = opts;
  const docker = (args: string[]) => exec(args, {});

  return {
    async start(leaseId, job) {
      if (!allow.includes(job.image)) throw new RunnerError('image_not_allowed', job.image);
      const cname = name(leaseId);
      const env: string[] = [];
      for (const [k, v] of Object.entries(job.args)) {
        if (!ENV_NAME.test(k)) throw new RunnerError('bad_input', 'arg name');
        env.push('-e', `${k}=${v}`);
      }
      const out = join(outRoot, leaseId);
      await mkdir(out, { recursive: true });
      // The job runs as an unprivileged user in the container and must be able to write here.
      await chmod(out, 0o777);

      const argv = [
        'run', '-d',
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
      return readFile(join(outRoot, leaseId, 'result.json'));
    },

    async alive(leaseId) {
      const r = await docker(['inspect', '-f', '{{.State.Running}}', name(leaseId)]);
      return r.code === 0 && r.stdout.trim() === 'true';
    },
  };
}
