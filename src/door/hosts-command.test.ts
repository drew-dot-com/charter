import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS_FILE, HostRegistry } from './hosts.js';
import { hostsCommand } from './hosts-command.js';

test('charter-door hosts drop <hostId> drops a host in the data dir registry; a running door sees it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosts-cmd-'));
  const reg = new HostRegistry(join(dir, HOSTS_FILE));
  const { hostId } = reg.register('https://a.example', 1) as { hostId: string };
  reg.probeResult(hostId, true, 2);
  const lines: string[] = [];
  assert.equal(hostsCommand(['drop', hostId], { CHARTER_DATA_DIR: dir }, () => 3, (m) => lines.push(m)), 0);
  assert.match(lines.join('\n'), /dropped/);
  assert.equal(reg.get(hostId)!.state, 'dropped');
  assert.equal(new HostRegistry(join(dir, HOSTS_FILE)).get(hostId)!.state, 'dropped');
});

test('hosts drop refuses bad input and an unknown host, and creates nothing without a registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hosts-cmd-'));
  const lines: string[] = [];
  const out = (m: string) => void lines.push(m);
  assert.equal(hostsCommand(['drop', 'nope'], { CHARTER_DATA_DIR: dir }, () => 1, out), 2);
  assert.equal(hostsCommand(['list'], { CHARTER_DATA_DIR: dir }, () => 1, out), 2);
  assert.equal(hostsCommand(['drop', 'ab'.repeat(32)], {}, () => 1, out), 2);
  assert.equal(hostsCommand(['drop', 'ab'.repeat(32)], { CHARTER_DATA_DIR: dir }, () => 1, out), 1);
  assert.deepEqual(readdirSync(dir), []);
  new HostRegistry(join(dir, HOSTS_FILE)).register('https://a.example', 1);
  assert.equal(hostsCommand(['drop', 'ab'.repeat(32)], { CHARTER_DATA_DIR: dir }, () => 1, out), 1);
  assert.match(lines.join('\n'), /no host/);
});
