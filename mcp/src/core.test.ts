import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE,
  BASE_USDC,
  CapError,
  MAX_PARTS,
  MAX_TEXT,
  PayError,
  firstFitOffer,
  extend,
  grantStatus,
  lease,
  microToUsdc,
  onlyDoorExact,
  output,
  pitch,
  rent,
  sshHow,
  runJob,
  usdcToMicro,
  type Answer,
  type Deps,
  type SpendBook,
} from './core.js';

const PAY_TO = '0xbD87E8Ff0691f0A924e5ce2A06821db818B62385';
const ID = 'a'.repeat(32);
const OFFER = { offerId: 'host:one', tickPrice: '7000', intervalSeconds: 3600, images: ['charter-job-python', 'charter-job-fetch', 'charter-home'] };

function book(maxDay = 250_000n): SpendBook & { days: Map<string, bigint> } {
  const days = new Map<string, bigint>();
  return {
    days,
    maxDay,
    spent: (d) => days.get(d) ?? 0n,
    reserve: (d, m) => {
      const next = (days.get(d) ?? 0n) + m;
      if (next > maxDay) return false;
      days.set(d, next);
      return true;
    },
    release: (d, m) => void days.set(d, (days.get(d) ?? 0n) - m),
  };
}

interface Fake extends Deps {
  paid: { path: string; json: any; limit: bigint }[];
  gets: string[];
  posts: { path: string; json: any }[];
  grantHeaders: (Record<string, string> | undefined)[];
  postAnswer: Answer;
  spend: ReturnType<typeof book>;
}

/** A door in memory: `routes` answers the free reads, `onPay` the paid ones. The clock moves only when the code sleeps. */
function fake(routes: Record<string, Answer | (() => Answer)>, onPay?: (path: string, json: any) => Answer, o: { maxHour?: bigint; maxDay?: bigint } = {}): Fake {
  let t = Date.UTC(2026, 10, 18, 12);
  const f: Fake = {
    paid: [],
    gets: [],
    posts: [],
    grantHeaders: [],
    postAnswer: { status: 201, body: { grantId: 'g1', grantToken: 'tok', state: 'queued', next: 'wait' } },
    spend: book(o.maxDay),
    maxHour: o.maxHour ?? 10_000n,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    post: async (path, json) => {
      f.posts.push({ path, json });
      return f.postAnswer;
    },
    get: async (path, headers) => {
      f.gets.push(path);
      f.grantHeaders.push(headers);
      const r = routes[path];
      if (!r) return { status: 404, body: { error: 'not_found' } };
      return typeof r === 'function' ? r() : r;
    },
    ...(onPay
      ? {
          pay: async (path: string, json: unknown, limit: bigint) => {
            f.paid.push({ path, json, limit });
            return onPay(path, json);
          },
        }
      : {}),
  };
  return f;
}

const offers: Answer = { status: 200, body: [OFFER] };
const rentOk = (): Answer => ({ status: 200, body: { leaseId: ID, state: 'running', paidIntervals: 1, paidThrough: Date.UTC(2026, 10, 18, 13) }, tx: '0xabc' });
const part = (o: unknown): Answer => ({ status: 200, body: { part: 0, parts: 1, data: Buffer.from(JSON.stringify(o)).toString('base64') } });

test('USDC amounts convert both ways and refuse anything that is not a plain decimal', () => {
  assert.equal(usdcToMicro('0.25'), 250_000n);
  assert.equal(usdcToMicro('1'), 1_000_000n);
  assert.equal(usdcToMicro('0.000001'), 1n);
  assert.equal(microToUsdc(7000n), '0.007');
  assert.equal(microToUsdc(1_000_000n), '1');
  for (const bad of ['', '-1', '1e3', '0.0000001', 'abc', '1.']) assert.throws(() => usdcToMicro(bad), /not a USDC amount/);
});

