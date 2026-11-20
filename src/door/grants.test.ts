import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadMove, GrantStore, ownerView, publicView, validatePitch } from './grants.js';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@host';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const good = () => ({ name: 'Ada', pitch: 'I run a small agent that needs a home.', sshKeys: [KEY], image: 'charter-home' });

function store(now = { t: 1_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'));
  const file = join(dir, 'sub', 'grants.jsonl');
  return { file, now, s: new GrantStore(file, () => now.t) };
}
function pitch(body: unknown) {
  const v = validatePitch(body);
  assert.equal(v.ok, true);
  return (v as Extract<typeof v, { ok: true }>).pitch;
}

test('validatePitch accepts a minimal pitch', () => {
  const v = validatePitch(good());
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.pitch.name, 'Ada');
    assert.equal(v.pitch.image, 'charter-home');
    assert.deepEqual(v.pitch.sshKeys, [KEY.split(' ').slice(0, 2).join(' ')]);
    assert.equal(v.pitch.link, undefined);
  }
});

test('validatePitch refuses a 2001-character pitch', () => {
  assert.equal(validatePitch({ ...good(), pitch: 'x'.repeat(2001) }).ok, false);
  assert.equal(validatePitch({ ...good(), pitch: 'x'.repeat(2000) }).ok, true);
});

test('validatePitch refuses a link that is not https', () => {
  assert.equal(validatePitch({ ...good(), link: 'http://example.com' }).ok, false);
  assert.equal(validatePitch({ ...good(), link: 'javascript:alert(1)' }).ok, false);
  assert.equal(validatePitch({ ...good(), link: 'https://example.com/' + 'a'.repeat(200) }).ok, false);
  assert.equal(validatePitch({ ...good(), link: 'https://example.com/a' }).ok, true);
});

