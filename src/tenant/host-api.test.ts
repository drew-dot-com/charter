// hostApi on a scripted Payer: what each typed call sends (destination, path, amount, priority, deadline),
// how answers and errors come back, and what `spent` counts. No TOON client, no host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PacketAnswer, PacketRequest, Payer, SendOpts } from '../payer.js';
import type { Lease } from '../types.js';
import { HostError, hostApi } from './host-api.js';
import { OFFER } from './test-host.js';

const LEASE = 'f'.repeat(32);
const lease: Lease = { id: LEASE, offerId: OFFER.id, job: { image: 'charter-job-fetch', args: { URLS: 'https://e.com' } }, state: 'running', createdAt: 1, paidIntervals: 1 };

interface Sent {
  dest: string;
  req: PacketRequest;
  opts: SendOpts;
}

/** A payer that answers from a script keyed on the app name, recording every send. Every answer is paid what was asked. */
function stubPayer(answer: (app: string, req: PacketRequest) => { status: number; body: unknown } | Error) {
  const sent: Sent[] = [];
  const payer: Payer = {
    async send(dest, req, opts): Promise<PacketAnswer> {
      sent.push({ dest, req, opts });
      const a = answer(dest.slice(dest.lastIndexOf('.') + 1), req);
      if (a instanceof Error) throw a;
      return { ...a, paid: opts.amount };
    },
  };
  return { payer, sent };
}

test('open sends the job to <ilpBase>.charter-open for the open price, sealed to the offer, and returns the host answer', async () => {
  const { payer, sent } = stubPayer(() => ({ status: 200, body: { leaseId: LEASE, state: 'awaiting_first_tick' } }));
  const api = hostApi(payer, OFFER);
  const job = { image: 'charter-job-fetch', args: { URLS: 'https://e.com' } };
  assert.deepEqual(await api.open(job), { leaseId: LEASE, state: 'awaiting_first_tick' });
  assert.equal(sent.length, 1);
  const s = sent[0]!;
  assert.equal(s.dest, `${OFFER.ilpBase}.charter-open`);
  assert.deepEqual(s.req, { method: 'POST', path: '/open', body: { job } });
  assert.equal(s.opts.amount, OFFER.openPrice);
  assert.equal(s.opts.sealKey, OFFER.sealKey);
  assert.equal(s.opts.sealUrl, OFFER.sealUrl);
  assert.equal(s.opts.priority, undefined, 'an open is not urgent');
  assert.equal(s.opts.deadline, undefined);
  assert.equal(api.spent(), OFFER.openPrice);
});

test('tick is always high priority, carries the deadline when given, and pays the tick price', async () => {
  const { payer, sent } = stubPayer(() => ({ status: 200, body: { paidIntervals: 3, paidThrough: 90_000, duplicate: false } }));
  const api = hostApi(payer, OFFER);
  assert.deepEqual(await api.tick(LEASE, 2), { paidIntervals: 3, paidThrough: 90_000, duplicate: false });
  assert.deepEqual(await api.tick(LEASE, 3, { deadline: 123_456 }), { paidIntervals: 3, paidThrough: 90_000, duplicate: false });
  assert.deepEqual(sent.map((s) => s.dest), [`${OFFER.ilpBase}.charter-tick`, `${OFFER.ilpBase}.charter-tick`]);
  assert.deepEqual(sent[0]!.req, { method: 'POST', path: '/tick', body: { leaseId: LEASE, index: 2 } });
  assert.equal(sent[0]!.opts.priority, 'high');
  assert.equal('deadline' in sent[0]!.opts, false, 'no deadline key when none was given');
  assert.equal(sent[1]!.opts.deadline, 123_456);
  assert.equal(sent[1]!.opts.priority, 'high');
  assert.equal(api.spent(), 2n * OFFER.tickPrice);
});

