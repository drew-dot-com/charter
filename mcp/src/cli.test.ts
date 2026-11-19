import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli, USAGE, type CliIo } from './cli.js';
import type { Actions } from './server.js';

const ID = 'e'.repeat(32);

/** Actions that record what they were asked and answer with it. */
function io(files: Record<string, string> = {}, stdin = '') {
  const calls: unknown[][] = [];
  let made = 0;
  const rec =
    (name: string) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return { did: name };
    };
  const actions = {
    offers: rec('offers'),
    wallet: rec('wallet'),
    runPython: rec('runPython'),
    fetchPages: rec('fetchPages'),
    rentHome: rec('rentHome'),
    lease: rec('lease'),
    extend: rec('extend'),
  } as unknown as Actions;
  const i: CliIo = {
    actions: () => {
      made++;
      return actions;
    },
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: no such file, open '${p}'`);
      return files[p]!;
    },
    readStdin: async () => stdin,
  };
  return { i, calls, made: () => made };
}

test('each command calls its action with what was typed and prints one JSON document', async () => {
  const t = io({ 'job.py': 'print(1)', 'keys.pub': '# mine\nssh-ed25519 AAAA one\n\nssh-ed25519 BBBB two\n' }, 'print(2)');
  const run = async (...argv: string[]) => {
    const r = await cli(argv, t.i);
    assert.equal(r.code, 0, r.out);
    assert.doesNotThrow(() => JSON.parse(r.out));
  };
  await run('offers');
  await run('wallet');
  await run('run-python', 'job.py');
  await run('run-python', '-', '--wait', '120');
  await run('fetch', 'https://a.example', 'https://b.example', '--wait', '200');
  await run('rent-home', 'keys.pub');
  await run('rent-home', 'keys.pub', '--image', 'charter-hermes');
  await run('lease', ID);
  await run('extend', ID, '3');
  assert.deepEqual(t.calls, [
    ['offers'],
    ['wallet'],
    ['runPython', 'print(1)', undefined],
    ['runPython', 'print(2)', 120],
    ['fetchPages', ['https://a.example', 'https://b.example'], 200],
    ['rentHome', ['ssh-ed25519 AAAA one', 'ssh-ed25519 BBBB two'], undefined],
    ['rentHome', ['ssh-ed25519 AAAA one', 'ssh-ed25519 BBBB two'], 'charter-hermes'],
    ['lease', ID],
    ['extend', ID, 3],
  ]);
});

test('a command typed wrong is refused with exit 2 before any action runs', async () => {
  const t = io({ 'job.py': 'x' });
  for (const argv of [
    [],
    ['rent'],
    ['offers', '--wait', '10'],
    ['run-python'],
    ['run-python', 'job.py', 'extra.py'],
    ['run-python', 'job.py', '--wait'],
    ['run-python', 'job.py', '--wait', 'soon'],
    ['run-python', 'job.py', '--pay', 'more'],
    ['fetch'],
    ['rent-home'],
    ['lease'],
    ['extend', ID],
    ['extend', ID, 'many'],
    ['extend', ID, '1.5'],
  ]) {
    const r = await cli(argv, t.i);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(JSON.parse(r.out).error, /charter-mcp --help/);
  }
  assert.deepEqual(t.calls, []);
});

test('a failure in an action is one JSON error and exit 1', async () => {
  const t = io();
  (t.i.actions() as unknown as Record<string, unknown>).lease = async () => {
    throw new Error('the door does not know this lease');
  };
  const r = await cli(['lease', ID], t.i);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out), { error: 'the door does not know this lease' });
  const missing = await cli(['run-python', 'nope.py'], io().i);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.out).error, /ENOENT/);
});

test('the usage text marks every paid command and has no em dash', () => {
  for (const line of USAGE.split('\n')) {
    const paid = /charter-mcp (run-python|fetch|rent-home|extend) /.test(line);
    if (paid) assert.match(line + USAGE, /PAID/);
  }
  assert.equal((USAGE.match(/PAID/g) ?? []).length, 4);
  assert.ok(!USAGE.includes(String.fromCharCode(0x2014)));
});
