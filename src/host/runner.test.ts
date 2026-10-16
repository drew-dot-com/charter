import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
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

test('start refuses an image not on the allow list and never calls docker', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await assert.rejects(
    r.start('l1', { image: 'evil:latest', args: {} }),
    (e: unknown) => e instanceof RunnerError && e.code === 'image_not_allowed',
  );
  assert.equal(calls.length, 0);
});

test('start emits docker run -d with the limits, the out mount, and the job args as env', async () => {
  const { exec, calls } = fake(() => ({ code: 0, stdout: 'abc123\n' }));
  const root = await outRoot();
  const r = dockerRunner({ exec, outRoot: root, allow: ['charter-job-fetch'] });
  await r.start('l1', JOB);
  assert.equal(calls.length, 1);
  const a = calls[0]!.args;
  assert.deepEqual(a.slice(0, 2), ['run', '-d']);
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
  has('-v', `${join(root, 'l1')}:/out`);
  has('-e', 'URLS=https://example.com,https://example.org');
  assert.equal(a[a.length - 1], 'charter-job-fetch');
  assert.ok(!a.includes('--add-host'));
  assert.ok(!a.some((x) => x.startsWith('CHARTER_PROXY')));
  assert.ok((await stat(join(root, 'l1'))).isDirectory());
});

test('start with a proxy adds host-gateway and rewrites a loopback proxy host', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({
    exec,
    outRoot: await outRoot(),
    allow: ['charter-job-fetch'],
    proxy: 'socks5://127.0.0.1:9050',
  });
  await r.start('l1', JOB);
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
  await r.start('l1', JOB);
  assert.ok(calls[0]!.args.includes('CHARTER_PROXY=socks5://proxy.internal:1080'));
});

test('a docker failure rejects start', async () => {
  const { exec } = fake(() => ({ code: 125, stderr: 'no such image' }));
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await assert.rejects(r.start('l1', JOB), (e: unknown) => e instanceof RunnerError && e.code === 'boot_failed');
});

test('start rejects a lease id or arg name that could escape', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await assert.rejects(r.start('../x', JOB), (e: unknown) => e instanceof RunnerError && e.code === 'bad_input');
  await assert.rejects(
    r.start('l1', { image: 'charter-job-fetch', args: { 'A=B': 'x' } }),
    (e: unknown) => e instanceof RunnerError && e.code === 'bad_input',
  );
  assert.equal(calls.length, 0);
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
