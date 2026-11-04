import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_IMAGE, JOB_IMAGES, MAX_SCRIPT_BYTES, MAX_URLS, PYTHON_IMAGE, fetchJob, homeIdOf, homeJob, isScript, jobFromBody, normalizeSshKeys, pythonJob } from './jobs.js';

test('the job images are the only ones a renter can ask for', () => {
  assert.deepEqual(JOB_IMAGES, ['charter-job-fetch', 'charter-job-python', 'charter-home']);
  assert.deepEqual(fetchJob(['https://a.com', 'http://b.com/x?y=1']), { image: FETCH_IMAGE, args: { URLS: 'https://a.com,http://b.com/x?y=1' } });
  assert.deepEqual(pythonJob('print(1)'), { image: PYTHON_IMAGE, args: { SCRIPT: 'print(1)' } });
});

test('jobFromBody: { urls } is a fetch job of 1 to 5 http(s) URLs with no comma', () => {
  assert.deepEqual(jobFromBody({ urls: ['https://a.com'] }), fetchJob(['https://a.com']));
  const five = Array.from({ length: MAX_URLS }, (_, i) => `https://e${i}.com/`);
  assert.deepEqual(jobFromBody({ urls: five }), fetchJob(five));
  for (const [why, urls] of [
    ['empty', []],
    ['six', [...five, 'https://f.com']],
    ['not an array', 'https://a.com'],
    ['an object', { 0: 'https://a.com' }],
    ['ftp', ['ftp://a.com']],
    ['no scheme', ['a.com']],
    ['not a url', ['not a url']],
    ['a comma, which would split the job arg', ['https://a.com/x,y']],
    ['over 2000 chars', ['https://a.com/' + 'x'.repeat(2000)]],
    ['a number among them', ['https://a.com', 5]],
    ['null among them', ['https://a.com', null]],
    ['javascript', ['javascript:alert(1)']],
    ['data', ['data:text/html,hi']],
  ] as const) {
    assert.equal(jobFromBody({ urls }), null, why);
  }
});

test('jobFromBody: { python: { script } } is a python job of a non-blank script up to 8 KiB with no NUL', () => {
  assert.deepEqual(jobFromBody({ python: { script: 'print("hi")' } }), pythonJob('print("hi")'));
  const max = 'x'.repeat(MAX_SCRIPT_BYTES);
  assert.deepEqual(jobFromBody({ python: { script: max } }), pythonJob(max));
  for (const [why, python] of [
    ['blank', { script: '   \n' }],
    ['empty', { script: '' }],
    ['one byte over, counted in UTF-8', { script: 'é' + 'x'.repeat(MAX_SCRIPT_BYTES - 1) }],
    ['a NUL', { script: 'print(1)\0' }],
    ['not a string', { script: 5 }],
    ['no script', {}],
    ['python not an object', 'print(1)'],
    ['python null', null],
    ['python an array', [{ script: 'print(1)' }]],
  ] as const) {
    assert.equal(jobFromBody({ python: python as never }), null, why);
  }
  assert.equal(isScript('x'.repeat(MAX_SCRIPT_BYTES + 1)), false);
  assert.equal(isScript('ok'), true);
});

test('jobFromBody: neither or both job shapes is null, and other keys are ignored', () => {
  assert.equal(jobFromBody({}), null);
  assert.equal(jobFromBody({ urls: ['https://a.com'], python: { script: 'print(1)' } }), null, 'exactly one of the two');
  assert.equal(jobFromBody({ urls: undefined, python: undefined }), null);
  assert.deepEqual(jobFromBody({ urls: ['https://a.com'], python: undefined }), fetchJob(['https://a.com']));
  assert.deepEqual(jobFromBody({ offerId: 'x', urls: ['https://a.com'] } as { urls: string[] }), fetchJob(['https://a.com']));
  // A prototype-less or odd object is read by its own keys only.
  assert.equal(jobFromBody(Object.create(null) as Record<string, never>), null);
});

test('normalizeSshKeys: comment, order, CRLF and duplicates do not change the key set', () => {
  const a = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 edison@air\r\n';
  const b = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0' + 'A'.repeat(300) + '= x';
  const n1 = normalizeSshKeys([a, b, b]);
  const n2 = normalizeSshKeys([b.replace(' x', ''), a.trim()]);
  assert.deepEqual(n1, n2);
  assert.equal(n1!.length, 2);
  assert.equal(homeIdOf(n1!), homeIdOf(n2!));
  assert.match(homeIdOf(n1!), /^[0-9a-f]{16}$/);
});

test('normalizeSshKeys refuses what the box must not take', () => {
  const ok = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1';
  for (const [why, v] of [
    ['empty', []], ['nine', Array.from({ length: 9 }, (_, i) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ${i}`)],
    ['not an array', ok], ['a number', [5]], ['unknown type', ['ssh-dss AAAA']], ['a security-key type', ['sk-ssh-ed25519@openssh.com AAAAGnNr']],
    ['bad base64', ['ssh-ed25519 not*base64']], ['over 1024 bytes', ['ssh-rsa ' + 'A'.repeat(1100)]],
    ['a NUL', [ok + '\0']], ['a newline inside', ['ssh-ed25519 AAAA\nssh-ed25519 BBBB']],
  ] as const) assert.equal(normalizeSshKeys(v as unknown), null, why);
});

test('normalizeSshKeys takes ecdsa-sha2-nistp256', () => {
  const k = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=';
  assert.deepEqual(normalizeSshKeys([k + ' me']), [k]);
});

test('jobFromBody: { home: { sshKeys } } is a home job and excludes the other two', () => {
  const ok = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 c';
  assert.deepEqual(jobFromBody({ home: { sshKeys: [ok] } }), homeJob(normalizeSshKeys([ok])!));
  assert.equal(jobFromBody({ home: { sshKeys: [ok] }, urls: ['https://a.com'] }), null);
  assert.equal(jobFromBody({ home: { sshKeys: [] } }), null);
  assert.equal(jobFromBody({ home: 'x' }), null);
});
