import { execFile } from 'node:child_process';

export type Exec = (
  args: string[],
  env: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Run `bin` with the given argv. Never throws on a non-zero exit; the code is
 * returned. A spawn failure (binary missing) comes back as code 127.
 */
export function execFileExec(bin: string): Exec {
  return (args, env) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const code = typeof err.code === 'number' ? err.code : 127;
          resolve({ code, stdout, stderr: stderr || err.message });
        },
      );
    });
}
