import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { getAddress } from 'viem';
import type { HostApi, OpenResult, TickResult } from '../tenant/host-api.js';
import { HOURLY, listedRegistry } from '../tenant/test-host.js';
import type { Lease, Micro, Offer } from '../types.js';
import { DoorLedger } from './ledger.js';
import { REFERRALS_FILE, ReferralStore } from './referrals.js';
import { PAYOUTS_FILE, PayoutLog } from './referral-payouts.js';
import { doorApp, type DoorDeps } from './server.js';
import { homeIdOf, normalizeSshKeys } from '../jobs.js';

const A = '0x' + '1a'.repeat(20);
const B = '0x' + '2b'.repeat(20);
const PAYER = '0x' + '3c'.repeat(20);
const DOOR_PAYER = '0x' + '4d'.repeat(20);
const FUND = '0x' + '5e'.repeat(20);
const ALLOW = '0x' + '6f'.repeat(20);
const PAY_TO = '0x' + '2'.repeat(40);
const CLAIM_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const URLS = ['https://example.com/a'];
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@host';
const HOME = homeIdOf(normalizeSshKeys([KEY])!);
/** One hour at 7000 micro-USDC, running fetch jobs and homes. */
const OFFER: Offer = { ...HOURLY, images: ['charter-job-fetch', 'charter-home'], home: { diskGiB: 10, retentionDays: 30, slots: 2 } };
const OFFER_ID = `${OFFER.hostId}:${OFFER.id}`;

/** A mixed-case address whose checksum is wrong: one letter of a checksummed address flipped. */
function brokenChecksum(a: string): string {
  const c = getAddress(a);
  const i = [...c].findIndex((ch, n) => n > 1 && /[a-f]/i.test(ch));
  const ch = c[i]!;
  return c.slice(0, i) + (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) + c.slice(i + 1);
}

/** A host that opens a fresh lease id each time and answers every tick. */
function fakeHost() {
  let n = 0;
  let spent: Micro = 0n;
  const opened: string[] = [];
  const api: HostApi = {
    open: async (): Promise<OpenResult> => {
      const leaseId = (++n).toString(16).padStart(32, '0');
      opened.push(leaseId);
      return { leaseId, state: 'awaiting_first_tick' };
    },
    tick: async (_id, index): Promise<TickResult> => ((spent += OFFER.tickPrice), { paidIntervals: index + 1, paidThrough: 31_000, duplicate: false }),
    status: async (id): Promise<Lease> => ({ id, offerId: OFFER.id, job: { image: 'charter-job-fetch', args: {} }, state: 'running', createdAt: 1, paidIntervals: 1, paidThrough: 2 }),
    output: async () => Buffer.alloc(0),
    outputPart: async () => ({ part: 0, parts: 1, data: '' }),
    spent: () => spent,
  };
  return { api, opened };
}

interface Opts {
  bps?: number;
  hosts?: string[];
  fee?: Micro;
  referrals?: false;
  log?: (file: string) => PayoutLog;
  store?: (file: string) => ReferralStore;
  settleFails?: boolean;
  over?: Partial<DoorDeps>;
}