test('status is a GET of /leases/<id> for the status price; priority and deadline pass through only when given', async () => {
  const { payer, sent } = stubPayer(() => ({ status: 200, body: { lease } }));
  const api = hostApi(payer, OFFER);
  assert.deepEqual(await api.status(LEASE), lease);
  assert.deepEqual(await api.status(LEASE, { priority: 'high', deadline: 5_000 }), lease);
  assert.equal(sent[0]!.dest, `${OFFER.ilpBase}.charter-status`);
  assert.deepEqual(sent[0]!.req, { method: 'GET', path: `/leases/${LEASE}` });
  assert.equal(sent[0]!.opts.amount, OFFER.statusPrice);
  assert.equal('priority' in sent[0]!.opts, false);
  assert.equal('deadline' in sent[0]!.opts, false);
  assert.equal(sent[1]!.opts.priority, 'high');
  assert.equal(sent[1]!.opts.deadline, 5_000);
  assert.equal(api.spent(), 2n * OFFER.statusPrice);
});

test('a non-2xx answer throws HostError with the host status and error code, and is still counted in spent', async () => {
  const { payer } = stubPayer((app) => (app === 'charter-tick' ? { status: 409, body: { error: 'lease_done' } } : { status: 500, body: 'not json' }));
  const api = hostApi(payer, OFFER);
  await assert.rejects(api.tick(LEASE, 0), (e: unknown) => e instanceof HostError && e.status === 409 && e.error === 'lease_done' && e.message === 'host answered 409 lease_done');
  await assert.rejects(api.status(LEASE), (e: unknown) => e instanceof HostError && e.status === 500 && e.error === 'unknown');
  await assert.rejects(api.open({ image: 'x', args: {} }), (e: unknown) => e instanceof HostError && e.status === 500 && e.error === 'unknown');
  // A 3xx is not a success either.
  const { payer: redirecting } = stubPayer(() => ({ status: 302, body: null }));
  await assert.rejects(hostApi(redirecting, OFFER).status(LEASE), (e: unknown) => e instanceof HostError && e.status === 302 && e.error === 'unknown');
  assert.equal(api.spent(), OFFER.tickPrice + OFFER.statusPrice + OFFER.openPrice, 'every answered packet was paid, errors included');
});

test('a payer that throws (no answer at all) passes the error through and counts nothing', async () => {
  const { payer } = stubPayer(() => new Error('connector unreachable'));
  const api = hostApi(payer, OFFER);
  await assert.rejects(api.tick(LEASE, 0), /connector unreachable/);
  assert.equal(api.spent(), 0n);
});

test('outputPart is one paid status call; output joins every part in order from base64', async () => {
  const parts = [Buffer.from('hello, '), Buffer.from('world'), Buffer.from('!')];
  const { payer, sent } = stubPayer((_app, req) => {
    const m = /^\/leases\/([0-9a-f]+)\/output\/(\d+)$/.exec(req.path);
    if (!m) return { status: 404, body: { error: 'not_found' } };
    const n = Number(m[2]);
    return { status: 200, body: { part: n, parts: parts.length, data: parts[n]!.toString('base64') } };
  });
  const api = hostApi(payer, OFFER);
  assert.deepEqual(await api.outputPart(LEASE, 1), { part: 1, parts: 3, data: parts[1]!.toString('base64') });
  assert.equal(sent[0]!.dest, `${OFFER.ilpBase}.charter-status`);
  assert.equal(sent[0]!.opts.amount, OFFER.statusPrice);
  const out = await api.output(LEASE);
  assert.equal(out.toString(), 'hello, world!');
  assert.deepEqual(sent.slice(1).map((s) => s.req.path), [0, 1, 2].map((n) => `/leases/${LEASE}/output/${n}`));
  assert.equal(api.spent(), 4n * OFFER.statusPrice);
});

test('output of a single-part result makes one call; a missing later part fails the whole read', async () => {
  const one = stubPayer(() => ({ status: 200, body: { part: 0, parts: 1, data: Buffer.from('solo').toString('base64') } }));
  assert.equal((await hostApi(one.payer, OFFER).output(LEASE)).toString(), 'solo');
  assert.equal(one.sent.length, 1);
  const broken = stubPayer((_app, req) => (req.path.endsWith('/0') ? { status: 200, body: { part: 0, parts: 2, data: '' } } : { status: 404, body: { error: 'not_found' } }));
  await assert.rejects(hostApi(broken.payer, OFFER).output(LEASE), (e: unknown) => e instanceof HostError && e.status === 404);
});
