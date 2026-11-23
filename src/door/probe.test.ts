import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pythonJob } from '../jobs.js';
import { HostError, type HostApi } from '../tenant/host-api.js';
import type { JobSpec, Lease, Offer } from '../types.js';
import { CapitalCapError } from './host-http.js';
import { HostRegistry } from './hosts.js';
import { PROBE_SCRIPT, probeHost, startProbes } from './probe.js';

const NONCE = '0123456789abcdef0123456789abcdef';
const DIGEST = createHash('sha256').update(NONCE).digest('hex');

const OFFER: Offer = {
  id: 'o1', hostPubkey: '', ilpBase: '', sealKey: '', sealUrl: '', cpu: 1, memoryMiB: 1024, intervalSeconds: 60,
  firstTickGraceSeconds: 90, tickPrice: 7000n, openPrice: 0n, statusPrice: 0n, images: ['charter-job-python'],
  hiddenHost: false, hiddenEgress: false, expiresAt: 9_999_999_999_000,
};

interface Fake {
  api: HostApi;
  calls: string[];
  jobs: JobSpec[];
}

/** A host that runs the job: `doneAfter` status reads see it booting, then done with `stdout`, unless `closeWith` is set. */
function fakeHost(o: { stdout?: string; doneAfter?: number; openClosed?: boolean; closeWith?: Lease['closedReason']; never?: boolean; tickError?: Error } = {}): Fake {
  const calls: string[] = [];
  const jobs: JobSpec[] = [];
  let reads = 0;
  const lease = (state: Lease['state'], extra: Partial<Lease> = {}): Lease => ({
    id: 'l1', offerId: OFFER.id, job: jobs[0]!, state, createdAt: 0, paidIntervals: 1, ...extra,
  });
  const result = JSON.stringify({ kind: 'python', exitCode: 0, stdout: o.stdout ?? `${DIGEST}\n`, stderr: '' });
  const api: HostApi = {
    open: async (job) => {
      calls.push('open');
      jobs.push(job);
      return o.openClosed ? { leaseId: 'l1', state: 'closed', closedReason: 'boot_failed', error: 'no such image' } : { leaseId: 'l1', state: 'awaiting_first_tick' };
    },
    tick: async (leaseId, index) => {
      calls.push(`tick ${leaseId} ${index}`);
      if (o.tickError) throw o.tickError;
      return { paidIntervals: 1, paidThrough: 1, duplicate: false };
    },
    status: async () => {
      calls.push('status');
      if (o.closeWith) return lease('closed', { closedReason: o.closeWith });
      if (o.never || reads++ < (o.doneAfter ?? 0)) return lease('running');
      return lease('done', { outputParts: 1 });
    },
    outputPart: async (_id, part) => {
      calls.push(`part ${part}`);
      return { part, parts: 1, data: Buffer.from(result).toString('base64') };
    },
    output: async () => {
      throw new Error('probe reads one part only');
    },
    spent: () => 0n,
  };
  return { api, calls, jobs };
}

function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += ms)), sleeps };
}

test('PROBE_SCRIPT hashes the nonce and refuses one that is not plain hex', () => {
  assert.equal(PROBE_SCRIPT(NONCE), `import hashlib\nprint(hashlib.sha256(b"${NONCE}").hexdigest())`);
  assert.throws(() => PROBE_SCRIPT('a"); import os; ("'));
  assert.throws(() => PROBE_SCRIPT(''));
});

test('a host that prints the right digest passes', async () => {
  const f = fakeHost({ doneAfter: 2 });
  const c = clock();
  assert.deepEqual(await probeHost(f.api, OFFER, { nonce: NONCE, ...c }), { passed: true });
  assert.deepEqual(f.jobs, [pythonJob(PROBE_SCRIPT(NONCE))]);
  assert.deepEqual(f.calls, ['open', 'tick l1 0', 'status', 'status', 'status', 'part 0']);
  assert.deepEqual(c.sleeps, [2000, 2000]);
});

test('a wrong digest fails wrong_output', async () => {
  const f = fakeHost({ stdout: `${'0'.repeat(64)}\n` });
  assert.deepEqual(await probeHost(f.api, OFFER, { nonce: NONCE, ...clock() }), { passed: false, reason: 'wrong_output' });
});

