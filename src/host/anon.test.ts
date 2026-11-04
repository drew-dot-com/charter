import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AnonError,
  hiddenServiceConf,
  onionHostname,
  publishHiddenService,
  reloadAnon,
  retireHiddenService,
  type AnonDeps,
} from './anon.js';

async function setup(withPid = true) {
  const root = await mkdtemp(join(tmpdir(), 'charter-anon-'));
  const kills: Array<[number, string]> = [];
  const d: AnonDeps = {
    hsDir: join(root, 'hs.d'),
    homesDir: join(root, 'homes'),
    pidFile: join(root, 'anon.pid'),
    kill: (pid, sig) => void kills.push([pid, sig]),
  };
  await mkdir(d.hsDir, { recursive: true });
  if (withPid) await writeFile(d.pidFile, '4242\n');
  return { d, kills };
}

test('publishHiddenService writes the conf, makes the service dir 0700 and HUPs anon once', async () => {
  const { d, kills } = await setup();
  await publishHiddenService(d, 'h1', 2201);
  const conf = await readFile(join(d.hsDir, 'h1.conf'), 'utf8');
  assert.equal(
    conf,
    `HiddenServiceDir ${d.homesDir}/h1/hs\nHiddenServiceVersion 3\nHiddenServicePort 22 127.0.0.1:2201\n`,
  );
  assert.equal(conf.trimEnd().split('\n').length, 3);
  assert.equal((await stat(join(d.homesDir, 'h1', 'hs'))).mode & 0o777, 0o700);
  assert.deepEqual(kills, [[4242, 'SIGHUP']]);
  assert.equal(hiddenServiceConf(d.homesDir, 'h1', 2201) + '\n', conf);
});

test('publishHiddenService is idempotent', async () => {
  const { d } = await setup();
  await publishHiddenService(d, 'h1', 2201);
  await publishHiddenService(d, 'h1', 2201);
  assert.match(await readFile(join(d.hsDir, 'h1.conf'), 'utf8'), /127\.0\.0\.1:2201/);
});

test('retireHiddenService removes the conf, keeps the keys dir and HUPs', async () => {
  const { d, kills } = await setup();
  await publishHiddenService(d, 'h1', 2201);
  const key = join(d.homesDir, 'h1', 'hs', 'hs_ed25519_secret_key');
  await writeFile(key, 'secret');
  kills.length = 0;
  await retireHiddenService(d, 'h1');
  await assert.rejects(access(join(d.hsDir, 'h1.conf')));
  assert.equal(await readFile(key, 'utf8'), 'secret');
  assert.deepEqual(kills, [[4242, 'SIGHUP']]);
  await retireHiddenService(d, 'h1'); // already gone: still fine
});

test('onionHostname is undefined until anon writes it, then the trimmed address, and refuses junk', async () => {
  const { d } = await setup();
  assert.equal(await onionHostname(d, 'h1'), undefined);
  await publishHiddenService(d, 'h1', 2201);
  assert.equal(await onionHostname(d, 'h1'), undefined);
  const addr = `${'abcdefg234567'.repeat(5).slice(0, 56)}.anyone`;
  const f = join(d.homesDir, 'h1', 'hs', 'hostname');
  await writeFile(f, `${addr}\n`);
  assert.equal(await onionHostname(d, 'h1'), addr);
  await writeFile(f, 'nope');
  await assert.rejects(onionHostname(d, 'h1'), (e) => e instanceof AnonError && e.code === 'bad_hostname');
});

test('reloadAnon without a pid file throws no_pid and kills nothing', async () => {
  const { d, kills } = await setup(false);
  await assert.rejects(reloadAnon(d), (e) => e instanceof AnonError && e.code === 'no_pid');
  await writeFile(d.pidFile, 'abc');
  await assert.rejects(reloadAnon(d), (e) => e instanceof AnonError && e.code === 'no_pid');
  assert.deepEqual(kills, []);
});