async function start(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ref-'));
  const ledger = new DoorLedger(join(dir, 'ledger.json'));
  const storeFile = join(dir, REFERRALS_FILE);
  const store = o.store ? o.store(storeFile) : new ReferralStore(storeFile);
  const log = o.log ? o.log(join(dir, PAYOUTS_FILE)) : new PayoutLog(join(dir, PAYOUTS_FILE));
  const host = fakeHost();
  const clock = { t: 1_000_000 };
  const settle = { fail: o.settleFails ?? false };
  const deps: DoorDeps = {
    offers: async () => [OFFER],
    api: () => host.api,
    registry: listedRegistry(dir),
    ledger,
    x402: 'free-for-tests',
    now: () => clock.t,
    webDir: join(dir, 'no-web'),
    dataDir: dir,
    payer: DOOR_PAYER as `0x${string}`,
    fundAddress: FUND,
    allowAddress: ALLOW,
    ...(o.fee !== undefined ? { fee: o.fee } : {}),
    ...(o.referrals === false ? {} : { referrals: { store, log, bps: o.bps ?? 1000, hosts: new Set(o.hosts ?? [OFFER.hostId]) } }),
    testHooks: {
      settle: () => {
        if (settle.fail) throw new Error('invalid_exact_evm_insufficient_balance');
      },
    },
    ...o.over,
  };
  const server = doorApp(deps).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, payer = PAYER) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-payer': payer }, body: JSON.stringify(body) });
  return {
    base, dir, ledger, store, log, storeFile, host, settle, post,
    get: (path: string) => fetch(base + path),
    close: () => void server.close(),
    rent: (b: Record<string, unknown>, payer?: string) => post('/v1/rent', { offerId: OFFER_ID, urls: URLS, ...b }, payer),
    rentHome: (b: Record<string, unknown> = {}, payer?: string) => post('/v1/rent', { home: { sshKeys: [KEY] }, ...b }, payer),
    tick: (leaseId: string, index: number, payer?: string) => post(`/v1/leases/${leaseId}/ticks`, { index }, payer),
  };
}

type Door = Awaited<ReturnType<typeof start>>;
async function withDoor(o: Opts, run: (d: Door) => Promise<void>): Promise<void> {
  const d = await start(o);
  try {
    await run(d);
  } finally {
    d.close();
  }
}

test('rent with a referral: 200, echoed lower case, kept on the lease, 10% of each paid hour accrues', async () => {
  await withDoor({}, async (d) => {
    const r = await d.rent({ referral: getAddress(A) });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { leaseId: string; referral?: string };
    assert.equal(j.referral, A);
    assert.equal(d.ledger.get(j.leaseId)!.referral, A);
    const rec = d.store.get(A)!;
    assert.equal(rec.earned, 700n);
    assert.equal(rec.hours, 1);
    assert.equal((await d.tick(j.leaseId, 1)).status, 200);
    assert.equal(d.store.get(A)!.earned, 1400n);
    assert.equal(d.store.get(A)!.hours, 2);
  });
});

test('bad_referral on rent and on open: broken checksum, zero address, door payer, fund address; nothing opens', async () => {
  // A door per value: each IP may open only so many leases an hour, refused ones included.
  for (const bad of [brokenChecksum(A), '0x' + '0'.repeat(40), DOOR_PAYER, getAddress(DOOR_PAYER), FUND, 'nope', 42]) {
    await withDoor({}, async (d) => {
      const r = await d.rent({ referral: bad });
      assert.equal(r.status, 400, String(bad));
      assert.deepEqual(await r.json(), { error: 'bad_referral' });
      const o = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS, referral: bad });
      assert.equal(o.status, 400, String(bad));
      assert.deepEqual(await o.json(), { error: 'bad_referral' });
      assert.deepEqual(d.host.opened, []);
      assert.equal(d.ledger.all().length, 0);
    });
  }
});

test('a body holding only a referral is bad_request', async () => {
  await withDoor({}, async (d) => {
    const r = await d.post('/v1/rent', { referral: A });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'bad_request' });
    const o = await d.post('/v1/leases', { referral: A });
    assert.equal(o.status, 400);
    assert.deepEqual(await o.json(), { error: 'bad_request' });
  });
});