test('the policy signs only exact USDC on Base to the door payee, within the hourly cap', () => {
  const ok = { scheme: 'exact', network: BASE, asset: BASE_USDC, payTo: PAY_TO, amount: '7000' };
  const pick = onlyDoorExact(PAY_TO.toLowerCase(), 10_000n);
  assert.deepEqual(pick(2, [ok]), [ok]);
  const refused = [
    { ...ok, scheme: 'batch-settlement' },
    { ...ok, network: 'eip155:1' },
    { ...ok, asset: '0x0000000000000000000000000000000000000001' },
    { ...ok, payTo: '0x000000000000000000000000000000000000dEaD' },
    { ...ok, amount: '10001' },
    { ...ok, amount: '-1' },
    { ...ok, amount: '7e3' },
    { ...ok, amount: undefined },
  ];
  assert.deepEqual(pick(2, refused), []);
  assert.deepEqual(pick(2, [...refused, ok]), [ok]);
});

test('I2: the first offer in the door\'s order that runs the job is picked, whatever is cheaper later; no fitting offer is an error before any payment', async () => {
  const dear = { ...OFFER, offerId: 'host:dear', tickPrice: '9000' };
  const pythonOnly = { ...OFFER, offerId: 'host:py', tickPrice: '1000', images: ['charter-job-python'] };
  const d = { ...fake({ '/v1/offers': { status: 200, body: [dear, OFFER, pythonOnly] } }), maxHour: 10_000n };
  assert.equal((await firstFitOffer(d, { python: { script: 'x' } })).offerId, 'host:dear');
  assert.equal((await firstFitOffer(d, { urls: ['https://example.com'] })).offerId, 'host:dear');
  await assert.rejects(firstFitOffer(d, { home: { sshKeys: ['k'], image: 'charter-hermes' } }), /no machine on sale runs charter-hermes/);
  await assert.rejects(firstFitOffer({ ...fake({}), maxHour: 10_000n }, { urls: ['https://example.com'] }), /answered 404/);
});

test('I2: an offer over the hourly cap, funding waiting, or (for a home) with no free slot is skipped', async () => {
  const dear = { ...OFFER, offerId: 'host:dear', tickPrice: '20000' };
  const waiting = { ...OFFER, offerId: 'host:waiting', record: { funding: 'waiting' } };
  const full = { ...OFFER, offerId: 'host:full', home: { slots: 1, free: 0 } };
  const open = { ...OFFER, offerId: 'host:open', home: { slots: 1, free: 1 } };
  const d = { ...fake({ '/v1/offers': { status: 200, body: [dear, waiting, full, open] } }), maxHour: 10_000n };
  assert.equal((await firstFitOffer(d, { python: { script: 'x' } })).offerId, 'host:full');
  assert.equal((await firstFitOffer(d, { home: { sshKeys: ['k'] } })).offerId, 'host:open');
  // Only offers over the cap: the first is answered, so rent says what it costs.
  const over = { ...fake({ '/v1/offers': { status: 200, body: [dear, waiting] } }), maxHour: 10_000n };
  assert.equal((await firstFitOffer(over, { python: { script: 'x' } })).offerId, 'host:dear');
});

test('rent pays one interval on the first fitting offer and books it against the day', async () => {
  const d = fake({ '/v1/offers': offers }, rentOk);
  const r = await rent(d, { python: { script: 'print(1)' } });
  // The most the call may sign is the price read before it, not the hourly cap.
  assert.deepEqual(d.paid, [{ path: '/v1/rent', json: { python: { script: 'print(1)' }, offerId: 'host:one' }, limit: 7000n }]);
  assert.equal(r.leaseId, ID);
  assert.equal(r.paidUsdc, '0.007');
  assert.equal(r.tx, '0xabc');
  assert.equal(r.paidThrough, '2026-11-18T13:00:00Z');
  assert.equal(d.spend.spent('2026-11-18'), 7000n);
});

