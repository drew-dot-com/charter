import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { buildReceipt, canonicalCid, declaredBody, isCid, leaseRefOf, messageOf, RECEIPT_PREFIX, signReceipt, verifyReceipt } from './receipts.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const LEASE = 'ab'.repeat(16);
const SHA = 'cd'.repeat(32);
const HOST = 'ef'.repeat(32);
const CID0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const CID1 = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const CID1_HEX = 'f01551220c7d01489080858c500065836c658f847a6ca67c4864619212be4f8200e4bbace';
const DAG_PB = 'bafybeibnoelefnzgwbcacyt4vh52ymxvzbjq7mmqhtcnwarfq4lzegsiqe';

const bare = () => buildReceipt({ kind: 'declared', door: 'https://charterhome.dev', leaseRef: leaseRefOf(LEASE), hostId: HOST, ticksPaid: 2, intervalSeconds: 3600, sha256: SHA, at: 1795000000000 });

test('the message is the prefix and the receipt as one line, keys in the fixed order', () => {
  assert.equal(RECEIPT_PREFIX, 'Charter receipt v1\n');
  assert.equal(
    messageOf(bare()),
    `Charter receipt v1\n{"v":1,"kind":"declared","door":"https://charterhome.dev","leaseRef":"${leaseRefOf(LEASE)}","hostId":"${HOST}","ticksPaid":2,"intervalSeconds":3600,"sha256":"${SHA}","at":1795000000000}`,
  );
});

test('optional fields take their fixed places however the caller ordered them', () => {
  const r = buildReceipt({ at: 5, cid: CID1, bytes: 7, sha256: SHA, payer: '0xabc', intervalSeconds: 60, ticksPaid: 1, image: 'charter-python', hostId: HOST, leaseRef: 'r', door: 'd', kind: 'job' });
  assert.deepEqual(Object.keys(r), ['v', 'kind', 'door', 'leaseRef', 'hostId', 'image', 'ticksPaid', 'intervalSeconds', 'payer', 'sha256', 'bytes', 'cid', 'at']);
  assert.equal(messageOf(r), `Charter receipt v1\n{"v":1,"kind":"job","door":"d","leaseRef":"r","hostId":"${HOST}","image":"charter-python","ticksPaid":1,"intervalSeconds":60,"payer":"0xabc","sha256":"${SHA}","bytes":7,"cid":"${CID1}","at":5}`);
});

test('an undefined optional is left out, not written as null', () => {
  const r = buildReceipt({ kind: 'job', door: 'd', leaseRef: 'r', hostId: HOST, image: undefined, ticksPaid: 1, intervalSeconds: 60, payer: undefined, sha256: SHA, bytes: 0, at: 5 });
  assert.deepEqual(Object.keys(r), ['v', 'kind', 'door', 'leaseRef', 'hostId', 'ticksPaid', 'intervalSeconds', 'sha256', 'bytes', 'at']);
});

test('a lease reference is 64 hex, stable, and never holds the lease id', () => {
  const ref = leaseRefOf(LEASE);
  assert.match(ref, /^[0-9a-f]{64}$/);
  assert.equal(leaseRefOf(LEASE), ref);
  assert.notEqual(ref, LEASE);
  assert.ok(!ref.includes(LEASE));
  assert.notEqual(leaseRefOf('ac'.repeat(16)), ref);
});

test('a signed receipt verifies, and any tampering fails', async () => {
  const s = await signReceipt(bare(), ACCOUNT);
  assert.equal(s.signer, ACCOUNT.address);
  assert.equal(s.message, messageOf(s.receipt));
  assert.equal(await verifyReceipt(s), true);
  assert.equal(await verifyReceipt({ ...s, receipt: { ...s.receipt, sha256: 'ee'.repeat(32) } }), false);
  assert.equal(await verifyReceipt({ ...s, message: s.message.replace(SHA, 'ee'.repeat(32)) }), false);
  assert.equal(await verifyReceipt({ ...s, signer: privateKeyToAccount(`0x${'22'.repeat(32)}`).address }), false);
  assert.equal(await verifyReceipt({ ...s, message: s.message.slice(RECEIPT_PREFIX.length) }), false);
  assert.equal(await verifyReceipt({ ...s, signature: '0x1234' }), false);
});