test('bad_referral on the unpaid challenge, before anything is asked to pay; the pay-to address is refused', async () => {
  const fac = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.startsWith('/supported') ? { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }, { x402Version: 2, scheme: 'batch-settlement', network: 'eip155:8453', extra: { experimental: true, batchPolicy: { minInitialDeposit: '100000' } } }], extensions: [], signers: {} } : {}));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fac.once('listening', r));
  const facilitatorUrl = `http://127.0.0.1:${(fac.address() as AddressInfo).port}`;
  const d = await start({ over: { x402: { payTo: PAY_TO as `0x${string}`, network: 'eip155:8453', facilitatorUrl, claimKey: CLAIM_KEY, channelDir: mkdtempSync(join(tmpdir(), 'ch-')) } } });
  try {
    for (const bad of [brokenChecksum(A), PAY_TO, FUND, DOOR_PAYER]) {
      const r = await fetch(`${d.base}/v1/rent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offerId: OFFER_ID, urls: URLS, referral: bad }) });
      assert.equal(r.status, 400, bad);
      assert.deepEqual(await r.json(), { error: 'bad_referral' });
    }
    const ok = await fetch(`${d.base}/v1/rent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offerId: OFFER_ID, urls: URLS, referral: A }) });
    assert.equal(ok.status, 402, 'a good referral gets the challenge');
    assert.deepEqual(d.host.opened, []);
  } finally {
    d.close();
    fac.close();
  }
});

test('no referral: answers carry no referral field and nothing accrues', async () => {
  await withDoor({}, async (d) => {
    const r = await d.rent({});
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, unknown>;
    assert.equal('referral' in j, false);
    assert.equal(d.ledger.get(j.leaseId as string)!.referral, undefined);
    const o = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS });
    assert.equal(o.status, 200);
    const oj = (await o.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(oj).sort(), ['leaseId', 'state']);
    assert.deepEqual(d.store.all(), []);
    assert.equal(existsSync(d.storeFile), false);
  });
});

test('referral: null is the same as none, on rent and on open', async () => {
  await withDoor({}, async (d) => {
    const r = await d.rent({ referral: null });
    assert.equal(r.status, 200);
    const j = (await r.json()) as Record<string, unknown>;
    assert.equal('referral' in j, false);
    assert.equal(d.ledger.get(j.leaseId as string)!.referral, undefined);
    const o = await d.post('/v1/leases', { offerId: OFFER_ID, urls: URLS, referral: null });
    assert.equal(o.status, 200);
    const oj = (await o.json()) as Record<string, unknown>;
    assert.equal('referral' in oj, false);
    assert.deepEqual(d.store.all(), []);
  });
});

test('an open with a referral and no paid hour creates no store entry', async () => {
  await withDoor({}, async (d) => {
    const o = await d.post('/v1/leases', { offerId: OFFER_ID, home: { sshKeys: [KEY] }, referral: A });
    assert.equal(o.status, 200);
    const j = (await o.json()) as { leaseId: string; referral?: string };
    assert.equal(j.referral, A, 'echoes who will earn');
    assert.equal(d.ledger.get(j.leaseId)!.referral, A);
    assert.equal(d.store.get(A), undefined);
    assert.equal(d.store.homeReferrer(HOME), undefined);
    assert.equal(existsSync(d.storeFile), false);
  });
});

test('a host that is not listed earns at most the door fee', async () => {
  await withDoor({ hosts: [] }, async (d) => {
    assert.equal((await d.rent({ referral: A })).status, 200);
    assert.equal(d.store.get(A), undefined, 'fee 0: nothing accrues');
  });
  await withDoor({ hosts: [], fee: 300n }, async (d) => {
    assert.equal((await d.rent({ referral: A })).status, 200);
    assert.equal(d.store.get(A)!.earned, 300n);
  });
});

test('an hour paid by the fund earns nothing; one paid by the allowance biller earns', async () => {
  await withDoor({}, async (d) => {
    assert.equal((await d.rent({ referral: A }, getAddress(FUND))).status, 200);
    assert.equal(d.store.get(A), undefined);
    assert.equal((await d.rent({ referral: B }, ALLOW)).status, 200);
    assert.equal(d.store.get(B)!.earned, 700n);
  });
});

