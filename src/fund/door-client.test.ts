import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doorClient, onlyDoorExact, usdcBalance, BASE, BASE_USDC } from './door-client.js';

const PAYTO = '0x1111111111111111111111111111111111111111';
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call { url: string; init?: RequestInit }
function fake(door: { payTo?: string; network?: string } = {}, extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const hit = extra?.(url, init);
    if (hit) return hit;
    if (url.endsWith('/v1/door')) return json(200, { payTo: door.payTo ?? PAYTO, network: door.network ?? BASE });
    return json(404, { error: 'nope' });
  }) as typeof fetch;
  return { f, calls };
}
const mk = (f: typeof fetch, over: Record<string, unknown> = {}) =>
  doorClient({ doorUrl: 'https://door.test/', key: KEY, fundToken: 'tok', maxTickMicro: 10000n, fetch: f, ...over } as never);

const req = (o: Record<string, unknown> = {}) => ({ scheme: 'exact', network: BASE, asset: BASE_USDC, payTo: PAYTO, amount: '7000', ...o });
const policy = onlyDoorExact(PAYTO, 10000n);
const kept = (o: Record<string, unknown>) => (policy(2, [req(o)] as never) as unknown[]).length;

test('refuses a door on another network', async () => {
  await assert.rejects(mk(fake({ network: 'eip155:1' }).f), /network/);
});

test('refuses a door whose payTo is not an address', async () => {
  await assert.rejects(mk(fake({ payTo: 'nope' }).f), /payTo|address/);
});

test('refuses an insecure door url, allows loopback http', async () => {
  await assert.rejects(mk(fake().f, { doorUrl: 'http://door.test' }), /https/);
  await mk(fake().f, { doorUrl: 'http://127.0.0.1:8080' });
  await mk(fake().f, { doorUrl: 'http://localhost:8080' });
});

test('the policy keeps an exact Base USDC price to the payee', () => {
  assert.equal(kept({}), 1);
  assert.equal(kept({ amount: '10000' }), 1);
  assert.equal(kept({ payTo: PAYTO.toUpperCase().replace('0X', '0x') }), 1);
});

test('the policy drops batch, other payees, other networks, other assets and a price over the cap', () => {
  assert.equal(kept({ scheme: 'batch-settlement' }), 0, 'batch');
  assert.equal(kept({ payTo: '0x2222222222222222222222222222222222222222' }), 0, 'payee');
  assert.equal(kept({ network: 'eip155:1' }), 0, 'network');
  assert.equal(kept({ asset: '0x2222222222222222222222222222222222222222' }), 0, 'asset');
  assert.equal(kept({ amount: '10001' }), 0, 'cap');
  assert.equal(kept({ amount: '1e3' }), 0, 'not decimal');
  assert.equal(kept({ amount: '-5' }), 0, 'negative');
});

test('get() reads without a bearer, never follows redirects, parses JSON or null', async () => {
  const { f, calls } = fake({}, (u) => (u.endsWith('/v1/offers') ? json(200, { offers: [] }) : u.endsWith('/v1/html') ? new Response('<p>', { status: 502 }) : u.endsWith('/v1/moved') ? new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }) : undefined));
  const c = await mk(f);
  assert.equal(c.payTo, PAYTO);
  const a = await c.get('/v1/offers');
  assert.deepEqual(a, { status: 200, body: { offers: [] } });
  assert.equal(calls.at(-1)!.url, 'https://door.test/v1/offers');
  assert.equal(calls.at(-1)!.init?.redirect, 'manual');
  assert.ok(calls.at(-1)!.init?.signal);
  assert.equal(new Headers(calls.at(-1)!.init?.headers).get('authorization'), null);
  assert.deepEqual(await c.get('/v1/html'), { status: 502, body: null });
  assert.equal((await c.get('/v1/moved')).status, 302);
});

test('fund() sends the bearer header and a JSON body', async () => {
  const { f, calls } = fake({}, (u) => (u.includes('/v1/fund/') ? json(200, { ok: true }) : undefined));
  const c = await mk(f);
  const a = await c.fund('PUT', '/v1/fund/public', { open: true });
  assert.deepEqual(a, { status: 200, body: { ok: true } });
  const last = calls.at(-1)!;
  assert.equal(last.init?.method, 'PUT');
  assert.equal(new Headers(last.init?.headers).get('authorization'), 'Bearer tok');
  assert.equal(last.init?.body, '{"open":true}');
  assert.equal(last.init?.redirect, 'manual');
  await c.fund('GET', '/v1/fund/queue');
  assert.equal(calls.at(-1)!.init?.body, undefined);
});

test('a non-2xx answer is returned, not thrown; a network error is thrown', async () => {
  const c = await mk(fake({}, (u) => (u.includes('/v1/fund/') ? json(503, { error: 'full' }) : undefined)).f);
  assert.deepEqual(await c.fund('GET', '/v1/fund/queue'), { status: 503, body: { error: 'full' } });
  let n = 0;
  const boom = (async () => { if (n++ === 0) return json(200, { payTo: PAYTO, network: BASE }); throw new Error('down'); }) as typeof fetch;
  await assert.rejects((await mk(boom)).get('/v1/offers'), /down/);
});

