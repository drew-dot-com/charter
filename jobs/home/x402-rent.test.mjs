import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, BASE_USDC, onlyDoorExact, renewLoop } from './x402-rent.mjs';

const LEASE = 'a'.repeat(32);
const HOUR = 3_600_000;
const PAYEE = '0xbD87000000000000000000000000000000000001';

/** A door with one running lease, and a clock that only `sleep` moves. */
function world({ paidIntervals = 1, state = 'running', minutesLeft = 60, payAnswers = [] } = {}) {
  const w = { t: 1_000_000_000_000, lease: { state, paidIntervals, paidThrough: 0 }, ticks: [], logs: [], slept: [], reads: 0 };
  w.lease.paidThrough = w.t + minutesLeft * 60_000;
  w.deps = {
    now: () => w.t,
    sleep: async (ms) => {
      w.slept.push(ms);
      w.t += ms;
    },
    log: (l) => w.logs.push(l),
    get: async () => {
      w.reads++;
      return { status: 200, body: { lease: { ...w.lease }, stopped: false, offer: { intervalSeconds: 3600 } } };
    },
    pay: async (path, json) => {
      const scripted = payAnswers.shift();
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      w.ticks.push({ path, index: json.index, at: w.t });
      w.lease.state = 'running';
      w.lease.paidIntervals = json.index + 1;
      w.lease.paidThrough = Math.max(w.lease.paidThrough, w.t) + HOUR;
      return { status: 200, body: { paidIntervals: w.lease.paidIntervals, paidThrough: w.lease.paidThrough }, tx: '0xabc' };
    },
  };
  return w;
}

test('renew waits for half an interval before the paid time ends, then pays the next index each hour', async () => {
  const w = world({ paidIntervals: 1, minutesLeft: 60 });
  const start = w.t;
  const why = await renewLoop({ leaseId: LEASE, maxIntervals: 3 }, w.deps);
  assert.equal(why, 'max');
  assert.deepEqual(w.ticks.map((x) => x.index), [1, 2, 3]);
  assert.equal(w.ticks[0].path, `/v1/leases/${LEASE}/ticks`);
  // 30 minutes before the first hour ends, then an hour apart.
  assert.deepEqual(w.ticks.map((x) => (x.at - start) / 60_000), [30, 90, 150]);
  // Never one sleep longer than ten minutes: the paid time is read again in between.
  assert.ok(w.slept.every((ms) => ms <= 10 * 60_000));
});

test('renew pays at once when the tick is already due, and --once stops after one', async () => {
  const w = world({ paidIntervals: 4, minutesLeft: 12 });
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [4]);
  assert.deepEqual(w.slept, []);
});

test('renew pays index 0 on a lease still waiting for its first tick', async () => {
  const w = world({ paidIntervals: 0, state: 'awaiting_first_tick', minutesLeft: 0 });
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [0]);
});

test('renew trusts the box clock file when it is ahead of the door: a tick paid elsewhere is not paid twice', async () => {
  const w = world({ paidIntervals: 2, minutesLeft: 10 });
  // The host counted a tick the door's cached read has not shown yet.
  const ahead = w.t + 70 * 60_000;
  w.deps.paidThroughFile = () => ahead;
  const sleep = w.deps.sleep;
  w.deps.sleep = async (ms) => {
    await sleep(ms);
    w.lease.paidIntervals = 3;
    w.lease.paidThrough = ahead;
  };
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [3]);
  assert.ok(w.slept.length > 0, 'it waited instead of paying index 2 again');
});

test('renew stops when the lease is over, the door does not know it, or the wallet is blocked', async () => {
  const closed = world({ state: 'closed' });
  closed.lease.closedReason = 'missed_tick';
  assert.equal(await renewLoop({ leaseId: LEASE }, closed.deps), 'over');
  assert.match(closed.logs.join('\n'), /missed_tick/);

  const unknown = world();
  unknown.deps.get = async () => ({ status: 404, body: { error: 'not_found' } });
  assert.equal(await renewLoop({ leaseId: LEASE }, unknown.deps), 'unknown');

  const blocked = world({ minutesLeft: 5, payAnswers: [{ status: 403, body: { error: 'payer_blocked' } }] });
  assert.equal(await renewLoop({ leaseId: LEASE }, blocked.deps), 'blocked');

  const done = world({ minutesLeft: 5, payAnswers: [{ status: 409, body: { error: 'not_running' } }] });
  assert.equal(await renewLoop({ leaseId: LEASE }, done.deps), 'over');
});

