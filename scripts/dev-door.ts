// Runs the door locally for looking at the storefront: no payment gate, no wallet, a fake host with two offers.
// A python lease runs the real job wrapper (jobs/python/run.py) with the local python3, on the host itself, unsandboxed.
//   npm run build:web && npm run dev:door      then open http://127.0.0.1:8787
// DEV_DOOR_PORT changes the port; DEV_INTERVAL_SECONDS (default 30, at least 12) shortens the interval.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoorLedger } from '../src/door/ledger.js';
import { doorApp } from '../src/door/server.js';
import type { HostApi, OpenResult, OutputPart, TickResult } from '../src/tenant/host-api.js';
import { HostError } from '../src/tenant/host-api.js';
import type { Lease, Offer } from '../src/types.js';
import { SAMPLE_JPEG_BASE64 } from './dev-door-sample.js';

const port = Number(process.env.DEV_DOOR_PORT ?? 8787);
const intervalSeconds = Math.max(12, Number(process.env.DEV_INTERVAL_SECONDS ?? 30));
/** Intervals the fake job runs for. */
const JOB_INTERVALS = 3;
const BOOT_MS = 2_000;
const OUTPUT_PARTS = 2;
// Not a real transaction: it only has the shape of a Solana signature, so the page shows its link.
const FAKE_LANDING = { chain: 'solana', tx: '1'.repeat(88), shared: true };

const offer = (id: string, key: string, cpu: number, memoryMiB: number, hiddenHost: boolean, images: string[]): Offer => ({
  id, hostPubkey: key.repeat(32), ilpBase: 'g.dev', sealKey: '0x04' + key.repeat(64), sealUrl: 'http://dev.invalid/ilp',
  cpu, memoryMiB, intervalSeconds, firstTickGraceSeconds: 90,
  tickPrice: 5000n, openPrice: 1000n, statusPrice: 100n, images, hiddenHost, hiddenEgress: false,
  expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
});
const OFFERS = [
  offer('small', 'ab', 1, 1024, true, ['charter-job-fetch', 'charter-job-python']),
  offer('medium', 'cd', 2, 4096, false, ['charter-job-fetch']),
];
const RUN_PY = join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'python', 'run.py');

interface FakeLease {
  lease: Lease;
  urls: string[];
  result?: Buffer;
  nextIndex: number;
}
const leases = new Map<string, FakeLease>();

function view(f: FakeLease, now: number): Lease {
  const l = f.lease;
  if (l.state === 'awaiting_first_tick' && now - l.createdAt < BOOT_MS) return { ...l, state: 'booting' };
  if (l.state === 'running' && l.paidThrough !== undefined && now > l.paidThrough) {
    return (f.lease = { ...l, state: 'closed', closedReason: 'missed_tick' });
  }
  return l;
}

function resultJson(f: FakeLease): Buffer {
  if (f.lease.job.image === 'charter-job-python') {
    if (!f.result) {
      const out = mkdtempSync(join(tmpdir(), 'charter-dev-py-'));
      spawnSync('python3', [RUN_PY], { env: { PATH: process.env.PATH, CHARTER_OUT: out, SCRIPT: f.lease.job.args.SCRIPT ?? '' }, timeout: 60_000 });
      try {
        f.result = readFileSync(join(out, 'result.json'));
      } catch {
        f.result = Buffer.from(JSON.stringify({ kind: 'python', exitCode: 2, seconds: 0, stdout: '', stderr: 'dev door: the wrapper wrote no result' }));
      }
    }
    return f.result;
  }
  const pages = f.urls.map((url, i) => ({
    url,
    text: `Dev sample text for ${url}\n\nThis is fake output from the local dev door. Page ${i + 1} of ${f.urls.length}.\n<b>Markup in the text is shown as text.</b>`,
    jpegBase64: SAMPLE_JPEG_BASE64,
  }));
  return Buffer.from(JSON.stringify({ pages }));
}

function parts(f: FakeLease): Buffer[] {
  const all = resultJson(f);
  const cut = Math.floor(all.length / OUTPUT_PARTS);
  return [all.subarray(0, cut), all.subarray(cut)];
}

const apiFor = (o: Offer): HostApi => ({
  open: async (job): Promise<OpenResult> => {
    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const now = Date.now();
    leases.set(id, {
      urls: (job.args.URLS ?? '').split(','),
      nextIndex: 0,
      lease: { id, offerId: o.id, job, state: 'awaiting_first_tick', createdAt: now, paidIntervals: 0 },
    });
    return { leaseId: id, state: 'awaiting_first_tick' };
  },
  tick: async (id, index): Promise<TickResult> => {
    const f = leases.get(id);
    if (!f) throw new HostError(404, 'not_found');
    const l = view(f, Date.now());
    if (l.state === 'done') throw new HostError(409, 'lease_done');
    if (l.state === 'closed') throw new HostError(409, 'not_running');
    if (index !== f.nextIndex) throw new HostError(409, 'out_of_order');
    f.nextIndex++;
    const paidIntervals = index + 1;
    if (paidIntervals >= JOB_INTERVALS) {
      f.lease = { ...l, state: 'done', paidIntervals, paidThrough: undefined, outputParts: OUTPUT_PARTS, landing: FAKE_LANDING };
      return { paidIntervals, duplicate: false };
    }
    const paidThrough = Date.now() + intervalSeconds * 1000;
    f.lease = { ...l, state: 'running', paidIntervals, paidThrough };
    return { paidIntervals, paidThrough, duplicate: false };
  },
  status: async (id): Promise<Lease> => {
    const f = leases.get(id);
    if (!f) throw new HostError(404, 'not_found');
    return view(f, Date.now());
  },
  outputPart: async (id, n): Promise<OutputPart> => {
    const f = leases.get(id);
    if (!f || f.lease.state !== 'done') throw new HostError(404, 'not_found');
    const p = parts(f);
    if (n >= p.length) throw new HostError(404, 'not_found');
    return { part: n, parts: p.length, data: p[n]!.toString('base64') };
  },
  output: async (id) => Buffer.concat(parts(leases.get(id)!)),
  spent: () => 0n,
});

const dir = mkdtempSync(join(tmpdir(), 'charter-dev-door-'));
const app = doorApp({
  offers: async () => OFFERS,
  api: apiFor,
  hosts: new Map(OFFERS.map((o) => [o.hostPubkey, o.ilpBase])),
  ledger: new DoorLedger(join(dir, 'ledger.json')),
  dataDir: dir,
  x402: 'free-for-tests',
});
app.listen(port, '127.0.0.1', () => console.log(`dev door on http://127.0.0.1:${port} (no payments, fake host, interval ${intervalSeconds} s)`));
