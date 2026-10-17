import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import { dockerRunner, RunnerError } from './runner.js';

type Call = { args: string[]; env: Record<string, string> };

function fake(reply: (args: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: Call[] = [];
  const exec: Exec = async (args, env) => {
    calls.push({ args, env });
    const r = reply(args);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { exec, calls };
}

async function outRoot() {
  return mkdtemp(join(tmpdir(), 'charter-runner-'));
}

const JOB = { image: 'charter-job-fetch', args: { URLS: 'https://example.com,https://example.org' } };

test('create refuses an image not on the allow list and never calls docker', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await assert.rejects(
    r.create('l1', { image: 'evil:latest', args: {} }),
    (e: unknown) => e instanceof RunnerError && e.code === 'image_not_allowed',
  );
  assert.equal(calls.length, 0);
});

test('F-C3: create emits docker create (nothing runs yet) with the limits, the out mount, and the job args as env', async () => {
  const { exec, calls } = fake(() => ({ code: 0, stdout: 'abc123\n' }));
  const root = await outRoot();
  const r = dockerRunner({ exec, outRoot: root, allow: ['charter-job-fetch'] });
  await r.create('l1', JOB);
  assert.equal(calls.length, 1);
  const a = calls[0]!.args;
  assert.equal(a[0], 'create');
  assert.ok(!a.includes('run') && !a.includes('-d'));
  const has = (...seq: string[]) =>
    assert.ok(
      a.some((_, i) => seq.every((s, j) => a[i + j] === s)),
      `argv missing ${seq.join(' ')}: ${a.join(' ')}`,
    );
  has('--name', 'charter-l1');
  has('--cpus', '1');
  has('--memory', '1g');
  has('--pids-limit', '256');
  has('--read-only');
  has('--tmpfs', '/tmp');
  // F-C4: no capabilities, and nothing in the container can gain more.
  has('--cap-drop', 'ALL');
  has('--security-opt', 'no-new-privileges');
  has('-v', `${join(root, 'l1')}:/out`);
  has('-e', 'URLS=https://example.com,https://example.org');
  assert.equal(a[a.length - 1], 'charter-job-fetch');
  assert.ok(!a.includes('--add-host'));
  assert.ok(!a.some((x) => x.startsWith('CHARTER_PROXY')));
  assert.ok((await stat(join(root, 'l1'))).isDirectory());
});

test('F-C3: start emits docker start charter-<id>, and a failure rejects boot_failed', async () => {
  let code = 0;
  const { exec, calls } = fake(() => ({ code, stderr: 'oops' }));
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await r.start('l1');
  assert.deepEqual(calls[0]!.args, ['start', 'charter-l1']);
  code = 1;
  await assert.rejects(r.start('l1'), (e: unknown) => e instanceof RunnerError && e.code === 'boot_failed');
  await assert.rejects(r.start('../x'), (e: unknown) => e instanceof RunnerError && e.code === 'bad_input');
});

test('start with a proxy adds host-gateway and rewrites a loopback proxy host', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({
    exec,
    outRoot: await outRoot(),
    allow: ['charter-job-fetch'],
    proxy: 'socks5://127.0.0.1:9050',
  });
  await r.create('l1', JOB);
  const a = calls[0]!.args;
  const i = a.indexOf('--add-host');
  assert.equal(a[i + 1], 'host.docker.internal:host-gateway');
  assert.ok(a.includes('CHARTER_PROXY=socks5://host.docker.internal:9050'));
});

test('start with a non-loopback proxy passes it through unchanged', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({
    exec,
    outRoot: await outRoot(),
    allow: ['charter-job-fetch'],
    proxy: 'socks5://proxy.internal:1080',
  });
  await r.create('l1', JOB);
  assert.ok(calls[0]!.args.includes('CHARTER_PROXY=socks5://proxy.internal:1080'));
});

test('a docker failure rejects create', async () => {
  const { exec } = fake(() => ({ code: 125, stderr: 'no such image' }));
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await assert.rejects(r.create('l1', JOB), (e: unknown) => e instanceof RunnerError && e.code === 'boot_failed');
});