test('bps 0: the referral is recorded and echoed, nothing accrues', async () => {
  await withDoor({ bps: 0 }, async (d) => {
    const r = await d.rent({ referral: A });
    const j = (await r.json()) as { leaseId: string; referral?: string };
    assert.equal(j.referral, A);
    assert.equal(d.ledger.get(j.leaseId)!.referral, A);
    assert.equal(d.store.get(A), undefined);
  });
});

test('without deps.referrals the field is still checked, recorded and echoed', async () => {
  await withDoor({ referrals: false }, async (d) => {
    assert.equal((await d.rent({ referral: '0x' + '0'.repeat(40) })).status, 400);
    const j = (await (await d.rent({ referral: A })).json()) as { leaseId: string; referral?: string };
    assert.equal(j.referral, A);
    assert.equal(d.ledger.get(j.leaseId)!.referral, A);
    assert.equal(existsSync(d.storeFile), false);
  });
});

test('a tick whose settle fails accrues nothing', async () => {
  await withDoor({ settleFails: true }, async (d) => {
    const r = await d.rent({ referral: A });
    assert.notEqual(r.status, 200);
    assert.equal(d.store.get(A), undefined);
    assert.equal(d.store.homeReferrer(HOME), undefined);
  });
});

test('a home is bound to the referral of its first paid hour, and every later hour earns for it', async () => {
  await withDoor({}, async (d) => {
    const first = (await (await d.rentHome({ referral: A })).json()) as { leaseId: string; referral?: string };
    assert.equal(first.referral, A);
    assert.equal(d.store.homeReferrer(HOME), A);
    assert.equal(d.store.get(A)!.earned, 700n);
    const named = (await (await d.rentHome({ referral: B })).json()) as { leaseId: string; referral?: string };
    assert.equal(named.referral, A, 'the bound address, not the one named');
    assert.equal(d.ledger.get(named.leaseId)!.referral, B, 'the lease keeps what was named');
    assert.equal(d.store.get(A)!.earned, 1400n);
    assert.equal(d.store.get(B), undefined);
    const none = (await (await d.rentHome()).json()) as { leaseId: string; referral?: string };
    assert.equal(none.referral, A);
    assert.equal(d.store.get(A)!.earned, 2100n);
    assert.equal(d.store.get(A)!.hours, 3);
  });
});

test('a home with a paid hour and no binding cannot be bound by a request; an operator binding earns from then on', async () => {
  await withDoor({}, async (d) => {
    assert.equal((await d.rentHome()).status, 200);
    const r = await d.rentHome({ referral: A });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { leaseId: string; referral?: string };
    assert.equal('referral' in j, false);
    assert.equal(d.store.homeReferrer(HOME), undefined);
    assert.equal(d.store.get(A), undefined);
    d.store.setHome(HOME, A);
    assert.equal((await d.tick(j.leaseId, 1)).status, 200);
    assert.equal(d.store.get(A)!.earned, 700n);
  });
});

test('a paid hour scans the ledger for the home\'s first paid hour only when the lease names a referral and the home is unbound', async () => {
  await withDoor({}, async (d) => {
    const plain = (await (await d.rentHome()).json()) as { leaseId: string };
    let scans = 0;
    const scan = d.ledger.homeHasPaidHour.bind(d.ledger);
    d.ledger.homeHasPaidHour = (h: string) => (scans++, scan(h));
    assert.equal((await d.tick(plain.leaseId, 1)).status, 200);
    assert.equal(scans, 0, 'no referral on the lease: no scan');
    d.store.setHome(HOME, A);
    const named = (await (await d.rentHome({ referral: B })).json()) as { leaseId: string };
    scans = 0;
    assert.equal((await d.tick(named.leaseId, 1)).status, 200);
    assert.equal(scans, 0, 'a bound home: no scan');
    assert.equal(d.store.get(A)!.earned, 1400n);
  });
});

