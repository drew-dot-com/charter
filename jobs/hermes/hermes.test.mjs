import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..');
// Gated as the home test is: a docker host that opted in, with mkfs.ext4 and sudo without a prompt.
const ready = process.env.CHARTER_IMAGE_TESTS === '1' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const mkfs = ready && spawnSync('mkfs.ext4', ['-V'], { stdio: 'ignore' }).status === 0;
const sudo = ready && spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
const skip = !ready ? 'set CHARTER_IMAGE_TESTS=1 on a docker host'
  : !mkfs ? 'mkfs.ext4 not installed'
  : !sudo ? 'sudo -n not available' : false;
const opts = { skip, timeout: 45 * 60_000 };

function sh(cmd, args, input) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout: 45 * 60_000, cwd: ROOT });
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

test('a hermes home runs Hermes 0.22.7 and the charter CLI read-only, boots by default, and keeps the tenant boot.sh', opts, (t) => {
  const base = `charter-home-test:${process.pid}`;
  const tag = `charter-hermes-test:${process.pid}`;
  const vol = `charter-hermes-test-${process.pid}`;
  const names = [];
  let loop;
  const tmp = mkdtempSync(join(tmpdir(), 'charter-hermes-'));
  t.after(() => {
    for (const n of names) sh('docker', ['rm', '-f', n]);
    sh('docker', ['volume', 'rm', '-f', vol]);
    if (loop) sh('sudo', ['-n', 'losetup', '-d', loop]);
    sh('docker', ['rmi', tag, base]);
    rmSync(tmp, { recursive: true, force: true });
  });

  docker('build', '-t', base, join(ROOT, 'jobs', 'home'));
  docker('build', '-f', 'jobs/hermes/Dockerfile', '--build-arg', `BASE=${base}`, '-t', tag, '.');
  assert.equal(sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(tmp, 'a')]).code, 0);
  const pub = readFileSync(join(tmp, 'a.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  // The production disk size, 2 GiB, so the free-space check means what it says.
  const disk = join(tmp, 'disk.img');
  assert.equal(sh('truncate', ['-s', '2G', disk]).code, 0);
  const fs = sh('mkfs.ext4', ['-F', '-q', '-m', '0', '-E', 'root_owner=10001:10001', disk]);
  assert.equal(fs.code, 0, fs.err);
  const attach = sh('sudo', ['-n', 'losetup', '--find', '--show', disk]);
  assert.equal(attach.code, 0, attach.err);
  loop = attach.out;
  assert.match(loop, /^\/dev\/loop\d+$/);
  docker('volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', `device=${loop}`, vol);
  const runtime = docker('info', '--format', '{{json .Runtimes}}').includes('"runsc"') ? ['--runtime', 'runsc'] : [];

  const n = `charter-hermes-test-${process.pid}`;
  names.push(n);
  docker('run', '-d', '--name', n, ...runtime,
    '--read-only', '--tmpfs', '/tmp:size=256m', '--tmpfs', '/run',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
    '-p', '127.0.0.1:0:2222', '--mount', `type=volume,src=${vol},dst=/home/tenant`,
    '-e', `SSH_KEYS=${pub}`, '-e', 'HTTPS_PROXY=http://10.0.0.1:9080', '-e', 'CHARTER_LEASE_ID=abc',
    '-e', 'CHARTER_OFFER_JSON={"id":"o1","hostPubkey":""}', tag);
  const port = () => docker('port', n, '2222/tcp').split('\n')[0].split(':').pop();
  const ssh = (p, cmd) => sh('ssh', ['-i', join(tmp, 'a'), '-p', p,
    '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${join(tmp, 'known_hosts')}`,
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR', 'tenant@127.0.0.1', cmd]);
  function waitSsh(p) {
    let r;
    for (const end = Date.now() + 30_000; Date.now() < end; pause(500)) {
      r = ssh(p, 'true');
      if (r.code === 0) return;
    }
    assert.fail(`sshd never answered on ${p}: ${r.err}`);
  }
  const ok = (p, cmd) => {
    const r = ssh(p, cmd);
    assert.equal(r.code, 0, `${cmd}: ${r.err}`);
    return r;
  };

  let p = port();
  waitSsh(p);
  const version = ok(p, 'hermes --version');
  assert.match(version.out, /0\.22\.7/);
  assert.doesNotMatch(version.err, /out of sync/);
  // The CLI answers --help with its usage text and exit 2, as it does any invocation it does not run.
  const usage = ssh(p, 'charter --help');
  assert.equal(usage.code, 2, usage.err);
  assert.match(`${usage.out}\n${usage.err}`, /charter rent --offer/);
  ok(p, 'rg --version');
  assert.match(ok(p, 'readlink -f /opt/hermes/venv/bin/python').out, /^\/opt\/hermes\/python\//);
  ok(p, "/opt/hermes/venv/bin/python -c 'import telegram, discord, mcp, fastapi'");
  assert.equal(ok(p, 'stat -c %a ~/.charter/boot.sh').out, '700');
  let booted;
  for (const end = Date.now() + 60_000; Date.now() < end; pause(1000)) {
    booted = ssh(p, 'grep -q "^boot:" ~/.charter/boot.log');
    if (booted.code === 0) break;
  }
  assert.equal(booted.code, 0, 'no boot: lines in ~/.charter/boot.log within 60 s');
  ok(p, 'test ! -e ~/.hermes/tools');
  const free = Number(ok(p, "df -Pm ~ | awk 'NR==2 {print $4}'").out);
  assert.ok(free > 1800, `only ${free} MiB free on the home disk`);
  assert.equal(ok(p, 'printf %s "$HERMES_DISABLE_LAZY_INSTALLS"').out, '1');

  // The tenant's edits survive a restart: the default is copied only when boot.sh is absent.
  ok(p, 'echo "# tenant marker" >> ~/.charter/boot.sh');
  docker('restart', n);
  p = port();
  waitSsh(p);
  ok(p, 'grep -q "^# tenant marker$" ~/.charter/boot.sh');
});