test('renew retries a refused or failed tick with a growing wait, says how much paid time is left, and pays when it can', async () => {
  const w = world({
    paidIntervals: 1,
    minutesLeft: 20,
    payAnswers: [{ status: 402, body: {}, reason: 'insufficient_funds' }, new Error('no payment requirements left'), { status: 503, body: { error: 'retry_later' } }],
  });
  assert.equal(await renewLoop({ leaseId: LEASE, once: true }, w.deps), 'once');
  assert.deepEqual(w.ticks.map((x) => x.index), [1]);
  assert.deepEqual(w.slept, [60_000, 120_000, 240_000]);
  const text = w.logs.join('\n');
  assert.match(text, /payment refused \(insufficient_funds\): does the wallet hold USDC on Base\?; 20 min of paid time left/);
  assert.match(text, /retry_later/);
});

test('the payment policy signs only exact USDC on Base to the door payee, at or under the cap', () => {
  const ok = { scheme: 'exact', network: BASE, asset: BASE_USDC, payTo: PAYEE, amount: '7000' };
  const policy = onlyDoorExact(PAYEE.toLowerCase(), 10000n);
  const kept = policy(2, [
    { ...ok, scheme: 'batch-settlement' },
    ok,
    { ...ok, amount: '10001' },
    { ...ok, payTo: '0x0000000000000000000000000000000000000bad' },
    { ...ok, network: 'eip155:1' },
    { ...ok, asset: '0x0000000000000000000000000000000000000001' },
    { ...ok, amount: '7e3' },
  ]);
  assert.deepEqual(kept, [ok]);
});

// ---- receipt and pin ----

import { mkdtempSync, mkdirSync as mkdir, readFileSync as readFile, statSync, writeFileSync as writeFile } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareReceipt, fileToPin, onlyPinataExact, pinFile, pinPrice, PINATA_402 } from './x402-rent.mjs';

const PINATA_PAYEE = '0xc900f41481B4F7C612AF9Ce3B1d16A7A1B6bd96E';
const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const offer = (over = {}) => ({ scheme: 'exact', network: BASE, amount: '1200', asset: BASE_USDC, payTo: PINATA_PAYEE, ...over });
const header = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString('base64');
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('fileToPin hashes a regular file, and refuses a directory, a missing path and an empty file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  writeFile(join(dir, 'a.txt'), 'hello');
  writeFile(join(dir, 'empty'), '');
  const f = fileToPin(join(dir, 'a.txt'));
  assert.equal(f.bytes.toString(), 'hello');
  assert.equal(f.sha256, createHash('sha256').update('hello').digest('hex'));
  assert.throws(() => fileToPin(dir), /not a regular file/);
  assert.throws(() => fileToPin(join(dir, 'nope')), /no file at/);
  assert.throws(() => fileToPin(join(dir, 'empty')), /empty/);
  assert.throws(() => fileToPin(undefined), /needs a file/);
});

test('pinPrice reads the exact USDC-on-Base price, and refuses any other offer', () => {
  assert.deepEqual(pinPrice(header([offer()])), { amount: 1200n, payTo: PINATA_PAYEE });
  assert.deepEqual(pinPrice(header([offer({ network: 'eip155:1' }), offer({ amount: '5' })])), { amount: 5n, payTo: PINATA_PAYEE });
  for (const bad of [offer({ asset: '0x' + '1'.repeat(40) }), offer({ network: 'eip155:1' }), offer({ scheme: 'upto' }), offer({ amount: '1.5' }), offer({ payTo: 'pinata' })]) {
    assert.throws(() => pinPrice(header([bad])), /no exact USDC price on Base/, JSON.stringify(bad));
  }
  assert.throws(() => pinPrice(null), /no price/);
  assert.throws(() => pinPrice('not base64 json'), /no price/);
});

test('the pin policy signs only exact USDC on Base to the quoted payee, at or under the cap', () => {
  const policy = onlyPinataExact(PINATA_PAYEE, 10_000n);
  const all = [offer(), offer({ amount: '10001' }), offer({ payTo: '0x' + '9'.repeat(40) }), offer({ scheme: 'upto' }), offer({ network: 'eip155:1' }), offer({ asset: '0x' + '1'.repeat(40) })];
  assert.deepEqual(policy(2, all), [offer()]);
});

