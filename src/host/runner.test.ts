import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from '../exec.js';
import { dockerRunner, RunnerError, type HomeRunnerOpts } from './runner.js';
import { homeIdOf, homeJob, normalizeSshKeys } from '../jobs.js';
import { HomeStore } from './homes.js';

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

const PY = { image: 'charter-job-python', args: { SCRIPT: 'print(1)\nprint(2)' } };

test('the python job gets no network and no proxy, even on a host that has one', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({
    exec,
    outRoot: await outRoot(),
    allow: ['charter-job-fetch', 'charter-job-python'],
    proxy: 'socks5://127.0.0.1:9050',
  });
  await r.create('l1', PY);
  const a = calls[0]!.args;
  const i = a.indexOf('--network');
  assert.equal(a[i + 1], 'none');
  assert.ok(!a.includes('--add-host'));
  assert.ok(!a.some((x) => x.startsWith('CHARTER_PROXY')));
  assert.ok(a.includes('SCRIPT=print(1)\nprint(2)'));
  assert.equal(a[a.length - 1], 'charter-job-python');
});

test('the python job keeps the v1 limits and adds a capped /tmp, no swap and a per-file size cap', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-python'] });
  await r.create('l1', PY);
  const a = calls[0]!.args;
  const has = (...seq: string[]) =>
    assert.ok(a.some((_, i) => seq.every((s, j) => a[i + j] === s)), `argv missing ${seq.join(' ')}: ${a.join(' ')}`);
  has('--cpus', '1');
  has('--memory', '1g');
  has('--memory-swap', '1g');
  has('--pids-limit', '256');
  has('--read-only');
  has('--cap-drop', 'ALL');
  has('--security-opt', 'no-new-privileges');
  has('--tmpfs', '/tmp:size=64m');
  has('--ulimit', 'fsize=8388608');
  // The wrapper's own 600 s cap was built for 30 s intervals; the paid time ends the job now.
  has('-e', 'CHARTER_WALL_SECONDS=2592000');
});

test('the fetch job gets no wall cap variable', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'] });
  await r.create('l1', JOB);
  assert.ok(!calls[0]!.args.some((x) => x.startsWith('CHARTER_WALL_SECONDS')));
});

test('the fetch job keeps its v1 network: no --network flag, the proxy handed in', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch'], proxy: 'socks5://127.0.0.1:9050' });
  await r.create('l1', JOB);
  assert.ok(!calls[0]!.args.includes('--network'));
  assert.ok(calls[0]!.args.includes('CHARTER_PROXY=socks5://host.docker.internal:9050'));
});

test('the python job refuses URLS, a script past 8 KiB, and a NUL, before any docker call', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-python'] });
  const refused = (args: Record<string, string>, code: string) =>
    assert.rejects(
      r.create('l1', { image: 'charter-job-python', args }),
      (e: unknown) => e instanceof RunnerError && e.code === code,
    );
  await refused({ URLS: 'https://example.com' }, 'arg_not_allowed');
  await refused({ SCRIPT: 'x'.repeat(8 * 1024 + 1) }, 'bad_input');
  await refused({ SCRIPT: 'print(1)\0' }, 'bad_input');
  assert.equal(calls.length, 0);
  await r.create('l1', { image: 'charter-job-python', args: { SCRIPT: 'x'.repeat(8 * 1024) } });
  assert.equal(calls.length, 1);
});

