import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFiles } from './files.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'social-files-'));

test('loadConfigFiles defaults when a file is absent', () => {
  const f = loadConfigFiles(tmp());
  assert.equal(f.factsMd, '');
  for (const w of ['token', 'airdrop', 'presale', 'guarantee', 'escape', 'jailbreak', 'unfenced', 'toon']) assert.ok(f.rules.banned.includes(w), w);
  assert.deepEqual(f.optins, { renters: {}, grants: {}, hosts: {} });
  assert.equal(f.blocklist.size, 0);
});

test('loadConfigFiles lowercases optin keys and strips a leading @ from handles', () => {
  const d = tmp();
  writeFileSync(join(d, 'optins.json'), JSON.stringify({
    renters: { '0xABCdef': { name: 'Ada', handle: '@Ada_X' } },
    grants: { 'G-1': { name: 'Grace' } },
    hosts: { 'Hel1': { name: 'Hel', handle: 'hel' } },
  }));
  writeFileSync(join(d, 'blocklist.json'), JSON.stringify(['@Spammer', 'Other']));
  writeFileSync(join(d, 'facts.md'), '# facts\n');
  writeFileSync(join(d, 'rules.json'), JSON.stringify({ banned: ['Foo'] }));
  const f = loadConfigFiles(d);
  assert.deepEqual(f.optins.renters, { '0xabcdef': { name: 'Ada', handle: 'Ada_X' } });
  assert.deepEqual(f.optins.grants, { 'g-1': { name: 'Grace' } });
  assert.deepEqual(f.optins.hosts, { hel1: { name: 'Hel', handle: 'hel' } });
  assert.deepEqual([...f.blocklist].sort(), ['other', 'spammer']);
  assert.equal(f.factsMd, '# facts\n');
  assert.ok(f.rules.banned.includes('foo'));
  assert.ok(f.rules.banned.includes('toon'), 'toon can never be removed');
});

test('loadConfigFiles throws on a malformed file rather than defaulting open', () => {
  const d = tmp();
  writeFileSync(join(d, 'blocklist.json'), '{nope');
  assert.throws(() => loadConfigFiles(d));
});