/** Pinata's door and upload host, scripted. `paid` answers the paid POST. */
function pinata({ price = '1200', paid = () => json(200, { url: 'https://uploads.example/signed' }), upload = () => json(200, { data: { cid: CID } }) } = {}) {
  const w = { calls: [], policy: null, form: null };
  w.deps = {
    address: '0x' + 'a'.repeat(40),
    fetch: async (url, init) => {
      w.calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).startsWith(PINATA_402)) return json(402, {}, { 'payment-required': header([offer({ amount: price })]) });
      w.form = init.body;
      return upload();
    },
    paidFetchFor: (payTo, max) => {
      w.policy = { payTo, max };
      return async (url, init) => {
        w.calls.push(`PAID ${init?.method} ${url}`);
        return paid();
      };
    },
  };
  return w;
}
const BYTES = Buffer.from('hello');

test('pin probes the price, pays Pinata, uploads the file and returns the CID', async () => {
  const w = pinata();
  const r = await pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, w.deps);
  assert.deepEqual(r, { cid: CID, url: `https://gateway.pinata.cloud/ipfs/${CID}`, price: 1200n });
  assert.deepEqual(w.calls, [`POST ${PINATA_402}/v1/pin/public?fileSize=5`, `PAID POST ${PINATA_402}/v1/pin/public?fileSize=5`, 'POST https://uploads.example/signed']);
  assert.deepEqual(w.policy, { payTo: PINATA_PAYEE, max: 10_000n });
  assert.equal(w.form.get('network'), 'public');
  assert.equal(w.form.get('name'), 'a.txt');
  assert.equal(Buffer.from(await w.form.get('file').arrayBuffer()).toString(), 'hello');
});

test('pin signs nothing when the price is over the cap', async () => {
  const w = pinata({ price: '20000' });
  await assert.rejects(pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, w.deps), /0\.02 USDC, over the cap of 0\.01/);
  assert.equal(w.policy, null);
  assert.equal(w.calls.length, 1);
});

test('pin names the wallet to fund when the payment is refused, and fails loudly on a bad upload answer', async () => {
  const refused = pinata({ paid: () => json(402, {}) });
  await assert.rejects(pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, refused.deps), new RegExp(`payment refused.*0x${'a'.repeat(40)}`));
  assert.equal(refused.calls.length, 2, 'nothing was uploaded');
  const noUrl = pinata({ paid: () => json(200, { url: 'http://plain.example/x' }) });
  await assert.rejects(pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, noUrl.deps), /no upload address/);
  const noCid = pinata({ upload: () => json(200, { data: {} }) });
  await assert.rejects(pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, noCid.deps), /no CID/);
  const oddCid = pinata({ upload: () => json(200, { data: { cid: 'not a cid' } }) });
  await assert.rejects(pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, oddCid.deps), /no CID/);
  const failed = pinata({ upload: () => json(500, { error: 'boom' }) });
  await assert.rejects(pinFile({ bytes: BYTES, name: 'a.txt', base: PINATA_402, max: 10_000n }, failed.deps), /upload answered 500/);
});

test('declareReceipt posts the hash to the door for the lease and saves the signed answer', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'rcpt-')), 'receipts');
  const sha = 'cd'.repeat(32);
  const signed = { receipt: { v: 1, kind: 'declared', sha256: sha }, message: 'm', signer: '0x1', signature: '0x2' };
  const sent = [];
  const fetch = async (url, init) => (sent.push({ url, method: init.method, body: JSON.parse(init.body) }), json(200, signed));
  const r = await declareReceipt({ door: 'https://door.example', leaseId: LEASE, sha256: sha, bytes: 5, cid: CID }, { fetch, saveDir: dir });
  assert.deepEqual(r, { signed, file: join(dir, `${sha}.json`) });
  assert.deepEqual(sent, [{ url: `https://door.example/v1/leases/${LEASE}/receipt`, method: 'POST', body: { sha256: sha, bytes: 5, cid: CID } }]);
  assert.deepEqual(JSON.parse(readFile(join(dir, `${sha}.json`), 'utf8')), signed);
  assert.equal(statSync(join(dir, `${sha}.json`)).mode & 0o777, 0o600);
  // No CID: the key is left out, not sent as null.
  await declareReceipt({ door: 'https://door.example', leaseId: LEASE, sha256: sha, bytes: 5 }, { fetch, saveDir: dir });
  assert.deepEqual(sent[1].body, { sha256: sha, bytes: 5 });
});

test('declareReceipt says why the door signed nothing, and saves nothing', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'rcpt-')), 'receipts');
  const fetch = async () => json(409, { error: 'not_running' });
  await assert.rejects(declareReceipt({ door: 'https://door.example', leaseId: LEASE, sha256: 'cd'.repeat(32), bytes: 5 }, { fetch, saveDir: dir }), /not_running/);
  assert.throws(() => statSync(dir));
  mkdir(dir, { recursive: true });
});