test('a runtime, such as gVisor, applies to every job', async () => {
  const { exec, calls } = fake();
  const r = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-job-fetch', 'charter-job-python'], runtime: 'runsc' });
  await r.create('l1', PY);
  await r.create('l2', JOB);
  for (const c of calls) assert.equal(c.args[c.args.indexOf('--runtime') + 1], 'runsc');
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

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 edison@air';
const KEYS = normalizeSshKeys([KEY])!;
const HOME_ID = homeIdOf(KEYS);
const HOME = homeJob(KEYS);
const GIB = 1024 ** 3;

async function homeSetup(free = 10 * GIB) {
  const root = await mkdtemp(join(tmpdir(), 'charter-home-'));
  const homesDir = join(root, 'homes');
  const kills: Array<[number, string]> = [];
  const tools: string[] = [];
  // Volumes docker knows about; inspect succeeds only after create.
  const volumes = new Set<string>();
  const { exec, calls } = fake((args) => {
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: volumes.has(args[2]!) ? 0 : 1 };
    if (args[0] === 'volume' && args[1] === 'create') volumes.add(args[args.length - 1]!);
    if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args[args.length - 1]!);
    return { code: 0 };
  });
  const homes = new HomeStore();
  const pidFile = join(root, 'anon.pid');
  await writeFile(pidFile, '4242\n');
  const home: HomeRunnerOpts = {
    homesDir,
    network: 'charter-home',
    gateway: '172.19.0.1',
    socksPort: 9050,
    httpPort: 9080,
    homes,
    anon: { hsDir: join(root, 'hs.d'), homesDir, pidFile, kill: (pid, sig) => void kills.push([pid, sig]) },
    tools: {
      // Like the real truncate, it leaves the file behind, so a second ensureHome sees the disk.
      truncate: async (args) => {
        tools.push(`truncate ${args.join(' ')}`);
        await writeFile(args[args.length - 1]!, '');
        return { code: 0, stdout: '', stderr: '' };
      },
      mkfs: async (args) => {
        tools.push(`mkfs ${args.join(' ')}`);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    offerJson: '{"price":"7000"}',
    connectorUrl: 'https://connector.mainnet.toonprotocol.dev',
    freeBytes: async () => free,
    now: () => 1_700_000_000_000,
  };
  const r = dockerRunner({ exec, outRoot: join(root, 'out'), allow: ['charter-home'], runtime: 'runsc', home });
  return { r, calls, tools, kills, homes, home, homesDir, root };
}

test('create for a home puts the box on its network with its disk, its port and its env, and nothing of a job\'s', async () => {
  const t = await homeSetup();
  const rec = await t.r.ensureHome(HOME_ID);
  assert.equal(rec.port, 22000);
  t.calls.length = 0;
  await t.r.create('l1', HOME);
  const a = t.calls[0]!.args;
  const has = (...seq: string[]) =>
    assert.ok(a.some((_, i) => seq.every((s, j) => a[i + j] === s)), `argv missing ${seq.join(' ')}: ${a.join(' ')}`);
  has('--network', 'charter-home');
  has('--dns', '172.19.0.1');
  has('-p', '127.0.0.1:22000:2222');
  has('--mount', `type=volume,src=charter-home-${HOME_ID},dst=/home/tenant`);
  has('-v', `${join(t.homesDir, HOME_ID, 'charter')}:/charter:ro`);
  has('--pids-limit', '512');
  has('--restart', 'unless-stopped');
  has('--tmpfs', '/tmp:size=256m');
  has('--tmpfs', '/run');
  has('--runtime', 'runsc');
  has('--read-only');
  has('--cap-drop', 'ALL');
  has('-e', 'HTTP_PROXY=http://172.19.0.1:9080');
  has('-e', 'HTTPS_PROXY=http://172.19.0.1:9080');
  has('-e', 'ALL_PROXY=socks5h://172.19.0.1:9050');
  has('-e', 'NO_PROXY=127.0.0.1,localhost');
  has('-e', 'NODE_USE_ENV_PROXY=1');
  has('-e', 'CHARTER_LEASE_ID=l1');
  has('-e', `CHARTER_HOME_ID=${HOME_ID}`);
  has('-e', 'CHARTER_PAID_THROUGH_FILE=/charter/paid-through');
  has('-e', 'CHARTER_OFFER_JSON={"price":"7000"}');
  has('-e', 'CHARTER_CONNECTOR_URL=https://connector.mainnet.toonprotocol.dev');
  has('-e', `SSH_KEYS=${KEYS.join('\n')}`);
  assert.equal(a[a.length - 1], 'charter-home');
  assert.ok(!a.some((x) => x.endsWith(':/out')));
  assert.ok(!a.includes('--add-host'));
  assert.ok(!a.some((x) => x.startsWith('CHARTER_PROXY')));
  assert.equal(a.filter((x) => x === '--pids-limit').length, 1);
  assert.equal(a.indexOf('--network'), a.indexOf('--dns') - 2);
});

test('create for a home refuses with no home record, bad keys, or a host without homes', async () => {
  const t = await homeSetup();
  await assert.rejects(t.r.create('l1', HOME), (e: unknown) => e instanceof RunnerError && e.code === 'bad_input');
  await t.r.ensureHome(HOME_ID);
  await assert.rejects(
    t.r.create('l1', { image: 'charter-home', args: { SSH_KEYS: 'not a key' } }),
    (e: unknown) => e instanceof RunnerError && e.code === 'bad_input',
  );
  const { exec, calls } = fake();
  const bare = dockerRunner({ exec, outRoot: await outRoot(), allow: ['charter-home'] });
  await assert.rejects(bare.create('l1', HOME), (e: unknown) => e instanceof RunnerError && e.code === 'image_not_allowed');
  assert.equal(calls.length, 0);
});

test('ensureHome makes the disk and volume once and refuses a new disk under the free-space floor', async () => {
  const t = await homeSetup();
  const disk = join(t.homesDir, HOME_ID, 'disk.img');
  const rec = await t.r.ensureHome(HOME_ID);
  assert.deepEqual(rec, { homeId: HOME_ID, port: 22000, createdAt: 1_700_000_000_000, paidOnce: false });
  assert.deepEqual(t.homes.get(HOME_ID), rec);
  assert.deepEqual(t.tools, [`truncate -s 2G ${disk}`, `mkfs -F -q -m 0 ${disk}`]);
  const vol = `charter-home-${HOME_ID}`;
  assert.deepEqual(
    t.calls.map((c) => c.args.slice(0, 2).join(' ')),
    ['volume inspect', 'volume create'],
  );
  assert.ok(t.calls[1]!.args.includes(`device=${disk}`));
  assert.equal(t.calls[1]!.args[t.calls[1]!.args.length - 1], vol);
  assert.ok((await stat(join(t.homesDir, HOME_ID, 'charter'))).isDirectory());

  t.tools.length = 0;
  t.calls.length = 0;
  assert.deepEqual(await t.r.ensureHome(HOME_ID), rec);
  assert.deepEqual(t.tools, []);
  assert.deepEqual(t.calls.map((c) => c.args.join(' ')), [`volume inspect ${vol}`]);

  // A second home takes the next port.
  const other = homeIdOf(normalizeSshKeys(['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG90aGVy'])!);
  assert.equal((await t.r.ensureHome(other)).port, 22001);

  const low = await homeSetup(2 * GIB);
  await assert.rejects(
    low.r.ensureHome(HOME_ID),
    (e: unknown) => e instanceof RunnerError && e.code === 'boot_failed' && e.message.includes('no disk'),
  );
  assert.deepEqual(low.tools, []);
});

test('ensureHome wraps a volume failure as boot_failed', async () => {
  const t = await homeSetup();
  const { exec } = fake(() => ({ code: 1, stderr: 'loop device busy' }));
  const r = dockerRunner({ exec, outRoot: join(t.root, 'out'), allow: ['charter-home'], home: t.home });
  await assert.rejects(
    r.ensureHome(HOME_ID),
    (e: unknown) => e instanceof RunnerError && e.code === 'boot_failed' && e.message.includes('loop device busy'),
  );
});

test('publishHome and retireHome write and remove the hidden service and HUP anon', async () => {
  const t = await homeSetup();
  await t.r.ensureHome(HOME_ID);
  await t.r.publishHome(HOME_ID);
  const conf = join(t.home.anon.hsDir, `${HOME_ID}.conf`);
  assert.match(await readFile(conf, 'utf8'), /HiddenServicePort 22 127\.0\.0\.1:22000/);
  assert.equal((await stat(join(t.homesDir, HOME_ID, 'hs'))).mode & 0o777, 0o700);
  assert.deepEqual(t.kills, [[4242, 'SIGHUP']]);
  t.kills.length = 0;
  await t.r.retireHome(HOME_ID);
  await assert.rejects(access(conf));
  assert.ok((await stat(join(t.homesDir, HOME_ID, 'hs'))).isDirectory());
  assert.deepEqual(t.kills, [[4242, 'SIGHUP']]);
});

test('homeAccess is null until the hostname exists', async () => {
  const t = await homeSetup();
  await t.r.ensureHome(HOME_ID);
  await t.r.publishHome(HOME_ID);
  assert.equal(await t.r.homeAccess(HOME_ID), null);
  const host = `${'a'.repeat(56)}.anyone`;
  await writeFile(join(t.homesDir, HOME_ID, 'hs', 'hostname'), host + '\n');
  assert.deepEqual(await t.r.homeAccess(HOME_ID), { ssh: { host, port: 22, user: 'tenant' } });
});

test('removeHome removes the volume, the directory and the record', async () => {
  const t = await homeSetup();
  await t.r.ensureHome(HOME_ID);
  t.calls.length = 0;
  await t.r.removeHome(HOME_ID);
  assert.deepEqual(t.calls.map((c) => c.args.join(' ')), [`volume rm -f charter-home-${HOME_ID}`]);
  await assert.rejects(access(join(t.homesDir, HOME_ID)));
  assert.equal(t.homes.get(HOME_ID), undefined);
});

test('writePaidThrough writes the epoch ms where the box reads it', async () => {
  const t = await homeSetup();
  await t.r.ensureHome(HOME_ID);
  await t.r.writePaidThrough(HOME_ID, 1_700_000_123_456);
  const file = join(t.homesDir, HOME_ID, 'charter', 'paid-through');
  assert.equal(await readFile(file, 'utf8'), '1700000123456\n');
  await t.r.writePaidThrough(HOME_ID, 1_700_000_999_999);
  assert.equal(await readFile(file, 'utf8'), '1700000999999\n');
});

test('home operations refuse an id that is not a home id', async () => {
  const t = await homeSetup();
  for (const id of ['../x', '', 'ABCDEF0123456789']) {
    await assert.rejects(t.r.removeHome(id), (e: unknown) => e instanceof RunnerError && e.code === 'bad_input', id);
  }
  assert.equal(t.calls.length, 0);
});
