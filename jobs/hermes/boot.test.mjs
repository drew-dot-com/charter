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
echo "hermes $* TOON_PAYER_URL=$TOON_PAYER_URL CHARTER_PAYER_URL=$CHARTER_PAYER_URL CHARTER_BIN=$CHARTER_BIN CHARTER_OFFER_ID=$CHARTER_OFFER_ID" >> "$STUB_LOG"
sleep 1
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
  let child;
  let out = '';
  const boot = () => {
    child = spawn('sh', [BOOT], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
  };
  t.after(() => {
    // The whole group: the payer stub and the renew loop run in the background of the script.
    if (child) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });
  return { home, stubLog, port, boot, log: () => readFileSync(stubLog, 'utf8'), out: () => out };
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
    assert.match(log(), /charter renew/);
  });

  test('boot-default: an offer with no hostPubkey gives --offer <id>', async (t) => {
    const { boot, log } = await setup(t, { id: 'o1', hostPubkey: '' });
    boot();
    await sleep(2500);
    assert.match(log(), /charter renew --offer o1 --lease abc --max-intervals 720 CHARTER_PAYER=url/);
  });
});
