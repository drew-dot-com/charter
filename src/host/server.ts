import { randomBytes } from 'node:crypto';
import express from 'express';
import { homeIdOf, normalizeSshKeys } from '../jobs.js';
import { isHome, LeaseError, newLease, onBootFailed, onBooted, onTick } from '../lease.js';
import type { CloseReason, JobSpec, Lease, Offer } from '../types.js';
import type { HomeStore } from './homes.js';
import { closeAndStop, OUTPUT_PART_BYTES } from './loop.js';
import { RunnerError, type Runner } from './runner.js';
import type { LeaseStore } from './store.js';

export { OUTPUT_PART_BYTES, outputPartCount } from './loop.js';

export interface HostDeps {
  store: LeaseStore;
  runner: Runner;
  offer: Offer;
  now: () => number;
  /** Live leases (booting, awaiting the first tick, running) at once. Default 1. */
  maxLeases?: number;
  /** Live home leases at once, inside maxLeases. Default 0: no homes. */
  maxHomes?: number;
  log?: (msg: string) => void;
  /** The host's home records, so a home closed here is released as the loop releases one. */
  homes?: HomeStore;
  /** The loop's set of published homes, shared so a release here clears it there. */
  published?: Set<string>;
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
  const maxLeases = deps.maxLeases ?? 1;
  const maxHomes = deps.maxHomes ?? 0;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const isLive = (l: Lease): boolean => l.state === 'booting' || l.state === 'awaiting_first_tick' || l.state === 'running';
  const live = (): number => store.all().filter(isLive).length;

  const open = newApp();
  open.post('/open', async (req, res) => {
    const job = parseJob(req.body);
    if (!job) return void res.status(400).json({ error: 'bad_request' });

    const home = isHome({ job });
    const keys = home ? normalizeSshKeys(job.args.SSH_KEYS?.split('\n')) : undefined;
    if (home && !keys) return void res.status(400).json({ error: 'bad_request' });

    const leaseId = randomBytes(16).toString('hex');
    const lease = newLease(leaseId, offer, job, now(), keys ? homeIdOf(keys) : undefined);
    const refuse = (closedReason: CloseReason) => {
      store.put({ ...lease, state: 'closed', closedReason });
      res.json({ leaseId, state: 'closed', closedReason });
    };
    // The counts and the write happen with no await between them, so two opens cannot both pass.
    if (home) {
      const homes = store.all().filter((l) => isLive(l) && isHome(l));
      // One disk, one box: a second lease on the same keys would mount it twice.
      if (homes.some((l) => l.homeId === lease.homeId)) return refuse('home_in_use');
      if (homes.length >= maxHomes) return refuse('busy');
    }
    if (live() >= maxLeases) return refuse('busy');
    store.put(lease);

    // The packet is paid whatever happens, so a boot failure answers 200 with the reason.
    const fail = async (error: string, stop: boolean, detail: string = error) => {
      deps.log?.(`open ${leaseId} boot failed: ${detail}`);
      const cur = store.get(leaseId)!;
      const closed = onBootFailed(cur);
      if (closed !== cur) store.put(closed);
      if (stop) await runner.stop(leaseId).catch(() => undefined);
      res.json({ leaseId, state: 'closed', closedReason: 'boot_failed', error });
    };

    try {
      // The disk comes first: create mounts it.
      if (home) await runner.ensureHome(lease.homeId!);
      // Created, not started: nothing of the job runs until tick 0 is paid.
      await runner.create(leaseId, job);
    } catch (e) {
      const refused =
        e instanceof RunnerError && (e.code === 'image_not_allowed' || e.code === 'arg_not_allowed' || e.code === 'bad_input');
      return void (await fail(e instanceof RunnerError ? e.code : 'boot_failed', !refused, e instanceof Error ? e.message : String(e)));
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
  tick.post('/tick', async (req, res) => {
    const { leaseId, index } = (req.body ?? {}) as { leaseId?: unknown; index?: unknown };
    if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId) || !isNonNegInt(index)) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    const lease = store.get(leaseId);
    if (!lease) return void res.status(404).json({ error: 'not_found' });
    // A job only runs once tick 0 is paid, so a done lease always has its ticks: nothing more is owed.
    if (lease.state === 'done') return void res.status(409).json({ error: 'lease_done' });
    let r: ReturnType<typeof onTick>;
    try {
      r = onTick(lease, index, now(), intervalMs);
    } catch (e) {
      if (e instanceof LeaseError) return void res.status(409).json({ error: e.code });
      throw e;
    }
    const answer = { paidIntervals: r.lease.paidIntervals, paidThrough: r.lease.paidThrough, duplicate: r.duplicate };
    if (r.duplicate) return void res.json(answer);
    // Written before the start, so a repeat of tick 0 meanwhile is a duplicate, not a second start.
    store.put(r.lease);
    const homeId = isHome(lease) ? lease.homeId! : undefined;
    if (homeId) {
      // The tick is paid, so it answers 200 even if the box cannot be told how long it has.
      await runner.writePaidThrough(homeId, r.lease.paidThrough!).catch((e) => log(`home ${homeId}: paid time not written: ${String(e)}`));
    }
    if (lease.state === 'awaiting_first_tick') {
      // Interval 0 is paid: only now does the job start.
      try {
        await runner.start(leaseId);
      } catch {
        // Tick 0 is paid, so a home keeps its disk as paid: the loop's close and release, not a bare close.
        const loopDeps = { store, runner, now, log, ...(deps.homes ? { homes: deps.homes } : {}), ...(deps.published ? { published: deps.published } : {}) };
        await closeAndStop(loopDeps, store.get(leaseId)!, 'boot_failed', now());
        return void res.status(409).json({ error: 'not_running' });
      }
      const cur = store.get(leaseId)!;
      if (cur.state !== 'running') {
        await runner.stop(leaseId).catch(() => undefined);
        return void res.status(409).json({ error: 'not_running' });
      }
      store.put({ ...cur, startedAt: now() });
      if (homeId) {
        // The box is running; a later window tick retries a failed publish.
        try {
          await runner.publishHome(homeId);
        } catch (e) {
          log(`home ${homeId}: onion not published: ${String(e)}`);
        }
      }
    }
    res.json(answer);
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