test('pay() signs nothing when the 402 offers only batch', async () => {
  const offer = { x402Version: 2, error: 'payment required', resource: { url: 'https://door.test/v1/rent' }, accepts: [req({ scheme: 'batch-settlement' })] };
  const { f, calls } = fake({}, (u) =>
    u.endsWith('/v1/rent') ? json(402, {}, { 'payment-required': Buffer.from(JSON.stringify(offer)).toString('base64') }) : undefined);
  const c = await mk(f);
  await assert.rejects(c.pay('/v1/rent', { a: 1 }));
  const rents = calls.filter((x) => x.url.endsWith('/v1/rent'));
  assert.equal(rents.length, 1, 'no retry with a payment');
});

test('usdcBalance reads balanceOf on Base USDC through the injected reader', async () => {
  let seen: { address?: string; functionName?: string; args?: unknown[] } = {};
  const bal = await usdcBalance(PAYTO, 'https://rpc.test', (async (a: typeof seen & { address: string }) => { seen = a; return 12345n; }) as never);
  assert.equal(bal, 12345n);
  assert.equal(seen.address, BASE_USDC);
  assert.equal(seen.functionName, 'balanceOf');
  assert.deepEqual(seen.args, [PAYTO]);
});

test('usdcBalance hides what the reader threw: no URL, no message', async () => {
  await assert.rejects(
    usdcBalance(PAYTO, 'https://rpc.test/KEY', (async () => { throw new Error('HTTP request failed. URL: https://rpc.test/KEY'); }) as never),
    (e: Error) => /balance read failed/.test(e.message) && !/rpc\.test|KEY/.test(e.message),
  );
});

test('a client with no fund token reads and pays, and fund() throws before sending anything', async () => {
  const { f, calls } = fake({}, (u) => (u.endsWith('/v1/offers') ? json(200, []) : undefined));
  const c = await mk(f, { fundToken: undefined });
  assert.equal((await c.get('/v1/offers')).status, 200);
  const before = calls.length;
  await assert.rejects(c.fund('GET', '/v1/fund/queue'), /fund token/);
  assert.equal(calls.length, before);
});

test('a client with no key reads, and pay() throws before sending anything', async () => {
  const { f, calls } = fake({}, (u) => (u.endsWith('/v1/offers') ? json(200, []) : undefined));
  const c = await mk(f, { key: undefined });
  assert.equal((await c.get('/v1/offers')).status, 200);
  const before = calls.length;
  await assert.rejects(c.pay('/v1/rent', { a: 1 }), /key/);
  assert.equal(calls.length, before);
});

test('post() sends JSON unpaid, with no bearer', async () => {
  const { f, calls } = fake({}, (u) => (u.endsWith('/v1/leases') ? json(200, { leaseId: 'x' }) : undefined));
  const c = await mk(f);
  assert.deepEqual(await c.post('/v1/leases', { offerId: 'o' }), { status: 200, body: { leaseId: 'x' } });
  const last = calls.at(-1)!;
  assert.equal(last.init?.method, 'POST');
  assert.equal(last.init?.body, '{"offerId":"o"}');
  assert.equal(new Headers(last.init?.headers).get('authorization'), null);
  assert.equal(new Headers(last.init?.headers).get('payment-signature'), null);
});

test('pay() reports the exact amount it signed on a 2xx answer, and none on a refused one', async () => {
  const offer = {
    x402Version: 2, error: 'payment required', resource: { url: 'https://door.test/v1/leases/l/ticks' },
    accepts: [{ ...req(), maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }],
  };
  let answerPaid = 200;
  const { f } = fake({}, (u, init) => {
    if (!u.endsWith('/ticks')) return undefined;
    const signed = init?.headers ? new Headers(init.headers).get('payment-signature') : null;
    return signed ? json(answerPaid, { paidIntervals: 1 }) : json(402, {}, { 'payment-required': Buffer.from(JSON.stringify(offer)).toString('base64') });
  });
  // The wrapper sends a Request: read its headers too.
  const f2 = (async (input: RequestInfo | URL, init?: RequestInit) =>
    input instanceof Request ? f(input.url, { method: input.method, headers: input.headers }) : f(input, init)) as typeof fetch;
  const c = await mk(f2);
  const a = await c.pay('/v1/leases/l/ticks', { index: 0 });
  assert.equal(a.status, 200);
  assert.equal(a.paid, 7000n);
  answerPaid = 409;
  const refused = await c.pay('/v1/leases/l/ticks', { index: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.paid, undefined, 'a non-2xx answer settles nothing');
  const { f: free } = fake({}, (u) => (u.endsWith('/v1/free') ? json(200, {}) : undefined));
  assert.equal((await (await mk(free)).pay('/v1/free', {})).paid, undefined, 'nothing asked, nothing paid');
});
