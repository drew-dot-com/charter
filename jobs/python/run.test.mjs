import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'run.py');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : undefined;
const opts = { skip: python ? false : 'python3 not installed' };

function run(script, extra = {}) {
  const out = mkdtempSync(join(tmpdir(), 'charter-py-'));
  const r = spawnSync(python, [RUN], {
    // RLIMIT_NPROC counts every process of the uid: in the container that is the job alone, here it is the whole machine.
    env: { PATH: process.env.PATH, CHARTER_OUT: out, SCRIPT: script, CHARTER_SCRIPT_MAX_PROCS: '100000', ...extra },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const file = join(out, 'result.json');
  return {
    code: r.status,
    result: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined,
    error: existsSync(join(out, 'error.txt')) ? readFileSync(join(out, 'error.txt'), 'utf8') : undefined,
  };
}

test('a script that prints returns its stdout, exit 0 and the time it took', opts, () => {
  const r = run('print(sum(range(10)))');
  assert.equal(r.code, 0);
  assert.equal(r.result.kind, 'python');
  assert.equal(r.result.stdout, '45\n');
  assert.equal(r.result.exitCode, 0);
  assert.equal(r.result.timedOut, false);
  assert.equal(typeof r.result.seconds, 'number');
});

test('a failing script is still a finished job: the wrapper exits 0 and reports the exit code and traceback', opts, () => {
  const r = run('import sys\nprint("partial")\nraise ValueError("boom")');
  assert.equal(r.code, 0);
  assert.equal(r.result.exitCode, 1);
  assert.equal(r.result.stdout, 'partial\n');
  assert.match(r.result.stderr, /ValueError: boom/);
});

test('the script sees none of the wrapper env: not SCRIPT, not anything the host set', opts, () => {
  const r = run('import os, json\nprint(json.dumps(sorted(os.environ)))', { CHARTER_SECRET: 'x' });
  const names = JSON.parse(r.result.stdout);
  assert.ok(!names.includes('SCRIPT'));
  assert.ok(!names.includes('CHARTER_SECRET'));
  assert.ok(!names.includes('CHARTER_OUT'));
});

test('stdout past 256 KiB is cut and flagged, and the script is not blocked by the full pipe', opts, () => {
  const r = run('import sys\nsys.stdout.write("x" * (1024 * 1024))\nprint("done", file=sys.stderr)');
  assert.equal(r.result.exitCode, 0);
  assert.equal(r.result.stdout.length, 256 * 1024);
  assert.equal(r.result.stdoutTruncated, true);
  assert.equal(r.result.stderr, 'done\n');
  assert.equal(r.result.stderrTruncated, false);
});

test('a script past the wall cap is killed with its children and reported as timed out', opts, () => {
  const script = 'import subprocess, sys, time\nsubprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])\nprint("started", flush=True)\ntime.sleep(60)';
  const t = Date.now();
  const r = run(script, { CHARTER_WALL_SECONDS: '1' });
  assert.ok(Date.now() - t < 15_000, 'the grandchild must not hold the wrapper open');
  assert.equal(r.code, 0);
  assert.equal(r.result.timedOut, true);
  assert.equal(r.result.exitCode, null);
  assert.equal(r.result.signal, 'SIGKILL');
  assert.equal(r.result.stdout, 'started\n');
});

test('an empty or oversize script is a bad input: error.txt and exit 2, no result', opts, () => {
  const empty = run('   ');
  assert.equal(empty.code, 2);
  assert.match(empty.error, /empty/);
  assert.equal(empty.result, undefined);
  const big = run('#' + 'x'.repeat(8 * 1024));
  assert.equal(big.code, 2);
  assert.match(big.error, /max 8192/);
});
