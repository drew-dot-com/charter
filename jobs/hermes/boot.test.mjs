import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const BOOT = join(dirname(fileURLToPath(import.meta.url)), 'boot-default.sh');

// `charter address` prints the key file's address; `charter renew` logs what it was given and fails, so the
// loop must retry.
const CHARTER_STUB = `#!/bin/sh
if [ "$1" = address ]; then echo 0xabc; exit 0; fi
echo "charter $* CHARTER_KEY_FILE=$CHARTER_KEY_FILE CHARTER_DOOR_URL=$CHARTER_DOOR_URL CHARTER_MAX_TICK=\${CHARTER_MAX_TICK:-unset} CHARTER_OFFER_JSON=\${CHARTER_OFFER_JSON:-unset} CHARTER_PAYER=\${CHARTER_PAYER:-unset}" >> "$STUB_LOG"
exit 1
`;
const HERMES_STUB = `#!/bin/sh
mkdir "$STUB_LOG.gateway" 2>/dev/null || echo "OVERLAP two gateways at once" >> "$STUB_LOG"
echo "hermes $* CHARTER_BIN=$CHARTER_BIN CHARTER_KEY_FILE=$CHARTER_KEY_FILE CHARTER_DOOR_URL=$CHARTER_DOOR_URL" >> "$STUB_LOG"
echo $$ > "$STUB_LOG.gateway-pid"
# A gateway stopped with TERM is gone once it exits: the marker goes with it.
trap 'rmdir "$STUB_LOG.gateway" 2>/dev/null; exit 143' TERM
sleep \${STUB_GATEWAY_S:-1} &
wait $!
rmdir "$STUB_LOG.gateway" 2>/dev/null
exit 3
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A pid that named a process a moment ago and names none now. */
async function deadPid() {
  const c = spawn('true');
  await new Promise((r) => c.on('exit', r));
  return c.pid;
}

async function setup(t, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'charter-boot-'));
  const bin = join(tmp, 'bin');
  const home = join(tmp, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, 'charter'), CHARTER_STUB);
  writeFileSync(join(bin, 'hermes'), HERMES_STUB);
  chmodSync(join(bin, 'charter'), 0o755);
  chmodSync(join(bin, 'hermes'), 0o755);
  const stubLog = join(tmp, 'stub.log');
  writeFileSync(stubLog, '');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    // The lock lives in TMPDIR: one per test, so the tests can run side by side.
    TMPDIR: tmp,
    HOME: home,
    HERMES_HOME: join(home, '.hermes'),
    STUB_LOG: stubLog,
    CHARTER_LEASE_ID: 'abc',
    CHARTER_DOOR_URL: 'https://door.example',
    // What a box made before renewals paid the door still carries: the boot drops it.
    CHARTER_OFFER_JSON: '{"id":"o1","hostPubkey":""}',
    CHARTER_PAYER: 'url',
    CHARTER_BOOT_RENEW_SLEEP_S: '1',
    CHARTER_BOOT_GATEWAY_SLEEP_S: '1',
    CHARTER_BOOT_ENV_POLL_S: '1',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const children = [];
  let out = '';
  const boot = (...args) => {
    const child = spawn('sh', [BOOT, ...args], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
    children.push(child);
    return child;
  };
  const spare = [];
  t.after(() => {
    // Each whole group: the renew loop and the gateway run in the background of the script.
    for (const child of children) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const pid of spare) try { process.kill(pid, 'SIGKILL'); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });
  // An unrelated live process, the kind a stale pidfile names after a restart reuses its pid.
  const bystander = () => {
    const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    spare.push(c.pid);
    return c.pid;
  };
  const charterDir = join(home, '.charter');
  const read = (name) => readFileSync(join(charterDir, name), 'utf8').trim();
  return { home, stubLog, boot, bystander, charterDir, read, lock: join(tmp, 'charter-boot.lock'), log: () => readFileSync(stubLog, 'utf8'), out: () => out };
}

// Each test has its own home, port and stubs, so they run side by side.
describe('boot-default', { concurrency: true }, () => {
  test('boot-default: key, address, renew through the door, then the gateway once .env exists, restarted after it exits', async (t) => {
    const { home, boot, log, out } = await setup(t);
    boot();
    await sleep(4000);
    const key = join(home, '.charter', 'payer.key');
    assert.match(readFileSync(key, 'utf8'), /^[0-9a-f]{64}\n?$/);
    assert.equal(statSync(key).mode & 0o777, 0o400);
    assert.equal(readFileSync(join(home, '.charter', 'payer.address'), 'utf8').trim(), '0xabc');
    assert.doesNotMatch(log(), /charter payer/, 'no payer service');
    assert.match(log(), new RegExp(`charter renew --lease abc --max-intervals 720 CHARTER_KEY_FILE=${key} CHARTER_DOOR_URL=https://door.example CHARTER_MAX_TICK=unset CHARTER_OFFER_JSON=unset CHARTER_PAYER=unset`));
    assert.ok(log().match(/charter renew/g).length >= 2, 'a failed renew is retried');
    assert.doesNotMatch(log(), /hermes gateway/, 'no gateway before .env');
    assert.match(out(), /boot: payer address 0xabc/);
    assert.match(out(), /boot: renew started/);
    assert.match(out(), /boot: waiting for ~\/\.hermes\/\.env/);

    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    // Up to 1 s to see .env, 1 s of gateway, 1 s before the restart, and slack for the tests beside it.
    await sleep(4500);
    assert.match(log(), /hermes gateway run/);
    assert.ok(log().match(/hermes gateway run/g).length >= 2, 'the gateway is restarted after it exits');
    assert.match(log(), new RegExp(`hermes gateway run CHARTER_BIN=/usr/local/bin/charter CHARTER_KEY_FILE=${key} CHARTER_DOOR_URL=https://door.example`));
    assert.match(out(), /boot: gateway started/);
    assert.match(out(), /boot: gateway exited \(3\), restarting in 1 s/);
    assert.doesNotMatch(log(), /OVERLAP/);
  });

  test('boot-default: a second run while the first is alive exits, and a stopped boot can start again', async (t) => {
    const { home, boot, lock, log, out } = await setup(t);
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    const first = boot();
    await sleep(1500);
    const second = boot();
    const ran = await Promise.race([second.exited, sleep(2000).then(() => 'still running')]);
    assert.equal(ran, 0, 'the second run must exit at once');
    assert.match(out(), new RegExp(`boot: already running \\(lock ${lock};`));
    await sleep(2500);
    assert.doesNotMatch(log(), /OVERLAP/, 'one gateway at a time');
    // A stopped boot takes its gateway and renew loop with it and frees the lock.
    process.kill(first.pid, 'SIGTERM');
    await first.exited;
    await sleep(1500);
    const quiet = log();
    await sleep(1500);
    assert.equal(log(), quiet, 'nothing the stopped boot started is still running');
    assert.equal(statSync(lock, { throwIfNoEntry: false }), undefined, 'the lock is released');
    boot();
    await sleep(1500);
    assert.ok(out().match(/boot: gateway started/g).length > 1);
  });

  test('boot-default: boot.pid holds the running boot and goes with it', async (t) => {
    const { home, boot } = await setup(t);
    const child = boot();
    await sleep(2500);
    const pidFile = join(home, '.charter', 'boot.pid');
    assert.equal(readFileSync(pidFile, 'utf8').trim(), String(child.pid));
    process.kill(child.pid, 'SIGTERM');
    await child.exited;
    assert.equal(statSync(pidFile, { throwIfNoEntry: false }), undefined, 'boot.pid is removed when the boot stops');
  });

  test('boot-default: payer.env overrides reach renew and the gateway', async (t) => {
    const { charterDir, boot, log } = await setup(t, { STUB_GATEWAY_S: '60' });
    mkdirSync(join(charterDir, '..', '.hermes'), { recursive: true });
    writeFileSync(join(charterDir, '..', '.hermes', '.env'), 'X=1\n');
    mkdirSync(charterDir, { recursive: true });
    const key = join(charterDir, 'funded.key');
    writeFileSync(key, `${'1'.repeat(64)}\n`);
    writeFileSync(join(charterDir, 'payer.env'), `CHARTER_KEY_FILE=${key}\nCHARTER_DOOR_URL=https://other.example\nCHARTER_MAX_TICK=20000\n`);
    boot();
    await sleep(2500);
    assert.match(log(), new RegExp(`charter renew --lease abc --max-intervals 720 CHARTER_KEY_FILE=${key} CHARTER_DOOR_URL=https://other.example CHARTER_MAX_TICK=20000`));
    assert.match(log(), new RegExp(`hermes gateway run CHARTER_BIN=/usr/local/bin/charter CHARTER_KEY_FILE=${key} CHARTER_DOOR_URL=https://other.example`));
    assert.equal(statSync(join(charterDir, 'payer.key'), { throwIfNoEntry: false }), undefined, 'a key file named in payer.env is used, no other made');
  });

  test('boot-default: with no CHARTER_LEASE_ID renew is not started, and a box with no CHARTER_DOOR_URL pays the main door', async (t) => {
    const { boot, log, out } = await setup(t, { CHARTER_LEASE_ID: undefined, CHARTER_DOOR_URL: undefined, STUB_GATEWAY_S: '60' });
    const child = boot();
    await sleep(2000);
    assert.match(out(), /boot: no CHARTER_LEASE_ID, renew not started/);
    assert.doesNotMatch(log(), /charter renew/);
    process.kill(child.pid, 'SIGTERM');
    await child.exited;
    const { boot: boot2, log: log2 } = await setup(t, { CHARTER_DOOR_URL: undefined });
    boot2();
    await sleep(2000);
    assert.match(log2(), /charter renew --lease abc --max-intervals 720 .*CHARTER_DOOR_URL=https:\/\/charterhome\.dev /);
  });

  test('boot-default: stale pidfiles and a stale lock left by a SIGKILL do not stop the next start', async (t) => {
    const { charterDir, lock, boot, bystander, read, log, out } = await setup(t);
    const other = bystander();
    mkdirSync(charterDir, { recursive: true });
    writeFileSync(join(charterDir, 'boot.pid'), `${other}\n`);
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${await deadPid()}\n`);
    const child = boot();
    await sleep(2500);
    assert.doesNotMatch(out(), /already running/);
    assert.match(out(), /boot: took a stale lock/);
    assert.match(log(), /charter renew/);
    assert.equal(read('boot.pid'), String(child.pid));
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(child.pid));
    assert.ok(alive(other), 'the process a stale pidfile named is left alone');
  });

  test('boot-default: a boot killed with SIGKILL is taken over: its gateway and renew loop stop', async (t) => {
    const { home, lock, boot, stubLog, log, out } = await setup(t, { STUB_GATEWAY_S: '60' });
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    const first = boot();
    await sleep(2500);
    const gateway = Number(readFileSync(`${stubLog}.gateway-pid`, 'utf8').trim());
    const loops = ['renew.pid'].map((f) => Number(readFileSync(join(lock, f), 'utf8').trim()));
    assert.ok(alive(gateway) && loops.every(alive));
    process.kill(first.pid, 'SIGKILL');
    await first.exited;
    boot();
    await sleep(2500);
    assert.match(out(), /boot: took a stale lock/);
    assert.ok(!alive(gateway), 'the old gateway is stopped, so two never poll one bot token');
    assert.ok(loops.every((pid) => !alive(pid)), 'the old renew loop is stopped');
    assert.equal(log().match(/hermes gateway run/g).length, 2, 'the new boot runs its own gateway');
    assert.doesNotMatch(log(), /OVERLAP/);
  });

  test('boot-default: `boot.sh stop` stops the boot, and leaves a pid it does not own alone', async (t) => {
    const { home, charterDir, boot, bystander, out } = await setup(t);
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    const first = boot();
    await sleep(2500);
    const stop = boot('stop');
    assert.equal(await stop.exited, 0);
    assert.equal(await Promise.race([first.exited.then(() => 'stopped'), sleep(3000).then(() => 'running')]), 'stopped');
    assert.equal(statSync(join(charterDir, 'boot.pid'), { throwIfNoEntry: false }), undefined);
    assert.match(out(), /boot: stopped the boot \d+/);

    const other = bystander();
    writeFileSync(join(charterDir, 'boot.pid'), `${other}\n`);
    const again = boot('stop');
    assert.equal(await again.exited, 0);
    assert.ok(alive(other), 'a stale pidfile is removed, its pid never killed');
    assert.equal(statSync(join(charterDir, 'boot.pid'), { throwIfNoEntry: false }), undefined);
    assert.match(out(), /boot: no boot running/);
  });
  test('boot-default: a boot waiting out its 30 s gateway restart stops at once on TERM, leaving nothing behind', async (t) => {
    const { home, lock, boot, out } = await setup(t, { CHARTER_BOOT_GATEWAY_SLEEP_S: '30' });
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    const first = boot();
    await sleep(3000);
    assert.match(out(), /boot: gateway exited \(3\), restarting in 30 s/);
    const loops = ['renew.pid'].map((f) => Number(readFileSync(join(lock, f), 'utf8').trim()));
    const started = Date.now();
    const stop = boot('stop');
    assert.equal(await stop.exited, 0);
    assert.ok(Date.now() - started < 5000, `stop took ${Date.now() - started} ms`);
    await first.exited;
    assert.ok(loops.every((pid) => !alive(pid)), 'the renew loop went with the boot');
    assert.equal(statSync(lock, { throwIfNoEntry: false }), undefined, 'the lock is released');
  });
});