test('a lease closed with boot_failed fails boot_failed, at open or later', async () => {
  const atOpen = fakeHost({ openClosed: true });
  assert.deepEqual(await probeHost(atOpen.api, OFFER, { nonce: NONCE, ...clock() }), { passed: false, reason: 'boot_failed' });
  assert.deepEqual(atOpen.calls, ['open'], 'no tick for a lease that never booted');
  const later = fakeHost({ closeWith: 'boot_failed' });
  assert.deepEqual(await probeHost(later.api, OFFER, { nonce: NONCE, ...clock() }), { passed: false, reason: 'boot_failed' });
});

test('no done within one interval fails timeout, polling every 2 s', async () => {
  const f = fakeHost({ never: true });
  const c = clock();
  assert.deepEqual(await probeHost(f.api, OFFER, { nonce: NONCE, ...c }), { passed: false, reason: 'timeout' });
  assert.ok(c.sleeps.every((ms) => ms === 2000));
  assert.equal(c.sleeps.length, 30);
  assert.equal(f.calls.filter((x) => x === 'status').length, 31);
});

test('a host error fails host_error; a door capital refusal is not the host failing', async () => {
  const refused = fakeHost({ tickError: new HostError(402, 'unexpected_payment') });
  assert.deepEqual(await probeHost(refused.api, OFFER, { nonce: NONCE, ...clock() }), { passed: false, reason: 'host_error' });
  const down = fakeHost({ tickError: new TypeError('fetch failed') });
  assert.deepEqual(await probeHost(down.api, OFFER, { nonce: NONCE, ...clock() }), { passed: false, reason: 'unreachable' });
  const broke = fakeHost({ tickError: new CapitalCapError('h') });
  await assert.rejects(probeHost(broke.api, OFFER, { nonce: NONCE, ...clock() }), CapitalCapError);
});

function newRegistry(): HostRegistry {
  return new HostRegistry(join(mkdtempSync(join(tmpdir(), 'probe-')), 'hosts.json'));
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond());
}

test('startProbes probes due hosts at once: a pass lists, a bad offer fails, a capital refusal records nothing', async () => {
  const reg = newRegistry();
  const good = (reg.register('https://good.example', 1) as { hostId: string }).hostId;
  const bad = (reg.register('https://bad.example', 2) as { hostId: string }).hostId;
  const broke = (reg.register('https://broke.example', 3) as { hostId: string }).hostId;
  const nonces: string[] = [];
  const logs: string[] = [];
  const stop = startProbes({
    registry: reg,
    perDay: 10,
    now: () => 5_000_000,
    log: (m) => logs.push(m),
    sleep: async () => undefined,
    fetchOffer: async (url) => (url.includes('bad') ? 'bad_offer' : { ...OFFER, id: url }),
    apiOf: (o) => {
      if (o.id.includes('broke')) return fakeHost({ tickError: new CapitalCapError('broke') }).api;
      const f = fakeHost();
      const open = f.api.open;
      // Answers whatever nonce the door picked.
      f.api.open = async (job) => {
        const n = /b"([0-9a-f]+)"/.exec(job.args.SCRIPT!)![1]!;
        nonces.push(n);
        const r = await open(job);
        f.api.outputPart = async (_id, part) => ({ part, parts: 1, data: Buffer.from(createHash('sha256').update(n).digest('hex')).toString('base64') });
        return r;
      };
      return f.api;
    },
  });
  try {
    await until(() => reg.get(good)!.state === 'listed' && reg.get(bad)!.state === 'hidden' && logs.some((l) => l.includes('broke')));
    assert.equal(reg.get(good)!.offer!.id, 'https://good.example');
    assert.equal(reg.get(broke)!.state, 'probing');
    assert.equal(reg.get(broke)!.probes.lastAt, undefined);
    assert.equal(reg.firstProbesToday(5_000_000), 3);
    assert.equal(nonces.length, 1);
    assert.match(nonces[0]!, /^[0-9a-f]{32}$/);
  } finally {
    stop();
  }
});