test('validatePitch refuses nine keys', () => {
  const keys = Array.from({ length: 9 }, (_, i) => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(i).repeat(5)}`);
  assert.equal(validatePitch({ ...good(), sshKeys: keys }).ok, false);
  assert.equal(validatePitch({ ...good(), sshKeys: [] }).ok, false);
});

test('validatePitch refuses an unknown image', () => {
  assert.equal(validatePitch({ ...good(), image: 'ubuntu' }).ok, false);
  assert.equal(validatePitch({ ...good(), image: 'charter-hermes' }).ok, true);
});

test('validatePitch defaults a missing image to charter-home', () => {
  const { image: _i, ...noImage } = good();
  const v = validatePitch(noImage);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.pitch.image, 'charter-home');
  assert.equal(validatePitch({ ...good(), image: null }).ok, false, 'null is not a missing image');
});

test('validatePitch refuses text that is not well-formed (a lone surrogate)', () => {
  for (const k of ['name', 'pitch']) {
    const v = validatePitch({ ...good(), [k]: 'ok \uD800 then' });
    assert.equal(v.ok, false, k);
    if (!v.ok) assert.match(v.error, /well-formed/);
  }
  assert.equal(validatePitch({ ...good(), link: 'https://example.com/\uDC00' }).ok, false);
  assert.equal(validatePitch({ ...good(), pitch: 'a pair is fine: \uD83D\uDE00' }).ok, true);
});

test('validatePitch refuses a private key line', () => {
  assert.equal(validatePitch({ ...good(), sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----'] }).ok, false);
});

test('validatePitch refuses a bad name and a non-object', () => {
  assert.equal(validatePitch({ ...good(), name: '' }).ok, false);
  assert.equal(validatePitch({ ...good(), name: 'n'.repeat(81) }).ok, false);
  assert.equal(validatePitch(null).ok, false);
  assert.equal(validatePitch('x').ok, false);
});

test('add then reload from file returns the same grant', () => {
  const { s, file, now } = store();
  const g = s.add(pitch(good()), 'tok');
  assert.match(g.grantId, /^[0-9a-f]{32}$/);
  assert.equal(g.state, 'queued');
  assert.equal(g.createdAt, 1_000);
  assert.equal(g.updatedAt, 1_000);
  assert.notEqual(g.tokenHash, 'tok');
  assert.match(g.tokenHash, /^[0-9a-f]{64}$/);
  now.t = 2_000;
  s.update(g.grantId, { summary: 'ok' });
  const again = new GrantStore(file, () => 3_000);
  assert.deepEqual(again.get(g.grantId), s.get(g.grantId));
  assert.equal(again.all().length, 1);
  assert.equal(again.get(g.grantId)?.updatedAt, 2_000);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('update refuses a move not in ALLOWED_MOVES', () => {
  const { s } = store();
  const g = s.add(pitch(good()), 'tok');
  assert.throws(() => s.update(g.grantId, { state: 'active' }), BadMove);
  assert.equal(s.get(g.grantId)?.state, 'queued');
  s.update(g.grantId, { state: 'declined' });
  assert.throws(() => s.update(g.grantId, { state: 'approved_waiting' }), BadMove);
  const h = s.add(pitch(good()), 'tok2');
  s.update(h.grantId, { state: 'approved_waiting' });
  s.update(h.grantId, { state: 'active', leaseId: 'a'.repeat(32) });
  s.update(h.grantId, { leaseId: 'b'.repeat(32) });
  s.update(h.grantId, { state: 'completed' });
  assert.equal(s.update(h.grantId, { renewedByGrantee: true }).renewedByGrantee, true);
  assert.throws(() => s.update(h.grantId, { state: 'active' }), BadMove);
  const k = s.add(pitch(good()), 'tok3');
  s.update(k.grantId, { state: 'approved_waiting' });
  assert.equal(s.update(k.grantId, { state: 'ended_early' }).state, 'ended_early');
  assert.throws(() => s.update('nope', { summary: 'x' }));
});

test('homeIdGranted is true once any grant on that homeId left queued for approved_waiting', () => {
  const { s } = store();
  const p = pitch(good());
  const g = s.add(p, 'a');
  assert.equal(s.homeIdGranted(g.homeId), false);
  const d = s.add(p, 'b');
  s.update(d.grantId, { state: 'declined' });
  assert.equal(s.homeIdGranted(g.homeId), false);
  s.update(g.grantId, { state: 'approved_waiting' });
  assert.equal(s.homeIdGranted(g.homeId), true);
  s.update(g.grantId, { state: 'stopped' });
  assert.equal(s.homeIdGranted(g.homeId), true);
  assert.equal(s.homeIdGranted('0'.repeat(16)), false);
});

test('queued lists only queued grants', () => {
  const { s } = store();
  const a = s.add(pitch(good()), 'a');
  const b = s.add(pitch({ ...good(), sshKeys: [KEY2] }), 'b');
  s.update(a.grantId, { state: 'declined' });
  assert.deepEqual(s.queued().map((g) => g.grantId), [b.grantId]);
});

test('a torn last line is ended at load, so the next record survives the following load', () => {
  const { s, file, now } = store();
  const a = s.add(pitch(good()), 'a');
  appendFileSync(file, '{"grantId":"torn","sta'); // a crash mid-write
  const s2 = new GrantStore(file, () => now.t);
  assert.equal(s2.get('torn'), undefined);
  const b = s2.add(pitch({ ...good(), sshKeys: [KEY2] }), 'b');
  const s3 = new GrantStore(file, () => now.t);
  assert.ok(s3.get(a.grantId));
  assert.ok(s3.get(b.grantId), 'the record written after the torn line is kept');
});

test('a line that parses but is not a grant is skipped at load', () => {
  const { s, file, now } = store();
  const a = s.add(pitch(good()), 'a');
  appendFileSync(file, '42\nnull\n{"state":"queued"}\n');
  const s2 = new GrantStore(file, () => now.t);
  assert.deepEqual(s2.all().map((g) => g.grantId), [a.grantId]);
});

test('publicView has no pitch, keys or full leaseId', () => {
  const { s } = store();
  const g = s.add(pitch(good()), 'tok');
  const a = s.update(g.grantId, { state: 'approved_waiting' });
  const act = s.update(a.grantId, { state: 'active', leaseId: 'abcdef0123456789abcdef0123456789' });
  const pub = publicView(act) as Record<string, unknown>;
  assert.equal(pub.pitch, undefined);
  assert.equal(pub.sshKeys, undefined);
  assert.equal(pub.homeId, undefined, 'homeId links a grant to a key set');
  assert.equal(pub.tokenHash, undefined);
  assert.equal(pub.leaseId, 'abcdef01');
  assert.equal(pub.grantId, act.grantId);
  const own = ownerView(act) as Record<string, unknown>;
  assert.equal(own.leaseId, 'abcdef0123456789abcdef0123456789');
  assert.equal(own.pitch, undefined);
  assert.equal(own.tokenHash, undefined);
  assert.equal(own.sshKeys, undefined);
});

test('tokenOk is false for a wrong token', () => {
  const { s } = store();
  const g = s.add(pitch(good()), 'right');
  assert.equal(s.tokenOk(g.grantId, 'right'), true);
  assert.equal(s.tokenOk(g.grantId, 'wrong'), false);
  assert.equal(s.tokenOk('missing', 'right'), false);
});

test('dropOldPitches removes pitch text older than 30 days and keeps summary and reason', () => {
  const { s, file, now } = store();
  const old = s.add(pitch(good()), 'a');
  s.update(old.grantId, { summary: 'sum', reason: 'why' });
  now.t = 1_000 + 31 * 86_400_000;
  const fresh = s.add(pitch({ ...good(), sshKeys: [KEY2] }), 'b');
  s.dropOldPitches();
  assert.equal(s.get(old.grantId)?.pitch, undefined);
  assert.equal(s.get(old.grantId)?.summary, 'sum');
  assert.equal(s.get(old.grantId)?.reason, 'why');
  assert.ok(s.get(fresh.grantId)?.pitch);
  assert.equal(readFileSync(file, 'utf8').split('small agent').length - 1, 1); // the fresh one only
  const again = new GrantStore(file, () => now.t);
  assert.equal(again.get(old.grantId)?.pitch, undefined);
  assert.equal(again.get(old.grantId)?.reason, 'why');
  assert.ok(again.get(fresh.grantId)?.pitch);
});