test('a declared body is exactly a hash, and optionally a CID and a size', () => {
  assert.deepEqual(declaredBody({ sha256: SHA }), { sha256: SHA });
  assert.deepEqual(declaredBody({ sha256: SHA, cid: CID1, bytes: 12 }), { sha256: SHA, cid: CID1_HEX, bytes: 12 });
  assert.deepEqual(declaredBody({ sha256: SHA, bytes: 0 }), { sha256: SHA, bytes: 0 });
  for (const bad of [
    { sha256: SHA, name: 'x' },
    { sha256: SHA.toUpperCase() },
    { sha256: SHA.slice(1) },
    { sha256: SHA, bytes: -1 },
    { sha256: SHA, bytes: 1.5 },
    { sha256: SHA, bytes: '12' },
    { sha256: SHA, cid: 'hello world' },
    { sha256: SHA, cid: 7 },
    { cid: CID1 },
    {},
    [SHA],
    null,
    'x',
    undefined,
  ]) {
    assert.equal(declaredBody(bad), null, JSON.stringify(bad));
  }
});

test('a CID is a v0 or a base32 v1, nothing else', () => {
  assert.equal(isCid(CID0), true);
  assert.equal(isCid(CID1), true);
  assert.equal(isCid(CID0.slice(0, -1)), false);
  assert.equal(isCid(CID1.toUpperCase()), false);
  assert.equal(isCid(`https://gateway.pinata.cloud/ipfs/${CID1}`), false);
  assert.equal(isCid(`${CID1} buy now`), false);
  assert.equal(isCid('b' + 'a'.repeat(57)), false);
  assert.equal(isCid('b' + 'a'.repeat(59)), false);
  assert.equal(isCid(''), false);
  assert.equal(isCid(undefined), false);
});

test('a CID is signed in base16, so no CID can carry words the caller chose', () => {
  assert.equal(canonicalCid(CID1), CID1_HEX);
  assert.equal(canonicalCid(CID1_HEX), CID1_HEX);
  assert.equal(canonicalCid(DAG_PB), 'f017012202d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  // A v0 CID is the same object as a v1 dag-pb CID over the same digest.
  assert.equal(canonicalCid(CID0), 'f017012209d6c2be50f706953479ab9df2ce3edca90b68053c00b3004b7f0accbe1e8eedf');
  // 59 lower-case letters that spell a sentence have the shape of a base32 CID and are not one.
  const words = 'b' + 'thisdoorcertifiesthattheoutputwasverifiedcorrectbycharterx';
  assert.equal(words.length, 59);
  assert.equal(canonicalCid(words), null);
  assert.equal(declaredBody({ sha256: SHA, cid: words }), null);
  // Whatever a caller sends, what is signed is `f`, a fixed header and hex.
  for (const c of [CID0, CID1, DAG_PB]) assert.match(canonicalCid(c)!, /^f01(55|70)1220[0-9a-f]{64}$/);
  // Not sha2-256, not raw or dag-pb, wrong length, or upper case: refused.
  assert.equal(canonicalCid('f01551320' + 'ab'.repeat(32)), null);
  assert.equal(canonicalCid('f01711220' + 'ab'.repeat(32)), null);
  assert.equal(canonicalCid('f01551220' + 'ab'.repeat(31)), null);
  assert.equal(canonicalCid(CID1_HEX.toUpperCase()), null);
  assert.equal(canonicalCid('Qm' + 'z'.repeat(44)), null);
  assert.equal(canonicalCid(7), null);
});