test('two leases of a new home opened before either is paid: one binding, both hours accrue to it', async () => {
  await withDoor({}, async (d) => {
    const a = (await (await d.post('/v1/leases', { offerId: OFFER_ID, home: { sshKeys: [KEY] }, referral: A })).json()) as { leaseId: string; referral?: string };
    const b = (await (await d.post('/v1/leases', { offerId: OFFER_ID, home: { sshKeys: [KEY] }, referral: B })).json()) as { leaseId: string; referral?: string };
    assert.equal(a.referral, A);
    assert.equal(b.referral, B);
    assert.equal((await d.tick(a.leaseId, 0)).status, 200);
    assert.equal((await d.tick(b.leaseId, 0)).status, 200);
    assert.equal(d.store.homeReferrer(HOME), A);
    assert.equal(d.store.get(A)!.earned, 1400n);
    assert.equal(d.store.get(A)!.hours, 2);
    assert.equal(d.store.get(B), undefined);
  });
});

test('a store whose accrue throws: the hour still answers 200 and is booked', async () => {
  class Broken extends ReferralStore {
    override accrue(): void {
      throw new Error('disk full');
    }
  }
  const logged: unknown[][] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    await withDoor({ store: (f) => new Broken(f) }, async (d) => {
      const r = await d.rent({ referral: A });
      assert.equal(r.status, 200);
      const j = (await r.json()) as { leaseId: string };
      assert.equal(d.ledger.get(j.leaseId)!.ticksPaidByRenter, 1);
    });
  } finally {
    console.error = err;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]![0]), /^charter-door referral accrual failed: /);
});

interface Answer {
  address: string;
  bps: number;
  hours: number;
  earned: string;
  paid: string;
  owed: string;
  held: boolean;
  payouts: Array<{ amount: string; tx: string; at: number }>;
}

test('GET /v1/referrals/:address: zeros for an unknown address, in lower case, whatever case it was asked in', async () => {
  await withDoor({}, async (d) => {
    const r = await d.get(`/v1/referrals/${getAddress(B)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { address: B, bps: 1000, hours: 0, earned: '0', paid: '0', owed: '0', held: false, payouts: [] });
  });
});

test('GET /v1/referrals/:address: an address with accruals shows hours, earned and owed', async () => {
  await withDoor({}, async (d) => {
    assert.equal((await d.rent({ referral: A })).status, 200);
    const j = (await (await d.get(`/v1/referrals/${A}`)).json()) as Answer;
    assert.deepEqual(j, { address: A, bps: 1000, hours: 1, earned: '700', paid: '0', owed: '700', held: false, payouts: [] });
  });
});

test('GET /v1/referrals/:address: a held address says held and never why', async () => {
  await withDoor({}, async (d) => {
    d.store.accrue(A, 700n, 1);
    d.store.hold(A, 'secret operator reason');
    const r = await d.get(`/v1/referrals/${A}`);
    const text = await r.text();
    assert.equal((JSON.parse(text) as Answer).held, true);
    assert.doesNotMatch(text, /secret operator reason|reason/);
  });
});

test('GET /v1/referrals/:address: a malformed address is 400 bad_referral', async () => {
  await withDoor({}, async (d) => {
    for (const bad of ['nope', '0x123', brokenChecksum(A), '0x' + '0'.repeat(40)]) {
      const r = await d.get(`/v1/referrals/${bad}`);
      assert.equal(r.status, 400, bad);
      assert.deepEqual(await r.json(), { error: 'bad_referral' });
    }
  });
});

test('GET /v1/referrals/:address: 51 sent payouts give the newest 50, and paid is the store total of all 51', async () => {
  await withDoor({}, async (d) => {
    let total = 0n;
    for (let i = 1; i <= 51; i++) {
      d.store.accrue(A, 1000n, i);
      const id = d.log.intent(A, 1000n, i * 10);
      d.log.sent(id, '0x' + i.toString(16).padStart(64, '0'), i * 10 + 1);
      d.store.markPaid(A, 1000n, id);
      total += 1000n;
    }
    const j = (await (await d.get(`/v1/referrals/${A}`)).json()) as Answer;
    assert.equal(j.payouts.length, 50);
    assert.equal(j.paid, total.toString());
    assert.equal(j.owed, '0');
    assert.equal(j.payouts[0]!.tx, '0x' + (51).toString(16).padStart(64, '0'));
    assert.deepEqual(Object.keys(j.payouts[0]!).sort(), ['amount', 'at', 'tx']);
    assert.equal(j.payouts[0]!.amount, '1000');
    assert.ok(j.payouts[0]!.at > j.payouts[49]!.at);
  });
});

test('GET /v1/referrals/:address with bps 0 still shows what is owed', async () => {
  await withDoor({ bps: 0 }, async (d) => {
    d.store.accrue(A, 700n, 1);
    const j = (await (await d.get(`/v1/referrals/${A}`)).json()) as Answer;
    assert.equal(j.bps, 0);
    assert.equal(j.owed, '700');
  });
});

test('GET /v1/referrals/:address with no referral deps: zeros and bps 0', async () => {
  await withDoor({ referrals: false }, async (d) => {
    const r = await d.get(`/v1/referrals/${A}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { address: A, bps: 0, hours: 0, earned: '0', paid: '0', owed: '0', held: false, payouts: [] });
  });
});

