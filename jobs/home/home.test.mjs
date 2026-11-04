import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
// The build takes minutes and CI has no docker daemon this test may use: opt in on a docker host.
const ready = process.env.CHARTER_IMAGE_TESTS === '1' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const opts = { skip: ready ? false : 'set CHARTER_IMAGE_TESTS=1 on a docker host', timeout: 15 * 60_000 };

function sh(cmd, args, input) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout: 15 * 60_000 });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function docker(...args) {
  const r = sh('docker', args);
  assert.equal(r.code, 0, `docker ${args[0]}: ${r.err}`);
  return r.out;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('a home keeps its files, boot script and host key across a restart, and its keys are the env', opts, (t) => {
  const tag = `charter-home-test:${process.pid}`;
  const vol = `charter-home-test-${process.pid}`;
  const names = [];
  const tmp = mkdtempSync(join(tmpdir(), 'charter-home-'));
  t.after(() => {
    for (const n of names) sh('docker', ['rm', '-f', n]);
    sh('docker', ['volume', 'rm', '-f', vol]);
    sh('docker', ['rmi', tag]);
    rmSync(tmp, { recursive: true, force: true });
  });

  docker('build', '-t', tag, DIR);
  for (const k of ['a', 'b']) {
    assert.equal(sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(tmp, k)]).code, 0);
  }
  const pub = (k) => readFileSync(join(tmp, `${k}.pub`), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  docker('volume', 'create', vol);
  // The host's jobs run under gVisor: so does this one, when the daemon has it.
  const runtime = docker('info', '--format', '{{json .Runtimes}}').includes('"runsc"') ? ['--runtime', 'runsc'] : [];

  function start(keys) {
    const n = `charter-home-test-${process.pid}-${names.length}`;
    names.push(n);
    docker('run', '-d', '--name', n, ...runtime,
      '--read-only', '--tmpfs', '/tmp:size=256m', '--tmpfs', '/run',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
      '-p', '127.0.0.1:0:2222', '--mount', `type=volume,src=${vol},dst=/home/tenant`,
      '-e', `SSH_KEYS=${keys}`, tag);
    return n;
  }
  const port = (n) => docker('port', n, '2222/tcp').split('\n')[0].split(':').pop();
  const ssh = (key, p, cmd) => sh('ssh', ['-i', join(tmp, key), '-p', p,
    '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${join(tmp, 'known_hosts')}`,
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR', 'tenant@127.0.0.1', cmd]);
  // sshd needs a moment after the container starts: retry rather than guess one sleep.
  function waitSsh(key, p) {
    let r;
    for (const end = Date.now() + 30_000; Date.now() < end; pause(500)) {
      r = ssh(key, p, 'true');
      if (r.code === 0) return;
    }
    assert.fail(`sshd never answered on ${p}: ${r.err}`);
  }
  function fingerprint(p) {
    const scan = sh('ssh-keyscan', ['-t', 'ed25519', '-p', p, '127.0.0.1']);
    const fp = sh('ssh-keygen', ['-lf', '-'], scan.out);
    assert.equal(fp.code, 0, `no host key on ${p}: ${scan.err}`);
    return fp.out.split(' ')[1];
  }

  const first = start(pub('a'));
  let p = port(first);
  waitSsh('a', p);
  assert.equal(ssh('a', p, 'id -un').out, 'tenant');
  const set = ssh('a', p, 'echo hi > ~/kept; printf "#!/bin/sh\\ntouch ~/booted\\n" > ~/.charter/boot.sh; chmod +x ~/.charter/boot.sh');
  assert.equal(set.code, 0, set.err);
  const before = fingerprint(p);

  docker('restart', first);
  p = port(first);
  waitSsh('a', p);
  assert.equal(ssh('a', p, 'cat ~/kept').out, 'hi');
  // boot.sh runs in the background: give it a moment to land.
  let booted;
  for (const end = Date.now() + 10_000; Date.now() < end; pause(250)) {
    booted = ssh('a', p, 'ls ~/booted');
    if (booted.code === 0) break;
  }
  assert.equal(booted.code, 0, 'boot.sh did not run on restart');
  assert.equal(fingerprint(p), before, 'the host key must survive a restart');

  // The same disk under new keys: authorized_keys is replaced, not appended.
  docker('rm', '-f', first);
  const second = start(pub('b'));
  p = port(second);
  waitSsh('b', p);
  assert.equal(ssh('b', p, 'cat ~/kept').out, 'hi');
  assert.equal(ssh('a', p, 'true').code, 255, 'the old key must be refused');
  assert.equal(fingerprint(p), before, 'the host key lives on the disk, not in the container');
});
