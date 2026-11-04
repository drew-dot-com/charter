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
// The disk is built the way the host builds it, which needs mkfs.ext4 here.
// The disk is attached as root, as the host does it, so the test needs sudo without a prompt too.
const mkfs = ready && spawnSync('mkfs.ext4', ['-V'], { stdio: 'ignore' }).status === 0;
const sudo = ready && spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
const skip = !ready ? 'set CHARTER_IMAGE_TESTS=1 on a docker host'
  : !mkfs ? 'mkfs.ext4 not installed'
  : !sudo ? 'sudo -n not available' : false;
const opts = { skip, timeout: 15 * 60_000 };

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
  let loop;
  const tmp = mkdtempSync(join(tmpdir(), 'charter-home-'));
  t.after(() => {
    for (const n of names) sh('docker', ['rm', '-f', n]);
    sh('docker', ['volume', 'rm', '-f', vol]);
    if (loop) sh('sudo', ['-n', 'losetup', '-d', loop]);
    sh('docker', ['rmi', tag]);
    rmSync(tmp, { recursive: true, force: true });
  });

  docker('build', '-t', tag, DIR);
  for (const k of ['a', 'b']) {
    assert.equal(sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(tmp, k)]).code, 0);
  }
  const pub = (k) => readFileSync(join(tmp, `${k}.pub`), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  // A production disk: a fresh ext4 image whose root the tenant uid owns, so docker copies nothing in,
  // attached by the host and handed to docker as a loop device (the local driver has no loop option).
  const disk = join(tmp, 'disk.img');
  assert.equal(sh('truncate', ['-s', '1G', disk]).code, 0);
  const fs = sh('mkfs.ext4', ['-F', '-q', '-m', '0', '-E', 'root_owner=10001:10001', disk]);
  assert.equal(fs.code, 0, fs.err);
  const attach = sh('sudo', ['-n', 'losetup', '--find', '--show', disk]);
  assert.equal(attach.code, 0, attach.err);
  loop = attach.out;
  assert.match(loop, /^\/dev\/loop\d+$/);
  docker('volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', `device=${loop}`, vol);
  // The host's jobs run under gVisor: so does this one, when the daemon has it.
  const runtime = docker('info', '--format', '{{json .Runtimes}}').includes('"runsc"') ? ['--runtime', 'runsc'] : [];

  function start(keys) {
    const n = `charter-home-test-${process.pid}-${names.length}`;
    names.push(n);
    docker('run', '-d', '--name', n, ...runtime,
      '--read-only', '--tmpfs', '/tmp:size=256m', '--tmpfs', '/run',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
      '-p', '127.0.0.1:0:2222', '--mount', `type=volume,src=${vol},dst=/home/tenant`,
      '-e', `SSH_KEYS=${keys}`, '-e', 'HTTPS_PROXY=http://10.0.0.1:9080', '-e', 'CHARTER_LEASE_ID=abc', tag);
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
  // A session sees the box env through ~/.ssh/environment.
  assert.equal(ssh('a', p, 'printf %s "$HTTPS_PROXY:$CHARTER_LEASE_ID"').out, 'http://10.0.0.1:9080:abc');
  const set = ssh('a', p, 'echo hi > ~/kept; printf "#!/bin/sh\\ntouch ~/booted\\nexec sleep 3600\\n" > ~/.charter/boot.sh; chmod +x ~/.charter/boot.sh');
  assert.equal(set.code, 0, set.err);
  const before = fingerprint(p);

  docker('restart', first);
  p = port(first);
  waitSsh('a', p);
  assert.equal(ssh('a', p, 'cat ~/kept').out, 'hi');
  // boot.sh runs in the background and never exits: sshd answered anyway, now give the marker a moment.
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
  const old = ssh('a', p, 'true');
  assert.equal(old.code, 255, 'the old key must be refused');
  assert.match(old.err, /Permission denied/);
  assert.equal(fingerprint(p), before, 'the host key lives on the disk, not in the container');
});
