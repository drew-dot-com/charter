import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshKeys, sshLine } from './keys.js';

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl you@host';
const EC = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=';

test('parseSshKeys accepts one key per line and names the bad line', () => {
  assert.deepEqual(parseSshKeys(`\n  ${ED}  \n\n${EC}\n`), [ED, EC], 'blank lines skipped, lines trimmed');
  assert.deepEqual(parseSshKeys('ssh-rsa AAAAB3NzaC1yc2E= a comment with spaces'), ['ssh-rsa AAAAB3NzaC1yc2E= a comment with spaces']);
  assert.equal(parseSshKeys(''), 'Paste at least one SSH public key.');
  assert.equal(parseSshKeys(' \n \n'), 'Paste at least one SSH public key.');
  assert.equal(parseSshKeys(Array(9).fill(ED).join('\n')), 'At most 8 keys.');
  assert.deepEqual(parseSshKeys(Array(8).fill(ED).join('\n')), Array(8).fill(ED));
  // The line number counts the lines as pasted, blank ones included.
  assert.equal(parseSshKeys(`${ED}\n\nssh-dss AAAAB3NzaC1kc3M=`), 'Line 3 is not an SSH public key.');
  assert.equal(parseSshKeys('-----BEGIN OPENSSH PRIVATE KEY-----'), 'Line 1 is not an SSH public key.');
  assert.equal(parseSshKeys('sk-ssh-ed25519@openssh.com AAAA'), 'Line 1 is not an SSH public key.');
  assert.equal(parseSshKeys(`ssh-ed25519 ${'A'.repeat(1024)}`), 'Line 1 is not an SSH public key.', 'over 1024 bytes');
  assert.equal(parseSshKeys('ssh-ed25519 AAAA you@hést'), 'Line 1 is not an SSH public key.', 'non-ASCII comment');
});

test('sshLine gives the exact line for a plain access and nothing for anything else', () => {
  const host = `${'a2'.repeat(28)}.anyone`;
  const ok = { ssh: { host, port: 22, user: 'tenant' } };
  assert.equal(sshLine(ok), `ssh -o ProxyCommand="nc -x 127.0.0.1:9050 %h %p" tenant@${host}`);
  for (const bad of [
    { ssh: { ...ok.ssh, host: 'a'.repeat(56) } },
    { ssh: { ...ok.ssh, host: `${'a'.repeat(55)}.anyone` } },
    { ssh: { ...ok.ssh, host: `${'a'.repeat(56)}.anyone; rm -rf ~` } },
    { ssh: { ...ok.ssh, user: 'ten ant' } },
    { ssh: { ...ok.ssh, user: 'root' } },
    { ssh: { ...ok.ssh, port: 22.5 } },
    { ssh: { ...ok.ssh, port: 2222 } },
    { ssh: { ...ok.ssh, port: '22' } },
    { ssh: null },
    {},
    null,
    undefined,
    'ssh tenant@x.anyone',
  ]) assert.equal(sshLine(bad), undefined, JSON.stringify(bad));
});