test('create rejects a lease id or arg name that could escape', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await assert.rejects(r.create('../x', JOB), (e: unknown) => e instanceof RunnerError && e.code === 'bad_input');
  const r2 = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'], allowArgs: ['A=B'] });
  await assert.rejects(
    r2.create('l1', { image: 'charter-job-fetch', args: { 'A=B': 'x' } }),
    (e: unknown) => e instanceof RunnerError && e.code === 'bad_input',
  );
  assert.equal(calls.length, 0);
});

test('create refuses tenant args outside the allow list, before any docker call', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({
    exec,
    outRoot: await outRoot(),
    allow: ['charter-job-fetch'],
    proxy: 'socks5://proxy.internal:1080',
  });
  for (const k of ['CHARTER_PROXY', 'NODE_OPTIONS', 'LD_PRELOAD', 'PLAYWRIGHT_BROWSERS_PATH']) {
    await assert.rejects(
      r.create('l1', { image: 'charter-job-fetch', args: { URLS: 'https://example.com', [k]: 'x' } }),
      (e: unknown) => e instanceof RunnerError && e.code === 'arg_not_allowed',
      k,
    );
  }
  assert.equal(calls.length, 0);
  await r.create('l1', JOB);
  assert.equal(calls.length, 1);
});

test('allowArgs widens what a tenant may set', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'], allowArgs: ['URLS', 'MODE'] });
  await r.create('l1', { image: 'charter-job-fetch', args: { URLS: 'https://example.com', MODE: 'fast' } });
  assert.ok(calls[0]!.args.includes('MODE=fast'));
});

test('stop emits docker rm -f charter-<id>', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: [] });
  await r.stop('l1');
  assert.deepEqual(calls[0]!.args, ['rm', '-f', 'charter-l1']);
});

test('exited resolves with the exit code from docker wait', async () => {
  const { exec, calls } = fake(() => ({ code: 0, stdout: '2\n' }));
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: [] });
  assert.equal(await r.exited('l1'), 2);
  assert.deepEqual(calls[0]!.args, ['wait', 'charter-l1']);
});

test('alive reads State.Running and is false when the container is gone', async () => {
  let reply = { code: 0, stdout: 'true\n' };
  const { exec, calls } = fake(() => reply);
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: [] });
  assert.equal(await r.alive('l1'), true);
  assert.deepEqual(calls[0]!.args, ['inspect', '-f', '{{.State.Running}}', 'charter-l1']);
  reply = { code: 0, stdout: 'false\n' };
  assert.equal(await r.alive('l1'), false);
  reply = { code: 1, stdout: '' };
  assert.equal(await r.alive('l1'), false);
});

test('output reads result.json from the lease out dir', async () => {
  const { exec } = fake();
  const root = await outRoot();
  await mkdir(join(root, 'l1'), { recursive: true });
  await writeFile(join(root, 'l1', 'result.json'), '{"pages":[]}');
  const r = dockerRunner({ exec, outRoot: root, allow: [] });
  assert.equal((await r.output('l1')).toString(), '{"pages":[]}');
});

test('output refuses a symlinked result.json', async () => {
  const { exec } = fake();
  const root = await outRoot();
  await mkdir(join(root, 'l1'), { recursive: true });
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'host secret');
  await symlink(secret, join(root, 'l1', 'result.json'));
  const r = dockerRunner({ exec, outRoot: root, allow: [] });
  await assert.rejects(r.output('l1'), (e: unknown) => e instanceof RunnerError && e.code === 'bad_output');
});

test('output refuses an oversize result.json and accepts one at the cap', async () => {
  const { exec } = fake();
  const root = await outRoot();
  await mkdir(join(root, 'l1'), { recursive: true });
  const r = dockerRunner({ exec, outRoot: root, allow: [] });
  await writeFile(join(root, 'l1', 'result.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  await assert.rejects(r.output('l1'), (e: unknown) => e instanceof RunnerError && e.code === 'bad_output');
  await writeFile(join(root, 'l1', 'result.json'), Buffer.alloc(8 * 1024 * 1024, 0x20));
  assert.equal((await r.output('l1')).length, 8 * 1024 * 1024);
});

test('output refuses a result.json that is a directory', async () => {
  const { exec } = fake();
  const root = await outRoot();
  await mkdir(join(root, 'l1', 'result.json'), { recursive: true });
  const r = dockerRunner({ exec, outRoot: root, allow: [] });
  await assert.rejects(r.output('l1'), (e: unknown) => e instanceof RunnerError && e.code === 'bad_output');
});
