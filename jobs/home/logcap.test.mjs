import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const LOGCAP = join(dirname(fileURLToPath(import.meta.url)), 'logcap.sh');

function run(t, dir, env = {}) {
  const child = spawn('sh', [LOGCAP, dir], {
    env: { PATH: process.env.PATH, CHARTER_LOG_MAX_BYTES: '1000', CHARTER_LOG_CHECK_S: '1', ...env },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGKILL'));
  return child;
}

test('logcap: a log past the cap is kept as <log>.1 and emptied in place; one under it is left alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'charter-logcap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const big = 'x'.repeat(1500);
  writeFileSync(join(dir, 'renew.log'), big);
  writeFileSync(join(dir, 'payer.log'), 'small\n');
  writeFileSync(join(dir, 'notes.txt'), 'y'.repeat(5000));
  // The writer the box has: a process appending through its own descriptor, as `>> log` does.
  const fd = openSync(join(dir, 'renew.log'), 'a');
  t.after(() => closeSync(fd));
  run(t, dir);
  await sleep(1500);
  assert.equal(readFileSync(join(dir, 'renew.log.1'), 'utf8'), big);
  assert.equal(statSync(join(dir, 'renew.log')).size, 0);
  assert.equal(readFileSync(join(dir, 'payer.log'), 'utf8'), 'small\n');
  assert.equal(statSync(join(dir, 'notes.txt')).size, 5000, 'only *.log');
  assert.equal(statSync(join(dir, 'payer.log.1'), { throwIfNoEntry: false }), undefined);
  // An appending writer lands at the new end, not at its old offset: no hole of zeros.
  writeSync(fd, 'after\n');
  assert.equal(readFileSync(join(dir, 'renew.log'), 'utf8'), 'after\n');
});

test('logcap: keeps checking, and a second rotation replaces <log>.1, so a log holds at most twice the cap', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'charter-logcap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'boot.log'), 'a'.repeat(1200));
  run(t, dir);
  await sleep(1500);
  writeFileSync(join(dir, 'boot.log'), 'b'.repeat(1100), { flag: 'a' });
  await sleep(1500);
  assert.equal(readFileSync(join(dir, 'boot.log.1'), 'utf8'), 'b'.repeat(1100));
  assert.equal(statSync(join(dir, 'boot.log')).size, 0);
});

test('logcap: a missing directory is waited for, not an exit', async (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'charter-logcap-')), 'later');
  t.after(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const child = run(t, dir);
  const exited = new Promise((r) => child.on('exit', () => r('exited')));
  assert.equal(await Promise.race([exited, sleep(1500).then(() => 'running')]), 'running');
});
