import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE,
  BASE_USDC,
  CapError,
  MAX_TEXT,
  cheapestOffer,
  extend,
  lease,
  microToUsdc,
  onlyDoorExact,
  output,
  rent,
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
    add: (d, m) => void days.set(d, (days.get(d) ?? 0n) + m),
  };
}

interface Fake extends Deps {
  paid: { path: string; json: any }[];
  gets: string[];
  spend: ReturnType<typeof book>;
}

/** A door in memory: `routes` answers the free reads, `onPay` the paid ones. The clock moves only when the code sleeps. */
function fake(routes: Record<string, Answer | (() => Answer)>, onPay?: (path: string, json: any) => Answer, o: { maxHour?: bigint; maxDay?: bigint } = {}): Fake {
  let t = Date.UTC(2026, 10, 18, 12);
  const f: Fake = {
    paid: [],
    gets: [],
    spend: book(o.maxDay),
    maxHour: o.maxHour ?? 10_000n,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    get: async (path) => {
      f.gets.push(path);
      const r = routes[path];
      if (!r) return { status: 404, body: { error: 'not_found' } };
      return typeof r === 'function' ? r() : r;
    },
    ...(onPay
      ? {
          pay: async (path: string, json: unknown) => {
            f.paid.push({ path, json });
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

test('the cheapest offer that runs the job is picked, and no fitting offer is an error before any payment', async () => {
  const dear = { ...OFFER, offerId: 'host:dear', tickPrice: '9000' };
  const pythonOnly = { ...OFFER, offerId: 'host:py', tickPrice: '1000', images: ['charter-job-python'] };
  const d = fake({ '/v1/offers': { status: 200, body: [dear, OFFER, pythonOnly] } });
  assert.equal((await cheapestOffer(d, { python: { script: 'x' } })).offerId, 'host:py');
  assert.equal((await cheapestOffer(d, { urls: ['https://example.com'] })).offerId, 'host:one');
  await assert.rejects(cheapestOffer(d, { home: { sshKeys: ['k'], image: 'charter-hermes' } }), /no machine on sale runs charter-hermes/);
  await assert.rejects(cheapestOffer(fake({}), { urls: ['https://example.com'] }), /answered 404/);
});

test('rent pays one interval on the cheapest offer and books it against the day', async () => {
  const d = fake({ '/v1/offers': offers }, rentOk);
  const r = await rent(d, { python: { script: 'print(1)' } });
  assert.deepEqual(d.paid, [{ path: '/v1/rent', json: { python: { script: 'print(1)' }, offerId: 'host:one' } }]);
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

test('a refused payment gives its reservation back; one that throws keeps it, since it may have left signed', async () => {
  const refused = fake({ '/v1/offers': offers }, () => ({ status: 402, body: {}, reason: 'insufficient_funds' }));
  await assert.rejects(rent(refused, { python: { script: 'x' } }), /payment was refused \(insufficient_funds\).*nothing was charged/s);
  assert.equal(refused.spend.spent('2026-11-18'), 0n);

  const thrown = fake({ '/v1/offers': offers }, () => {
    throw new Error('socket hang up');
  });
  await assert.rejects(rent(thrown, { python: { script: 'x' } }), /socket hang up/);
  assert.equal(thrown.spend.spent('2026-11-18'), 7000n);

  const busy = fake({ '/v1/offers': offers }, () => ({ status: 409, body: { error: 'busy', leaseId: ID } }));
  await assert.rejects(rent(busy, { home: { sshKeys: ['k'] } }), /busy.*lapses by itself/s);
  assert.equal(busy.spend.spent('2026-11-18'), 0n);
});

test('with no wallet the paid tools say so and send nothing', async () => {
  const d = fake({ '/v1/offers': offers });
  await assert.rejects(rent(d, { python: { script: 'x' } }), /no wallet key/);
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
    () => (++n === 1 ? { status: 200, body: { paidThrough: Date.UTC(2026, 10, 18, 14) } } : { status: 402, body: {}, reason: 'insufficient_funds' }),
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
