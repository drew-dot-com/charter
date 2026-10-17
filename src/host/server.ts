import { randomBytes } from 'node:crypto';
import express from 'express';
import { LeaseError, newLease, onBootFailed, onBooted, onTick } from '../lease.js';
import type { JobSpec, Offer } from '../types.js';
import { RunnerError, type Runner } from './runner.js';
import type { LeaseStore } from './store.js';

export interface HostDeps {
  store: LeaseStore;
  runner: Runner;
  offer: Offer;
  now: () => number;
}

/** Size of one output slice a status call returns. */
export const OUTPUT_PART_BYTES = 48 * 1024;

export function outputPartCount(bytes: number): number {
  return Math.ceil(bytes / OUTPUT_PART_BYTES);
}

const LEASE_ID = /^[0-9a-f]{32}$/;
const NON_NEG_INT = /^\d+$/;

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** `{ job: { image: string, args: { [k]: string } } }`, or null. */
function parseJob(body: unknown): JobSpec | null {
  const job = (body as { job?: unknown } | undefined)?.job;
  if (typeof job !== 'object' || job === null || Array.isArray(job)) return null;
  const { image, args } = job as { image?: unknown; args?: unknown };
  if (typeof image !== 'string' || image === '') return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const entries = Object.entries(args);
  if (!entries.every(([, v]) => typeof v === 'string')) return null;
  return { image, args: Object.fromEntries(entries) as Record<string, string> };
}

function newApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb', type: () => true }));
  return app;
}

/** Last in the chain: unknown paths and methods answer 404, a bad body answers 400. */
function finish(app: express.Express): express.Express {
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal' : 'bad_request' });
  });
  return app;
}

/**
 * The three apps the node puts behind its three priced TOON apps. Each handles
 * exactly one route, so a packet paid for one price can never reach another.
 * Bind each to 127.0.0.1 only.
 */
export function hostApps(deps: HostDeps): { open: express.Express; tick: express.Express; status: express.Express } {
  const { store, runner, offer, now } = deps;
  const intervalMs = offer.intervalSeconds * 1000;

  const open = newApp();
  open.post('/open', async (req, res) => {
    const job = parseJob(req.body);
    if (!job) return void res.status(400).json({ error: 'bad_request' });

    const leaseId = randomBytes(16).toString('hex');
    store.put(newLease(leaseId, offer, job, now()));

    // The packet is paid whatever happens, so a boot failure answers 200 with the reason.
    const fail = async (error: string, stop: boolean) => {
      const cur = store.get(leaseId)!;
      const closed = onBootFailed(cur);
      if (closed !== cur) store.put(closed);
      if (stop) await runner.stop(leaseId).catch(() => undefined);
      res.json({ leaseId, state: 'closed', closedReason: 'boot_failed', error });
    };

    try {
      await runner.start(leaseId, job);
    } catch (e) {
      const refused =
        e instanceof RunnerError && (e.code === 'image_not_allowed' || e.code === 'arg_not_allowed' || e.code === 'bad_input');
      return void (await fail(e instanceof RunnerError ? e.code : 'boot_failed', !refused));
    }

    const cur = store.get(leaseId)!;
    if (cur.state !== 'booting') {
      // The boot timeout closed it while the container was still coming up.
      return void (await fail('boot_timeout', true));
    }
    store.put(onBooted(cur, now()));
    res.json({ leaseId, state: 'awaiting_first_tick' });
  });

  const tick = newApp();
  tick.post('/tick', (req, res) => {
    const { leaseId, index } = (req.body ?? {}) as { leaseId?: unknown; index?: unknown };
    if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) || !isNonNegInt(index)) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    const lease = store.get(leaseId);
    if (!lease) return void res.status(404).json({ error: 'not_found' });
    if (lease.state === 'done') {
      // A job that finished before its first tick: tick 0 is what pays for reading its output.
      if (index !== 0 || lease.paidIntervals !== 0) return void res.status(409).json({ error: 'lease_done' });
      store.put({ ...lease, paidIntervals: 1 });
      return void res.json({ paidIntervals: 1, duplicate: false });
    }
    try {
      const r = onTick(lease, index, now(), intervalMs);
      if (!r.duplicate) store.put(r.lease);
      res.json({ paidIntervals: r.lease.paidIntervals, paidThrough: r.lease.paidThrough, duplicate: r.duplicate });
    } catch (e) {
      if (e instanceof LeaseError) return void res.status(409).json({ error: e.code });
      throw e;
    }
  });

  const status = newApp();
  status.get('/leases/:id', (req, res) => {
    const lease = LEASE_ID.test(req.params.id) ? store.get(req.params.id) : undefined;
    if (!lease) return void res.status(404).json({ error: 'not_found' });
    res.json({ lease });
  });
  status.get('/leases/:id/output/:part', async (req, res) => {
    const lease = LEASE_ID.test(req.params.id) ? store.get(req.params.id) : undefined;
    const parts = lease?.outputParts;
    if (!lease || parts === undefined || !NON_NEG_INT.test(req.params.part)) {
      return void res.status(404).json({ error: 'not_found' });
    }
    if (lease.paidIntervals === 0) return void res.status(409).json({ error: 'unpaid' });
    const part = Number(req.params.part);
    if (!Number.isSafeInteger(part) || part >= parts) return void res.status(404).json({ error: 'not_found' });
    let bytes: Buffer;
    try {
      bytes = await runner.output(lease.id);
    } catch {
      return void res.status(500).json({ error: 'output_unreadable' });
    }
    const slice = bytes.subarray(part * OUTPUT_PART_BYTES, (part + 1) * OUTPUT_PART_BYTES);
    res.json({ part, parts, data: slice.toString('base64') });
  });

  return { open: finish(open), tick: finish(tick), status: finish(status) };
}
