import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const BOOT = join(dirname(fileURLToPath(import.meta.url)), 'boot-default.sh');
const HOST = 'f'.repeat(64);

// `charter payer` serves /health on CHARTER_PAYER_LISTEN; `charter renew` logs and fails, so the loop must retry.
const CHARTER_STUB = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'payer') {
  appendFileSync(process.env.STUB_LOG, 'charter ' + args.join(' ') + '\\n');
  require('node:fs').writeFileSync(process.env.STUB_LOG + '.payer-pid', String(process.pid));
  const [host, port] = process.env.CHARTER_PAYER_LISTEN.split(':');
  require('node:http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, payer: '0xabc' }));
  }).listen(Number(port), host);
} else {
  appendFileSync(process.env.STUB_LOG, 'charter ' + args.join(' ') + ' CHARTER_PAYER=' + process.env.CHARTER_PAYER + '\\n');
  process.exit(1);
}
`;
const HERMES_STUB = `#!/bin/sh
mkdir "$STUB_LOG.gateway" 2>/dev/null || echo "OVERLAP two gateways at once" >> "$STUB_LOG"
echo "hermes $* TOON_PAYER_URL=$TOON_PAYER_URL CHARTER_PAYER_URL=$CHARTER_PAYER_URL CHARTER_BIN=$CHARTER_BIN CHARTER_OFFER_ID=$CHARTER_OFFER_ID" >> "$STUB_LOG"
sleep 1
rmdir "$STUB_LOG.gateway" 2>/dev/null
exit 3
`;

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function setup(t, offer) {
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
  const port = await freePort();
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    // The lock lives in TMPDIR: one per test, so the tests can run side by side.
    TMPDIR: tmp,
    HOME: home,
    HERMES_HOME: join(home, '.hermes'),
    STUB_LOG: stubLog,
    CHARTER_LEASE_ID: 'abc',
    CHARTER_OFFER_JSON: JSON.stringify(offer),
    CHARTER_BOOT_PAYER_WAIT_S: '5',
    CHARTER_BOOT_RENEW_SLEEP_S: '1',
    CHARTER_BOOT_GATEWAY_SLEEP_S: '1',
    CHARTER_BOOT_ENV_POLL_S: '1',
    CHARTER_PAYER_LISTEN: `127.0.0.1:${port}`,
    CHARTER_PAYER_URL: `http://127.0.0.1:${port}`,
  };
  const children = [];
  let out = '';
  const boot = () => {
    const child = spawn('sh', [BOOT], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
    children.push(child);
    return child;
  };
  t.after(() => {
    // Each whole group: the payer stub and the renew loop run in the background of the script.
    for (const child of children) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });
  return { home, stubLog, port, boot, lock: join(tmp, 'charter-boot.lock'), log: () => readFileSync(stubLog, 'utf8'), out: () => out };
}

