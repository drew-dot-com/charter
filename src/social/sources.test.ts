import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSources } from './sources.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'social-src-'));
const lease = { leaseId: 'L1', payer: '0xabc', ticksPaidByRenter: 2, losses: '0', createdAt: 1 };

test('readSources reads all four files', () => {
  const d = dir();
  writeFileSync(join(d, 'door-ledger.json'), JSON.stringify([lease]));
  writeFileSync(join(d, 'tick-txs.jsonl'), JSON.stringify({ leaseId: 'L1', tick: 1, tx: '0x1', at: 5 }) + '\n');
  writeFileSync(join(d, 'grants.jsonl'),
    JSON.stringify({ grantId: 'G1', state: 'queued' }) + '\n' + JSON.stringify({ grantId: 'G1', state: 'active' }) + '\n');
  writeFileSync(join(d, 'hosts.json'), JSON.stringify({ hosts: [{ hostId: 'h1', probes: { passed: 1 } }], homes: {} }));
  const s = readSources(d);
  assert.ok(!('error' in s));
  assert.equal(s.leases.length, 1);
  assert.equal(s.tickTxs.length, 1);
  assert.equal(s.grants.length, 1);
  assert.equal(s.grants[0]!.state, 'active');
  assert.equal(s.hosts[0]!.hostId, 'h1');
});

test('readSources returns { error } on truncated ledger JSON', () => {
  const d = dir();
  writeFileSync(join(d, 'door-ledger.json'), '[{"leaseId":"L1","pay');
  assert.ok('error' in readSources(d));
});

test('readSources returns { error } on a missing ledger file', () => {
  assert.ok('error' in readSources(dir()));
});

test('readSources tolerates a missing tick-txs.jsonl, grants.jsonl or hosts.json', () => {
  const d = dir();
  writeFileSync(join(d, 'door-ledger.json'), '[]');
  const s = readSources(d);
  assert.ok(!('error' in s));
  assert.deepEqual([s.leases, s.grants, s.hosts, s.tickTxs], [[], [], [], []]);
});

test('readSources skips malformed jsonl lines', () => {
  const d = dir();
  writeFileSync(join(d, 'door-ledger.json'), '[]');
  writeFileSync(join(d, 'grants.jsonl'), 'not json\n' + JSON.stringify({ grantId: 'G1', state: 'active' }) + '\n{"grantId":"G2","sta');
  writeFileSync(join(d, 'tick-txs.jsonl'), '{bad\n' + JSON.stringify({ leaseId: 'L', tick: 1, tx: 't', at: 1 }) + '\n');
  const s = readSources(d);
  assert.ok(!('error' in s));
  assert.deepEqual(s.grants.map((g) => g.grantId), ['G1']);
  assert.equal(s.tickTxs.length, 1);
});

test('readSources reads the opt-in code hashes and skips anything else on those lines', () => {
  const d = dir();
  writeFileSync(join(d, 'door-ledger.json'), '[]');
  assert.deepEqual((readSources(d) as { optinCodes: unknown[] }).optinCodes, []);
  writeFileSync(join(d, 'optin-codes.jsonl'), [JSON.stringify({ kind: 'lease', id: 'L1', hash: 'h1' }), '{torn', JSON.stringify({ kind: 'host', id: 'x', hash: 'h' }), JSON.stringify({ kind: 'grant', id: 'G1', hash: 'h2' })].join('\n'));
  assert.deepEqual((readSources(d) as { optinCodes: unknown[] }).optinCodes, [{ kind: 'lease', id: 'L1', hash: 'h1' }, { kind: 'grant', id: 'G1', hash: 'h2' }]);
});