test('GET /v1/offers carries referralShare only when above 0: a listed host 700, an unlisted one with fee 0 none, bps 0 none', async () => {
  await withDoor({}, async (d) => {
    const [o] = (await (await d.get('/v1/offers')).json()) as Array<{ referralShare?: string }>;
    assert.equal(o!.referralShare, '700');
  });
  await withDoor({ hosts: [] }, async (d) => {
    const [o] = (await (await d.get('/v1/offers')).json()) as Array<Record<string, unknown>>;
    assert.equal('referralShare' in o!, false);
  });
  await withDoor({ bps: 0 }, async (d) => {
    const [o] = (await (await d.get('/v1/offers')).json()) as Array<Record<string, unknown>>;
    assert.equal('referralShare' in o!, false);
  });
  await withDoor({ referrals: false }, async (d) => {
    const [o] = (await (await d.get('/v1/offers')).json()) as Array<Record<string, unknown>>;
    assert.equal('referralShare' in o!, false);
  });
});

test('GET /v1/door carries referral { bps, how } only when bps is above 0', async () => {
  const x402 = { payTo: PAY_TO, network: 'eip155:8453', facilitatorUrl: 'http://127.0.0.1:1', claimKey: CLAIM_KEY, channelDir: mkdtempSync(join(tmpdir(), 'ch-')) };
  await withDoor({ over: { x402 } }, async (d) => {
    const j = (await (await d.get('/v1/door')).json()) as { referral?: { bps: number; how: string } };
    assert.equal(j.referral?.bps, 1000);
    assert.equal(
      j.referral?.how,
      'Add "referral": "<0x address on Base>" to POST /v1/rent. That address earns a share of every hour the renter pays for, paid in USDC on Base. Read GET /v1/referrals/<address>.',
    );
  });
  await withDoor({ bps: 0, over: { x402 } }, async (d) => {
    assert.equal('referral' in ((await (await d.get('/v1/door')).json()) as object), false);
  });
});

test('GET /openapi.json has the referral property on rent and open, and the referrals path', async () => {
  await withDoor({}, async (d) => {
    const doc = (await (await d.get('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { description?: string; requestBody?: { content: { 'application/json': { schema: { properties: Record<string, unknown> } } } } }>>;
    };
    for (const [p, m] of [['/v1/rent', 'post'], ['/v1/leases', 'post']] as const) {
      assert.ok(doc.paths[p]![m]!.requestBody!.content['application/json'].schema.properties.referral, `${p} takes referral`);
    }
    assert.match(doc.paths['/v1/rent']!.post!.description!, /referral/);
    assert.ok(doc.paths['/v1/referrals/{address}']!.get);
  });
});