// Each test has its own home, port and stubs, so they run side by side.
describe('boot-default', { concurrency: true }, () => {
  test('boot-default: payer, address, renew, then the gateway once .env exists, restarted after it exits', async (t) => {
    const { home, port, boot, log, out } = await setup(t, { id: 'o1', hostPubkey: HOST, intervalSeconds: 3600 });
    boot();
    await sleep(4000);
    const key = join(home, '.charter', 'payer.key');
    assert.match(readFileSync(key, 'utf8'), /^[0-9a-f]{64}\n?$/);
    assert.equal(statSync(key).mode & 0o777, 0o400);
    assert.equal(readFileSync(join(home, '.charter', 'rpc-url'), 'utf8').trim(), 'https://mainnet.base.org');
    assert.equal(readFileSync(join(home, '.charter', 'payer.address'), 'utf8').trim(), '0xabc');
    assert.match(log(), /charter payer/);
    assert.match(log(), new RegExp(`charter renew --offer ${HOST}:o1 --lease abc --max-intervals 720 CHARTER_PAYER=url`));
    assert.ok(log().match(/charter renew/g).length >= 2, 'a failed renew is retried');
    assert.doesNotMatch(log(), /hermes gateway/, 'no gateway before .env');
    assert.match(out(), /boot: payer address 0xabc/);
    assert.match(out(), /boot: renew started/);
    assert.match(out(), /boot: waiting for ~\/\.hermes\/\.env/);

    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    await sleep(3000);
    assert.match(log(), /hermes gateway run/);
    assert.ok(log().match(/hermes gateway run/g).length >= 2, 'the gateway is restarted after it exits');
    assert.match(log(), new RegExp(`TOON_PAYER_URL=http://127.0.0.1:${port} CHARTER_PAYER_URL=http://127.0.0.1:${port} CHARTER_BIN=/usr/local/bin/charter CHARTER_OFFER_ID=${HOST}:o1`));
    assert.match(out(), /boot: gateway started/);
    assert.match(out(), /boot: gateway exited \(3\), restarting in 1 s/);
    assert.doesNotMatch(log(), /OVERLAP/);
  });

  test('boot-default: a second run while the first is alive exits, and a stopped boot can start again', async (t) => {
    const { home, boot, lock, log, out } = await setup(t, { id: 'o1', hostPubkey: HOST });
    mkdirSync(join(home, '.hermes'), { recursive: true });
    writeFileSync(join(home, '.hermes', '.env'), 'X=1\n');
    const first = boot();
    await sleep(1500);
    const second = boot();
    const ran = await Promise.race([second.exited, sleep(2000).then(() => 'still running')]);
    assert.equal(ran, 0, 'the second run must exit at once');
    assert.match(out(), new RegExp(`boot: already running \\(lock ${lock};`));
    await sleep(2500);
    assert.equal(log().match(/charter payer/g).length, 1, 'one payer');
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
    assert.equal(log().match(/charter payer/g).length, 1, 'the payer still answering is reused');
    assert.ok(out().match(/boot: gateway started/g).length > 1);
  });

  test('boot-default: boot.pid holds the running boot and goes with it; payer.pid is the payer it started', async (t) => {
    const { home, stubLog, boot } = await setup(t, { id: 'o1', hostPubkey: HOST });
    const child = boot();
    await sleep(2500);
    const pidFile = join(home, '.charter', 'boot.pid');
    assert.equal(readFileSync(pidFile, 'utf8').trim(), String(child.pid));
    assert.equal(readFileSync(join(home, '.charter', 'payer.pid'), 'utf8').trim(), readFileSync(`${stubLog}.payer-pid`, 'utf8').trim());
    process.kill(child.pid, 'SIGTERM');
    await child.exited;
    assert.equal(statSync(pidFile, { throwIfNoEntry: false }), undefined, 'boot.pid is removed when the boot stops');
  });

  test('boot-default: a payer already answering /health is reused, not started again', async (t) => {
    const { home, port, boot, log } = await setup(t, { id: 'o1', hostPubkey: HOST });
    const server = createServer((req, res) => res.end(JSON.stringify({ ok: true, payer: '0xdef' })));
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    t.after(() => server.close());
    boot();
    await sleep(2500);
    assert.equal(readFileSync(join(home, '.charter', 'payer.address'), 'utf8').trim(), '0xdef');
    assert.doesNotMatch(log(), /charter payer/);
    assert.equal(statSync(join(home, '.charter', 'payer.pid'), { throwIfNoEntry: false }), undefined, 'a reused payer gets no payer.pid');
    assert.match(log(), /charter renew/);
  });

  test('boot-default: an offer with no hostPubkey gives --offer <id>', async (t) => {
    const { boot, log } = await setup(t, { id: 'o1', hostPubkey: '' });
    boot();
    await sleep(2500);
    assert.match(log(), /charter renew --offer o1 --lease abc --max-intervals 720 CHARTER_PAYER=url/);
  });
});