test('a price over the hourly cap is refused before anything is sent', async () => {
  const d = fake({ '/v1/offers': offers }, rentOk, { maxHour: 6999n });
  await assert.rejects(rent(d, { python: { script: 'x' } }), (e) => e instanceof CapError && /over this server's cap of 0.006999/.test(e.message));
  assert.equal(d.paid.length, 0);
  assert.equal(d.spend.spent('2026-11-18'), 0n);
});

test('the daily cap refuses the payment that would cross it, and counts only settled payments', async () => {
  const d = fake({ '/v1/offers': offers }, rentOk, { maxDay: 14_000n });
  await rent(d, { python: { script: 'x' } });
  await rent(d, { python: { script: 'x' } });
  await assert.rejects(rent(d, { python: { script: 'x' } }), (e) => e instanceof CapError && /0.014 of 0.014 USDC spent today/.test(e.message));
  assert.equal(d.paid.length, 2);
});

test('the reservation comes back only when nothing was signed or the signed payment was refused with a 402', async () => {
  const job = { python: { script: 'x' } } as const;
  const after = async (onPay: () => Answer, expect: RegExp): Promise<bigint> => {
    const d = fake({ '/v1/offers': offers }, onPay);
    await assert.rejects(rent(d, job), expect);
    return d.spend.spent('2026-11-18');
  };
  // The facilitator turned a signed payment down: an empty wallet, most often.
  assert.equal(await after(() => ({ status: 402, body: {}, reason: 'insufficient_funds', signed: true }), /turned down \(insufficient_funds\).*address to fund.*nothing was charged/s), 0n);
  // A 402 that names a settlement is not a refusal.
  assert.equal(await after(() => ({ status: 402, body: {}, tx: '0xabc', signed: true }), /turned down/), 7000n);
  // The door answered without ever being sent a payment.
  assert.equal(await after(() => ({ status: 409, body: { error: 'busy', leaseId: ID }, signed: false }), /busy.*lapses by itself/s), 0n);
  // Any other answer after a payment was signed is kept: the door holds an authorization it could settle.
  assert.equal(await after(() => ({ status: 409, body: { error: 'busy' }, signed: true }), /busy/), 7000n);
  assert.equal(await after(() => ({ status: 500, body: {}, signed: true }), /status 500/), 7000n);
  // No answer at all: kept if a payment had left, given back if it had not.
  assert.equal(await after(() => { throw new PayError('socket hang up', true); }, /socket hang up/), 7000n);
  assert.equal(await after(() => { throw new PayError('door down', false); }, /door down/), 0n);
  assert.equal(await after(() => { throw new Error('unknown'); }, /unknown/), 7000n);
});

test('an offer or lease with no usable price is refused before any payment', async () => {
  for (const tickPrice of ['0', '-5', '7e3', '', undefined, '9'.repeat(13)]) {
    const offer = { ...OFFER, tickPrice };
    const r = fake({ '/v1/offers': { status: 200, body: [offer] } }, rentOk);
    await assert.rejects(rent(r, { python: { script: 'x' } }), /no machine on sale/, String(tickPrice));
    const e = fake({ [`/v1/leases/${ID}`]: { status: 200, body: { lease: { state: 'running', paidIntervals: 1, paidThrough: 0 }, offer } } }, rentOk);
    await assert.rejects(extend(e, ID, 3), /no usable price.*nothing was paid/, String(tickPrice));
    assert.equal(r.paid.length + e.paid.length, 0);
    assert.equal(e.spend.spent('2026-11-18'), 0n);
  }
});

test('with no wallet the paid tools say so and send nothing', async () => {
  const d = fake({ '/v1/offers': offers });
  await assert.rejects(rent(d, { python: { script: 'x' } }), /no wallet key/);
});

test('a public home\'s lease view says plain SSH', async () => {
  const d = fake({
    [`/v1/leases/${ID}`]: {
      status: 200,
      body: { lease: { state: 'running', paidIntervals: 1, paidThrough: Date.UTC(2026, 10, 18, 12, 40), access: { ssh: { host: '37.27.86.235', port: 22003, user: 'tenant' } } }, stopped: false },
    },
  });
  const { view } = await lease(d, ID);
  assert.equal(view.ssh?.how, 'Plain SSH: ssh -p 22003 tenant@37.27.86.235');
});

test('a lease view gives no ssh command for an address that is not a valid login', async () => {
  const onion = 'x'.repeat(56) + '.anyone';
  const bad = [
    { host: '-oProxyCommand=sh', port: 22003, user: 'tenant' },
    { host: 'box;rm -rf ~', port: 22003, user: 'tenant' },
    { host: 'fake.anyone', port: 22003, user: 'tenant' },
    { host: '37.27.86.235', port: 0, user: 'tenant' },
    { host: '37.27.86.235', port: 70000, user: 'tenant' },
    { host: '37.27.86.235', port: '22003', user: 'tenant' },
    { host: '37.27.86.235', port: 22.5, user: 'tenant' },
    { host: '37.27.86.235', port: 22003, user: 'root' },
    { host: '37.27.86.235', port: 22003 },
    { host: onion, port: 2222, user: 'tenant' },
  ];
  for (const ssh of bad) {
    const d = fake({ [`/v1/leases/${ID}`]: { status: 200, body: { lease: { state: 'running', paidIntervals: 1, access: { ssh } } } } });
    const { view } = await lease(d, ID);
    assert.match(view.ssh!.how, /not a valid ssh login/, JSON.stringify(ssh));
    assert.ok(!view.ssh!.how.includes(String(ssh.host)), `no value repeated: ${JSON.stringify(ssh)}`);
    assert.ok(!view.ssh!.how.includes(String(ssh.port)), `no port repeated: ${JSON.stringify(ssh)}`);
  }
  assert.equal(sshHow({ host: 'box.example.com', port: 22003, user: 'tenant' }), 'Plain SSH: ssh -p 22003 tenant@box.example.com');
  assert.match(sshHow({ host: onion, port: 22, user: 'tenant' }), new RegExp(`tenant@${onion}`));
});

test('a lease read shows the paid time left and a home\'s way in', async () => {
  const through = Date.UTC(2026, 10, 18, 12, 40);
  const d = fake({
    [`/v1/leases/${ID}`]: {
      status: 200,
      body: { lease: { state: 'running', paidIntervals: 3, paidThrough: through, access: { ssh: { host: 'x'.repeat(56) + '.anyone', port: 22, user: 'tenant' } } }, stopped: false },
    },
  });
  const { view } = await lease(d, ID);
  assert.equal(view.minutesLeft, 40);
  assert.equal(view.paidIntervals, 3);
  assert.equal(view.ssh?.user, 'tenant');
  assert.match(view.ssh!.how, /Anyone client/);
  await assert.rejects(lease(d, 'nope'), /32 lowercase hex/);
  await assert.rejects(lease(d, 'b'.repeat(32)), /does not know this lease/);
});

test('a python job comes back with its streams and exit code once it is done', async () => {
  let looks = 0;
  const d = fake(
    {
      '/v1/offers': offers,
      [`/v1/leases/${ID}`]: () => ({ status: 200, body: { lease: ++looks < 3 ? { state: 'running', paidIntervals: 1 } : { state: 'done', paidIntervals: 1, outputParts: 1 } } }),
      [`/v1/leases/${ID}/output/0`]: part({ kind: 'python', exitCode: 0, stdout: '4\n', stderr: '', seconds: 0.1 }),
    },
    rentOk,
  );
  const r = await runJob(d, { python: { script: 'print(2 + 2)' } }, 60);
  assert.equal(looks, 3);
  assert.deepEqual(r.output, { kind: 'python', exitCode: 0, seconds: 0.1, stdout: '4\n', stderr: '' });
  assert.equal(r.next, undefined);
  assert.equal(r.rented.paidUsdc, '0.007');
});

test('a job still running after the wait hands back the lease to collect later, with no second payment', async () => {
  const d = fake({ '/v1/offers': offers, [`/v1/leases/${ID}`]: { status: 200, body: { lease: { state: 'running', paidIntervals: 1 } } } }, rentOk);
  const r = await runJob(d, { urls: ['https://example.com'] }, 20);
  assert.equal(r.output, undefined);
  assert.match(r.next!, /Still running.*charter_lease/);
  assert.equal(d.paid.length, 1);
});

test('a paid job whose state cannot be read still hands back its leaseId', async () => {
  const d = fake({ '/v1/offers': offers, [`/v1/leases/${ID}`]: { status: 503, body: {} } }, rentOk);
  const r = await runJob(d, { python: { script: 'x' } }, 10);
  assert.equal(r.lease.leaseId, ID);
  assert.match(r.next!, /could not be read \(the status read answered 503\)/);
});

test('fetch output drops the screenshots and long text is cut', async () => {
  const long = 'y'.repeat(MAX_TEXT + 50);
  const two = Buffer.from(JSON.stringify({ pages: [{ url: 'https://a.example', text: long, jpegBase64: 'AAAA' }, { url: 'https://b.example', error: 'timeout', text: '' }] }));
  const d = fake({
    [`/v1/leases/${ID}/output/0`]: { status: 200, body: { part: 0, parts: 2, data: two.subarray(0, 100).toString('base64') } },
    [`/v1/leases/${ID}/output/1`]: { status: 200, body: { part: 1, parts: 2, data: two.subarray(100).toString('base64') } },
  });
  const out = (await output(d, ID, 2)) as { pages: any[] };
  assert.equal(out.pages.length, 2);
  assert.equal(out.pages[0].text.length, MAX_TEXT + '\n[cut: 50 more characters]'.length);
  assert.match(out.pages[0].screenshot, /^taken/);
  assert.equal(out.pages[0].jpegBase64, undefined);
  assert.equal(out.pages[1].error, 'timeout');
  await assert.rejects(output(d, ID, 3), /output part 2 answered 404/);
  // The door's own count is not trusted past a bound.
  await assert.rejects(output(d, ID, MAX_PARTS + 1), /at most 64 are read/);
  await assert.rejects(output(d, ID, 1e9), /at most 64 are read/);
  assert.equal(d.gets.length, 5);
});

test('extend pays the next intervals in order from the host\'s own count', async () => {
  let paidIntervals = 2;
  const d = fake(
    { [`/v1/leases/${ID}`]: () => ({ status: 200, body: { lease: { state: 'running', paidIntervals, paidThrough: 0 }, offer: OFFER } }) },
    (_path, json) => {
      assert.equal(json.index, paidIntervals);
      paidIntervals++;
      return { status: 200, body: { paidIntervals, paidThrough: Date.UTC(2026, 10, 18, 12 + paidIntervals) }, tx: `0x${paidIntervals}` };
    },
  );
  const r = await extend(d, ID, 3);
  assert.deepEqual(d.paid.map((p) => p.json.index), [2, 3, 4]);
  assert.deepEqual(d.paid.map((p) => p.limit), [7000n, 7000n, 7000n]);
  assert.equal(r.hoursPaid, 3);
  assert.equal(r.paidUsdc, '0.021');
  assert.deepEqual(r.txs, ['0x3', '0x4', '0x5']);
  assert.equal(r.paidThrough, '2026-11-18T17:00:00Z');
  assert.equal(d.spend.spent('2026-11-18'), 21_000n);
});

test('extend stops at the first refusal and reports what it did pay', async () => {
  let n = 0;
  const d = fake(
    { [`/v1/leases/${ID}`]: { status: 200, body: { lease: { state: 'running', paidIntervals: 1, paidThrough: 0 }, offer: OFFER } } },
    () => (++n === 1 ? { status: 200, body: { paidThrough: Date.UTC(2026, 10, 18, 14) } } : { status: 402, body: {}, reason: 'insufficient_funds', signed: true }),
  );
  const r = await extend(d, ID, 5);
  assert.equal(r.hoursPaid, 1);
  assert.match(r.stopped!, /insufficient_funds/);
  assert.equal(d.spend.spent('2026-11-18'), 7000n);
});

test('extend stops at the daily cap part way and refuses outright when nothing fits', async () => {
  const routes = { [`/v1/leases/${ID}`]: { status: 200, body: { lease: { state: 'running', paidIntervals: 1, paidThrough: 0 }, offer: OFFER } } };
  const ok = (): Answer => ({ status: 200, body: { paidThrough: Date.UTC(2026, 10, 18, 14) } });
  const some = fake(routes, ok, { maxDay: 15_000n });
  const r = await extend(some, ID, 4);
  assert.equal(r.hoursPaid, 2);
  assert.match(r.stopped!, /day's cap is reached/);
  const none = fake(routes, ok, { maxDay: 6_000n });
  await assert.rejects(extend(none, ID, 1), CapError);
  assert.equal(none.paid.length, 0);
});

test('extend refuses a lease that is over and pays nothing', async () => {
  const d = fake({ [`/v1/leases/${ID}`]: { status: 200, body: { lease: { state: 'closed', closedReason: 'missed_tick', paidIntervals: 4 }, offer: OFFER } } }, rentOk);
  await assert.rejects(extend(d, ID, 1), /the lease is over \(missed_tick\)/);
  assert.equal(d.paid.length, 0);
});

const KEY = 'ssh-ed25519 AAAA one';

test('pitch posts to /v1/grants and returns the token', async () => {
  const d = fake({}, rentOk);
  const r = await pitch(d, { name: 'Ada', pitch: 'I run a small bot', sshKeys: [KEY], image: 'charter-hermes', link: 'https://example.com/a' });
  assert.deepEqual(r, { grantId: 'g1', grantToken: 'tok', next: 'wait' });
  assert.deepEqual(d.posts, [{ path: '/v1/grants', json: { name: 'Ada', pitch: 'I run a small bot', sshKeys: [KEY], image: 'charter-hermes', link: 'https://example.com/a' } }]);
  assert.equal(d.paid.length, 0, 'a pitch never pays');
  assert.equal(d.spend.spent('2026-11-18'), 0n);
});

test('pitch checks its input before any request and names the door error when refused', async () => {
  const d = fake({});
  const base = { name: 'Ada', pitch: 'x', sshKeys: [KEY] };
  for (const bad of [
    { ...base, name: '' },
    { ...base, name: 'n'.repeat(81) },
    { ...base, pitch: '' },
    { ...base, pitch: 'p'.repeat(2001) },
    { ...base, sshKeys: [] },
    { ...base, sshKeys: [KEY, KEY, KEY, KEY, KEY, KEY, KEY, KEY, KEY] },
    { ...base, sshKeys: ['-----BEGIN OPENSSH PRIVATE KEY-----'] },
    { ...base, image: 'other' as any },
    { ...base, link: 'http://example.com' },
    { ...base, link: 'https://e.com/' + 'a'.repeat(200) },
  ]) await assert.rejects(pitch(d, bad), Error);
  assert.deepEqual(d.posts, []);
  const cases: [number, string, RegExp][] = [
    [503, 'fund_closed', /the fund is closed right now \(fund_closed\)/],
    [503, 'full', /the queue is full right now \(full\)/],
    [409, 'already_granted', /already_granted/],
    [429, 'rate_limited', /rate_limited/],
    [400, 'bad_keys', /bad_keys/],
  ];
  for (const [status, error, re] of cases) {
    d.postAnswer = { status, body: { error } };
    await assert.rejects(pitch(d, base), re);
  }
});

test('grantStatus reads GET /v1/grants/:id with the token header', async () => {
  const d = fake({ '/v1/grants/g1': { status: 200, body: { grantId: 'g1', state: 'approved', leaseId: ID } } });
  const r = await grantStatus(d, 'g1', 'tok');
  assert.equal((r as any).leaseId, ID);
  assert.deepEqual(d.grantHeaders, [{ 'x-grant-token': 'tok' }]);
  await assert.rejects(grantStatus(d, 'nope', 'tok'), /404|unknown|know/);
  const bad = fake({ '/v1/grants/g1': { status: 403, body: { error: 'bad_token' } } });
  await assert.rejects(grantStatus(bad, 'g1', 'wrong'), /the token does not match this grant/);
  await assert.rejects(grantStatus(d, '../x', 'tok'), /grantId/);
});
