import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { HostError, type HostApi, type OpenResult } from '../tenant/host-api.js';
import { findOfferExact } from '../tenant/offers.js';
import { JOB_IMAGES, jobFromBody } from '../jobs.js';
import type { JobSpec, Lease, Micro, Offer } from '../types.js';
import { DeadlinePassedError, SendTimeoutError } from '../payer.js';
import { offerOfSnapshot, snapshotOffer, type DoorLedger, type LossKind } from './ledger.js';
import { logRequests, type RequestSink } from './reqlog.js';
import { MAX_TIMEOUT_SECONDS, MIN_WINDOW_SECONDS, SETTLE_MARGIN_SECONDS, isPayerFault, microToUsdc, paymentIdOf, realGate, settleReasonOf, stubGate, type Gate, type PaymentId, type Schemes, type TestHooks, type X402Config } from './x402.js';
import { openApiDoc } from './openapi.js';

export interface DoorDeps {
  /** Live offers. The door caches the answer for 60 s. */
  offers: () => Promise<Offer[]>;
  api: (o: Offer) => HostApi;
  /**
   * CHARTER_DOOR_HOSTS: the hosts the door pays, host pubkey to its ILP address. An offer is listed and
   * opened only when its signer and its ilpBase are both on this list.
   */
  hosts: ReadonlyMap<string, string>;
  /**
   * What the door's open x402 channel can still pay, in micro-USDC, as its TOON client records it;
   * undefined when no channel is open. A tick is refused while it is under tickPrice + HEADROOM_MARGIN,
   * so a tick never waits on a channel open inside its payment window, and an open while it is under
   * openPrice + tickPrice + HEADROOM_MARGIN, so a new lease can pay its open and its first tick. Left out: no check.
   */
  headroom?: () => Promise<Micro | undefined>;
  /**
   * Opens the door's channel when `headroom` finds none (a boot-time open that failed). Started at most
   * once a minute and never awaited by a request. Left out: only a restart opens one.
   */
  reopen?: () => Promise<void>;
  ledger: DoorLedger;
  x402: X402Config | 'free-for-tests';
  /** The x402 schemes built from `x402`, when the caller also runs the claim timers on them. Default: built here. */
  schemes?: Schemes;
  /** Offer `batch-settlement` on ticks. Default true; false when the facilitator does not list it (facilitatorOffersBatch). */
  offerBatch?: boolean;
  /**
   * Whether the payer of this batch channel has asked to withdraw it (the door's channel record, synced from
   * chain). Its vouchers are refused: the payer could take the balance back after the withdraw delay. Default: from `schemes`.
   */
  withdrawing?: (channelId: string) => Promise<boolean>;
  /** Epoch ms. */
  now?: () => number;
  /** The door's data directory: output parts are kept under `output/` here. */
  dataDir: string;
  /** Where the built web page lives. Default: `web/dist` beside the package. */
  webDir?: string;
  /** Express `trust proxy`, for a door behind a reverse proxy (the rate limit keys on the client IP). */
  trustProxy?: boolean | number | string;
  /** The operator's email for `info.contact` in /openapi.json (indexes verify ownership with it). Unset: the repo's issues URL only. */
  contactEmail?: string;
  /** Told of each request when its response finishes (reqlog.ts says what an entry holds). Left out: nothing is logged. */
  requestSink?: RequestSink;
  /** Only read when `x402` is 'free-for-tests'. */
  testHooks?: TestHooks;
}

const OFFERS_TTL_MS = 60_000;
const STATUS_TTL_MS = 5_000;
/** Paid host reads a lease's free GET routes may cause: this, plus READS_PER_TICK for each tick the renter paid, plus READS_PER_PAID_MINUTE for each minute those ticks bought. */
const READS_BASE = 40;
const READS_PER_TICK = 8;
export const READS_PER_PAID_MINUTE = 1;

/** The free host reads a lease has earned: a short interval gets them by the tick, a long one gets a read a minute to watch the job finish. */
export function readBudget(ticks: number, intervalSeconds: number): number {
  return READS_BASE + READS_PER_TICK * ticks + Math.floor((ticks * intervalSeconds) / 60) * READS_PER_PAID_MINUTE;
}
/** A done lease with paid intervals and no landing yet is read from the host again after this long, at most. */
const LANDING_REFRESH_MS = 10 * 60_000;
const GETS_PER_MINUTE = 120;
const TICKS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;
const OPENS_PER_HOUR = 10;
/** Leases `GET /v1/recent` lists. */
const RECENT_LEASES = 12;
const HOUR_MS = 3_600_000;
/** Opens across every IP in an hour. */
export const DOOR_OPENS_PER_HOUR = 30;
/** Door spend no renter paid for (opens, free reads, losses) in one UTC day, in micro-USDC. Past it: 503 capacity. */
export const DAILY_UNPAID_CAP: Micro = 500_000n;
/** The most the door pays for an offer's open, status read and tick, in micro-USDC. A pricier offer is not listed. */
export const MAX_OPEN_PRICE: Micro = 10_000n;
export const MAX_STATUS_PRICE: Micro = 1_000n;
export const MAX_TICK_PRICE: Micro = 50_000n;
/** Channel headroom a tick needs beyond its own price. */
export const HEADROOM_MARGIN: Micro = 10_000n;
const LEASE_ID = /^[0-9a-f]{32}$/;
const NON_NEG_INT = /^\d+$/;

const EXPOSED = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE';
const ALLOWED = 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT';

/** At most `max` hits per key within `windowMs`. Counts the attempt it allows. */
function slidingLimit(now: () => number, max: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key) => {
    const t = now();
    if (hits.size > 256) {
      for (const [k, v] of hits) if (v[v.length - 1]! <= t - windowMs) hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    const ok = recent.length < max;
    if (ok) recent.push(t);
    hits.set(key, recent);
    return ok;
  };
}

/** An offer as the door shows it: what `GET /v1/offers` lists, and what a lease's status carries. */
function publicOffer(o: Offer) {
  return {
    offerId: `${o.hostPubkey}:${o.id}`,
    cpu: o.cpu,
    memoryMiB: o.memoryMiB,
    intervalSeconds: o.intervalSeconds,
    tickPrice: o.tickPrice.toString(),
    images: o.images,
    hiddenHost: o.hiddenHost,
    hiddenEgress: o.hiddenEgress,
    expiresAt: o.expiresAt,
    ...(o.home ? { home: o.home } : {}),
  };
}

/** The lease's free-read budget is spent. */
class BudgetError extends Error {}

/** The door's daily cap on spend no renter paid for is reached. */
class CapacityError extends Error {}

function final(l: Lease): boolean {
  return l.state === 'done' || l.state === 'closed';
}

/** A host's error text, kept short: it is shown to a stranger. */
function hostMessage(e: unknown): string {
  if (e instanceof SendTimeoutError) return 'host_timeout';
  return e instanceof HostError ? e.error.slice(0, 64) : 'host_unreachable';
}

export function doorApp(deps: DoorDeps): express.Express {
  const { ledger } = deps;
  const now = deps.now ?? Date.now;
  const webDir = deps.webDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

  /** The offer a lease was opened on, from the ledger's snapshot: a price or a host call never depends on the relay still listing it. */
  const leaseOffer = (leaseId: string): Offer => offerOfSnapshot(ledger.get(leaseId)!.offer);
  const priceOf = (leaseId: string): Micro | undefined => (ledger.get(leaseId) ? leaseOffer(leaseId).tickPrice : undefined);
  const withdrawing: (channelId: string) => Promise<boolean> =
    deps.withdrawing ?? (deps.schemes ? async (id) => ((await deps.schemes!.batch.getStorage().get(id))?.withdrawRequestedAt ?? 0) > 0 : async () => false);
  /**
   * The offer each paid rent was guarded against, keyed by its parsed body, so the gate prices exactly the
   * offer the handler opens on. A body with no entry (a bare probe) is priced from the offers as they stand.
   */
  const rentPicks = new WeakMap<object, Offer>();
  const rentPriceOf = async (body: unknown): Promise<Micro | undefined> => {
    if (typeof body === 'object' && body !== null && rentPicks.has(body)) return rentPicks.get(body)!.tickPrice;
    const pick = pickRentOffer(await offers(), body);
    return typeof pick === 'string' ? undefined : pick.offer.tickPrice;
  };
  const gate: Gate =
    deps.x402 === 'free-for-tests' ? stubGate(priceOf, deps.testHooks) : realGate(deps.x402, priceOf, deps.schemes, deps.offerBatch ?? true, rentPriceOf);

  let offersCache: { at: number; p: Promise<Offer[]> } | undefined;
  const offers = (): Promise<Offer[]> => {
    if (offersCache && now() - offersCache.at < OFFERS_TTL_MS) return offersCache.p;
    const entry = { at: now(), p: deps.offers() };
    offersCache = entry;
    entry.p.catch(() => {
      if (offersCache === entry) offersCache = undefined;
    });
    return entry.p;
  };

  /** An offer from a host on CHARTER_DOOR_HOSTS, at its ILP address there, within the door's price maxima. */
  const trusted = (o: Offer): boolean =>
    deps.hosts.get(o.hostPubkey) === o.ilpBase &&
    o.openPrice <= MAX_OPEN_PRICE &&
    o.statusPrice <= MAX_STATUS_PRICE &&
    o.tickPrice <= MAX_TICK_PRICE;
  const overCap = (): boolean => ledger.unpaidToday(now()) >= DAILY_UNPAID_CAP;
  /** Offers a renter can open a job on now: trusted, unexpired, carrying a job image. */
  const rentable = (list: Offer[]): Offer[] => list.filter((o) => trusted(o) && o.expiresAt > now() && o.images.some((i) => JOB_IMAGES.includes(i)));

  /**
   * The offer a rent body opens on, and its job (null for an empty body: a probe, priced at the default).
   * A named offerId must be listed; with none, the cheapest offer that runs the job, ties by offerId.
   */
  const pickRentOffer = (list: Offer[], body: unknown): { offer: Offer; job: JobSpec | null } | 'bad_request' | 'not_found' | 'image_not_offered' => {
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) return 'bad_request';
    const b = (body ?? {}) as { offerId?: unknown; urls?: unknown; python?: unknown; home?: unknown };
    const empty = Object.keys(b).length === 0;
    const job = empty ? null : jobFromBody(b);
    if (!empty && (!job || (b.offerId !== undefined && typeof b.offerId !== 'string'))) return 'bad_request';
    const open = rentable(list);
    if (typeof b.offerId === 'string') {
      const o = findOfferExact(open, b.offerId);
      if (!o) return 'not_found';
      if (job && !o.images.includes(job.image)) return 'image_not_offered';
      return { offer: o, job };
    }
    const fits = open
      .filter((o) => !job || o.images.includes(job.image))
      .sort((x, y) => (x.tickPrice === y.tickPrice ? (`${x.hostPubkey}:${x.id}` < `${y.hostPubkey}:${y.id}` ? -1 : 1) : x.tickPrice < y.tickPrice ? -1 : 1));
    return fits[0] ? { offer: fits[0], job } : 'not_found';
  };
  /** Runs a host call and books whatever it cost the door as spend no renter paid for. */
  const unpaid = async <T>(api: HostApi, fn: () => Promise<T>): Promise<T> => {
    const before = api.spent();
    try {
      return await fn();
    } finally {
      ledger.addUnpaid(api.spent() - before, now());
    }
  };

  const allowOpen = slidingLimit(now, OPENS_PER_HOUR, HOUR_MS);
  const allowDoorOpen = slidingLimit(now, DOOR_OPENS_PER_HOUR, HOUR_MS);
  const allowGet = slidingLimit(now, GETS_PER_MINUTE, MINUTE_MS);
  const allowTick = slidingLimit(now, TICKS_PER_MINUTE, MINUTE_MS);

  /** What the door last read from the host for each lease, and any read in flight. */
  const statuses = new Map<string, { lease: Lease; at: number }>();
  const statusInflight = new Map<string, Promise<Lease>>();
  const partInflight = new Map<string, Promise<unknown>>();
  /** Leases with a tick in flight: one at a time. */
  const ticking = new Set<string>();
  /** Payment keys claimed by a request that has not finished verifying. */
  const claimed = new Set<string>();
  /** When the operator was last told the channel is too low for ticks (epoch ms). */
  let lowHeadroomWarnedAt = -Infinity;
  let reopenTriedAt = -Infinity;
  /**
   * True when the door's channel cannot pay `need` (or its headroom is unknown). Logs at most once a minute,
   * so the operator sees the channel needs replacing (docs/demo.md, channel rotation).
   */
  const headroomShort = async (need: Micro, what: string): Promise<boolean> => {
    if (!deps.headroom) return false;
    let left: Micro | undefined;
    try {
      left = await deps.headroom();
    } catch {
      left = undefined;
    }
    if (left !== undefined && left >= need) return false;
    if (left === undefined && deps.reopen && now() - reopenTriedAt >= MINUTE_MS) {
      reopenTriedAt = now();
      deps.reopen().catch((e) => console.error(`charter-door: could not open its channel: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`));
    }
    if (now() - lowHeadroomWarnedAt >= MINUTE_MS) {
      lowHeadroomWarnedAt = now();
      console.error(`charter-door: channel headroom ${left === undefined ? 'unknown (no open channel?)' : left.toString()} is under ${need}; ${what} wait until the channel is replaced`);
    }
    return true;
  };

  const partFile = (id: string, part: number): string => join(deps.dataDir, 'output', id, `${part}.json`);

  /** Spends one of the lease's paid host reads, or throws BudgetError (or CapacityError past the daily cap). */
  const spendRead = (id: string): void => {
    if (overCap()) throw new CapacityError();
    const rec = ledger.get(id)!;
    if (rec.hostReads >= readBudget(rec.ticksPaidByRenter, offerOfSnapshot(rec.offer).intervalSeconds)) throw new BudgetError();
    ledger.read(id);
  };

  /**
   * The host's lease, from memory while fresh (for good once done or closed) and
   * otherwise one paid status call within the lease's budget. A spent budget serves
   * the last answer, however old.
   */
  const leaseStatus = (id: string): Promise<Lease> => {
    const last = statuses.get(id);
    if (last && now() - last.at < STATUS_TTL_MS) return Promise.resolve(last.lease);
    // A final status is kept for good, except that the host records a landing after a lease is done.
    const awaitingLanding = last !== undefined && last.lease.state === 'done' && last.lease.paidIntervals > 0 && !last.lease.landing;
    if (last && final(last.lease) && !(awaitingLanding && now() - last.at >= LANDING_REFRESH_MS)) return Promise.resolve(last.lease);
    const running = statusInflight.get(id);
    if (running) return running;
    try {
      spendRead(id);
    } catch (e) {
      return last ? Promise.resolve(last.lease) : Promise.reject(e);
    }
    const p = (async () => {
      try {
        const api = deps.api(leaseOffer(id));
        const lease = await unpaid(api, () => api.status(id));
        statuses.set(id, { lease, at: now() });
        return lease;
      } catch (e) {
        // A failed look at a finished lease changes nothing, and is not repeated for another 10 minutes.
        if (last && final(last.lease)) {
          statuses.set(id, { lease: last.lease, at: now() });
          return last.lease;
        }
        throw e;
      }
    })();
    statusInflight.set(id, p);
    const clear = () => void statusInflight.delete(id);
    p.then(clear, clear);
    return p;
  };

  /** Answer for a failed free read: the host's 404 and 409 pass through, anything else is a 502. */
  const readFailure = (res: express.Response, e: unknown): void => {
    if (e instanceof HostError && (e.status === 404 || e.status === 409)) {
      res.status(e.status).json({ error: hostMessage(e) });
      return;
    }
    res.status(502).json({ error: hostMessage(e) });
  };

  const app = express();
  app.disable('x-powered-by');
  if (deps.trustProxy !== undefined) app.set('trust proxy', deps.trustProxy);
  if (deps.requestSink) app.use(logRequests(deps.requestSink, now));

  // A browser on another origin may read offers and leases and pay ticks. The payment headers go both ways.
  // Opening a lease is same-origin only (the page is served from here): no CORS on POST /v1/leases.
  app.use('/v1', (req, res, next) => {
    if (/^\/leases\/?$/.test(req.path)) return next();
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', EXPOSED);
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', ALLOWED);
      res.set('Access-Control-Max-Age', '600');
      return void res.status(204).end();
    }
    next();
  });
  // A POST must say it is JSON. A cross-origin form or a text/plain fetch cannot, without a preflight.
  // A bare probe of the rent route (no payment, no body: what an x402 index sends) is let through to its 402.
  app.use((req, res, next) => {
    const bareRentProbe = req.path === '/v1/rent' && deps.x402 !== 'free-for-tests' && paymentIdOf(req) === 'none' && !req.headers['content-type'];
    if (req.method === 'POST' && !req.is('application/json') && !bareRentProbe) return void res.status(415).json({ error: 'unsupported_media_type' });
    next();
  });
  // A python job carries a script of up to 8 KiB, which JSON escaping can grow.
  app.use(express.json({ limit: '32kb', type: () => true }));

  // Only a door with no payment gate (local development) answers this, so the page knows to skip x402.
  if (deps.x402 === 'free-for-tests') app.get('/v1/dev', (_req, res) => void res.json({ dev: true }));

  // Where payments go, so the page can refuse a payment request that names any other payee.
  if (deps.x402 !== 'free-for-tests') {
    const { payTo, network } = deps.x402;
    app.get('/v1/door', (_req, res) => void res.json({ payTo, network }));
  }

  /** What the door's ledger says about a host: leases with a renter-paid interval, and the newest one. */
  const hostStats = (hostPubkey: string): { leases: number; lastLeaseAt?: number } => {
    let leases = 0;
    let lastLeaseAt: number | undefined;
    for (const l of ledger.all()) {
      if (l.ticksPaidByRenter === 0 || !l.offerId.startsWith(`${hostPubkey}:`)) continue;
      leases++;
      if (lastLeaseAt === undefined || l.createdAt > lastLeaseAt) lastLeaseAt = l.createdAt;
    }
    return { leases, ...(lastLeaseAt === undefined ? {} : { lastLeaseAt }) };
  };

  app.get('/v1/offers', async (_req, res) => {
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    res.json(
      list
        .filter((o) => trusted(o) && o.images.some((i) => JOB_IMAGES.includes(i)) && o.expiresAt > now())
        .map((o) => ({ ...publicOffer(o), ...hostStats(o.hostPubkey) })),
    );
  });

  // The newest leases a renter paid for, from the ledger: a short id (a full id reads the lease), the
  // payer, and the state and landing the door last saw, never a paid host read.
  app.get('/v1/recent', (_req, res) => {
    const rows = ledger
      .all()
      .filter((l) => l.ticksPaidByRenter > 0)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RECENT_LEASES)
      .map((l) => {
        const seen = statuses.get(l.leaseId)?.lease;
        return {
          id: l.leaseId.slice(0, 8),
          createdAt: l.createdAt,
          ticks: l.ticksPaidByRenter,
          ...(l.payer ? { payer: l.payer } : {}),
          ...(seen ? { state: seen.state } : {}),
          ...(seen?.landing ? { landing: seen.landing } : {}),
        };
      });
    res.json(rows);
  });

  app.post('/v1/leases', async (req, res) => {
    if (!allowOpen(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as { offerId?: unknown; urls?: unknown; python?: unknown; home?: unknown }; // home: { sshKeys, image? }
    const { offerId } = body;
    const job = jobFromBody(body);
    if (typeof offerId !== 'string' || !job) return void res.status(400).json({ error: 'bad_request' });
    let offer: Offer | undefined;
    try {
      offer = findOfferExact((await offers()).filter(trusted), offerId);
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    if (!offer || offer.expiresAt <= now()) return void res.status(404).json({ error: 'not_found' });
    if (!offer.images.includes(job.image)) return void res.status(400).json({ error: 'image_not_offered' });
    // Door-wide: an open costs the door and no renter pays for it.
    if (overCap() || !allowDoorOpen('door')) return void res.status(503).json({ error: 'capacity' });
    // A lease the channel cannot carry through its open and first tick is not started.
    if (await headroomShort(offer.openPrice + offer.tickPrice + HEADROOM_MARGIN, 'opens')) {
      return void res.status(503).json({ error: 'capacity' });
    }

    try {
      const api = deps.api(offer);
      const r = await unpaid(api, () => api.open(job));
      if (!LEASE_ID.test(r.leaseId) || ledger.get(r.leaseId)) return void res.status(502).json({ error: 'bad_host_answer' });
      ledger.open({ leaseId: r.leaseId, offerId, createdAt: now(), offer: snapshotOffer(offer) });
      res.json({
        leaseId: r.leaseId,
        state: r.state,
        ...(r.closedReason ? { closedReason: r.closedReason } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (e) {
      res.status(502).json({ error: hostMessage(e) });
    }
  });

  /** Everything that can be refused before the renter is asked to pay. */
  const tickGuard: express.RequestHandler = async (req, res, next) => {
    if (!allowTick(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
    // A tick costs the door a status read no renter pays for, and may cost it a loss.
    if (overCap()) return void res.status(503).json({ error: 'capacity' });
    const id = req.params.id as string;
    const rec = LEASE_ID.test(id) ? ledger.get(id) : undefined;
    if (!rec) return void res.status(404).json({ error: 'not_found' });
    const index = (req.body as { index?: unknown } | undefined)?.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    // The checks and the claim on the lease happen together, with no await before next().
    if (rec.stopped) return void res.status(409).json({ error: 'stopped' });
    // The host already said this lease is over: a tick would only cost the door.
    const seen = statuses.get(id)?.lease.state;
    if (seen === 'done') return void res.status(409).json({ error: 'lease_done' });
    if (seen === 'closed') return void res.status(409).json({ error: 'not_running' });
    if (index !== rec.nextIndex) return void res.status(409).json({ error: 'out_of_order', expected: rec.nextIndex });
    if (ticking.has(id)) return void res.status(409).json({ error: 'busy' });
    const payment = admitPayment(req, res);
    if (payment === undefined) return;
    ticking.add(id);
    // The one check that reads a file comes after the claim on the lease, which `ticking` holds meanwhile.
    if (payment !== 'none' && payment.kind === 'batch' && (await withdrawing(payment.channelId))) {
      ticking.delete(id);
      return void res.status(409).json({ error: 'channel_withdrawing' });
    }
    res.locals.offer = offerOfSnapshot(rec.offer);
    res.locals.index = index;
    next();
  };

  /**
   * The payment checks every paid route makes before its gate: one decodable header, a window that outlasts
   * verify-to-settle, an exact authorization not already used (claimed here, given back by `booked`). Sets
   * `payer`, `paymentKey` and `deadline` on res.locals. Undefined when it has answered the request itself.
   */
  const admitPayment = (req: express.Request, res: express.Response): PaymentId | 'none' | undefined => {
    // A payment is the authorization it carries, not the bytes of the header that carries it.
    const payment = paymentIdOf(req);
    if (payment === 'bad') return void res.status(400).json({ error: 'bad_payment' });
    // Who pays, for the ledger and the payer block, whichever scheme carries it.
    if (payment !== 'none') res.locals.payer = payment.from;
    if (payment !== 'none' && payment.kind === 'batch') {
      // A cumulative voucher is not a one-shot payment: the scheme's channel state accepts or refuses it,
      // and a voucher re-sent after a refused tick is the right next voucher. A deposit, though, moves
      // USDC by an authorization with a window, which must outlast verify-to-settle as an exact one must.
      const t = Math.floor(now() / 1000);
      if (payment.validBefore !== undefined && ((payment.validAfter ?? 0) > t || payment.validBefore < t + MIN_WINDOW_SECONDS)) {
        return void res.status(400).json({ error: 'authorization_window' });
      }
      res.locals.deadline = ((payment.validBefore ?? t + MAX_TIMEOUT_SECONDS) - SETTLE_MARGIN_SECONDS) * 1000;
    } else if (payment !== 'none') {
      const t = Math.floor(now() / 1000);
      if (payment.validAfter > t || payment.validBefore < t + MIN_WINDOW_SECONDS) {
        return void res.status(400).json({ error: 'authorization_window' });
      }
      const key = createHash('sha256').update(`${payment.from}:${payment.nonce}`).digest('hex');
      // Claimed from here: refused while another request holds it or once it has verified. A verify
      // failure gives it back (paidTick), so an honest retry of a payment the facilitator refused works.
      if (claimed.has(key) || ledger.hasPayment(key)) return void res.status(409).json({ error: 'payment_reused' });
      claimed.add(key);
      res.locals.paymentKey = key;
      // The host tick must be over in time for the payment to settle before it lapses.
      res.locals.deadline = (payment.validBefore - SETTLE_MARGIN_SECONDS) * 1000;
    }
    return payment;
  };

  /** Runs the payment gate, then books the outcome once the response is final. `release` frees what the guard held. */
  const booked = (release: (req: express.Request, res: express.Response) => void): express.RequestHandler => async (req, res, next) => {
    let failure: unknown;
    try {
      await gate(req, res, next);
    } catch (e) {
      failure = e;
    } finally {
      release(req, res);
      if (res.locals.paymentKey) claimed.delete(res.locals.paymentKey as string);
    }
    const paid = res.locals.hostPaid as { leaseId: string; price: Micro } | undefined;
    if (paid) {
      if (!failure && res.statusCode >= 200 && res.statusCode < 300) {
        ledger.renterTick(paid.leaseId, res.locals.payer as string | undefined);
      } else {
        // The host has its tick and the renter's payment never settled. Only the payer's own fault counts against them.
        const kind: LossKind = !failure && isPayerFault(settleReasonOf(res)) ? 'settle_failed' : 'settle_failed_transient';
        ledger.loss(paid.leaseId, paid.price, kind, now(), res.locals.payer as string | undefined);
        ledger.stop(paid.leaseId);
      }
    }
    if (failure) throw failure;
  };

  const paidTick = booked((req) => void ticking.delete(req.params.id as string));

  /**
   * Run first by every paid handler: the payment has verified, so from now on it is spent, whatever happens
   * next, and the payer is known. One that cost the door before does not cost it again. False when answered.
   */
  const verified = (res: express.Response): boolean => {
    if (res.locals.paymentKey) ledger.addPayment(res.locals.paymentKey as string);
    const payer = res.locals.payer as string | undefined;
    if (payer && ledger.payerHasLoss(payer, now())) return void res.status(403).json({ error: 'payer_blocked' }), false;
    return true;
  };

  const tick: express.RequestHandler = async (req, res) => {
    const id = req.params.id as string;
    const offer = res.locals.offer as Offer;
    if (!verified(res)) return;
    // A channel too low for this tick would be replaced inside the tick's send, past its payment window.
    // Nothing is sent and the renter's payment does not settle: the renter signs again.
    if (await headroomShort(offer.tickPrice + HEADROOM_MARGIN, 'ticks')) return void res.status(503).json({ error: 'retry_later' });
    const api = deps.api(offer);
    const deadline = res.locals.deadline as number | undefined;
    const sendOpts = deadline === undefined ? {} : { deadline };
    // The cached status may be up to 5 s old. One fresh read, just before paying, so a lease that has just
    // finished or closed is not paid a tick: the renter's payment then does not settle either.
    let fresh: Lease;
    try {
      fresh = await unpaid(api, () => api.status(id, { priority: 'high', ...sendOpts }));
    } catch (e) {
      if (e instanceof DeadlinePassedError) return void res.status(503).json({ error: 'retry_later' });
      return void res.status(502).json({ error: hostMessage(e) });
    }
    statuses.set(id, { lease: fresh, at: now() });
    if (fresh.state === 'done') return void res.status(409).json({ error: 'lease_done' });
    if (fresh.state === 'closed') return void res.status(409).json({ error: 'not_running' });
    await payHostTick(res, api, id, res.locals.index as number, offer, (t) => t);
  };

  /**
   * Pays the host one tick and answers the renter: `answer` shapes a 2xx body, and `extra` rides on every
   * error body. Books a host tick, or a loss when the host took the door's money and counted nothing.
   */
  const payHostTick = async (
    res: express.Response,
    api: HostApi,
    id: string,
    index: number,
    offer: Offer,
    answer: (t: Awaited<ReturnType<HostApi['tick']>>) => object,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const payer = res.locals.payer as string | undefined;
    const deadline = res.locals.deadline as number | undefined;
    const before = api.spent();
    try {
      const t = await api.tick(id, index, deadline === undefined ? {} : { deadline });
      if (t.duplicate) {
        // The host already counted this index: it was paid for nothing, and the renter is not charged.
        const lost = api.spent() - before;
        if (lost > 0n) ledger.loss(id, lost, 'host_refused', now(), payer);
        ledger.stop(id);
        return void res.status(409).json({ error: 'duplicate', ...extra });
      }
      ledger.hostTick(id);
      res.locals.hostPaid = { leaseId: id, price: offer.tickPrice };
      res.status(200).json(answer(t));
    } catch (e) {
      // The send waited too long to start: nothing was sent, nothing is owed, and the renter's payment
      // will not settle (non-2xx). The renter retries the same index with a fresh authorization.
      if (e instanceof DeadlinePassedError) return void res.status(503).json({ error: 'retry_later', ...extra });
      // A host that answered, even with an error, took the door's money. It will not be paid again.
      // A send that timed out may have been paid, though nothing was counted.
      const lost = e instanceof SendTimeoutError ? offer.tickPrice : api.spent() - before;
      if (lost > 0n) {
        ledger.loss(id, lost, 'host_refused', now(), payer);
        ledger.stop(id);
      }
      if (e instanceof HostError && e.status === 409 && (e.error === 'lease_done' || e.error === 'not_running')) {
        return void res.status(409).json({ error: e.error, ...extra });
      }
      res.status(502).json({ error: hostMessage(e), ...extra });
    }
  };

  app.post('/v1/leases/:id/ticks', tickGuard, paidTick, tick);

  // POST /v1/rent: open a lease and pay its first tick in one x402 call. The open is the same as
  // POST /v1/leases; the tick the same as the tick route's index 0, with no status read first (a lease
  // just opened cannot have finished). A failure after the open leaves the lease for the tick route.

  /** Payers with a rent in flight: one at a time, so one batch voucher cannot open two leases at once. */
  const renting = new Set<string>();

  const rentGuard: express.RequestHandler = async (req, res, next) => {
    const payment = deps.x402 === 'free-for-tests' ? undefined : paymentIdOf(req);
    const body: unknown = req.body;
    const empty = body === undefined || (typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).length === 0);
    // Unpaid: answer the 402 challenge, after refusing what paying would not fix. Nothing opens, nothing is
    // counted. The gate answers 402 itself to a request with no payment; it never reaches a handler.
    const challenge = payment === 'none';
    if (!challenge) {
      if (!allowOpen(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
      if (empty) return void res.status(400).json({ error: 'bad_request' });
    }
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    const pick = pickRentOffer(list, body);
    if (pick === 'not_found') return void res.status(404).json({ error: 'not_found' });
    if (typeof pick === 'string') return void res.status(400).json({ error: pick });
    const { offer, job } = pick;
    if (overCap()) return void res.status(503).json({ error: 'capacity' });
    if (await headroomShort(offer.openPrice + offer.tickPrice + HEADROOM_MARGIN, 'opens')) return void res.status(503).json({ error: 'capacity' });
    if (challenge) {
      if (typeof body === 'object' && body !== null) rentPicks.set(body, offer);
      return void (await gate(req, res, () => void res.status(402).json({ error: 'payment_required' })));
    }
    // Door-wide: an open costs the door and no renter pays for it unless the tick settles.
    if (!allowDoorOpen('door')) return void res.status(503).json({ error: 'capacity' });
    const admitted = admitPayment(req, res);
    if (admitted === undefined) return;
    const payer = res.locals.payer as string | undefined;
    if (payer !== undefined) {
      if (renting.has(payer)) {
        if (res.locals.paymentKey) claimed.delete(res.locals.paymentKey as string);
        return void res.status(409).json({ error: 'busy' });
      }
      renting.add(payer);
      res.locals.rentPayer = payer;
    }
    const release = () => {
      if (payer !== undefined) renting.delete(payer);
      if (res.locals.paymentKey) claimed.delete(res.locals.paymentKey as string);
    };
    let withdrawn = false;
    try {
      withdrawn = admitted !== 'none' && admitted.kind === 'batch' && (await withdrawing(admitted.channelId));
    } catch (e) {
      // An unreadable channel record must not leave this payer stuck at 409 busy.
      release();
      throw e;
    }
    if (withdrawn) {
      release();
      return void res.status(409).json({ error: 'channel_withdrawing' });
    }
    rentPicks.set(body as object, offer);
    res.locals.offer = offer;
    res.locals.job = job;
    next();
  };

  const paidRent = booked((_req, res) => {
    if (res.locals.rentPayer !== undefined) renting.delete(res.locals.rentPayer as string);
    if (res.locals.leaseId !== undefined) ticking.delete(res.locals.leaseId as string);
  });

  const rent: express.RequestHandler = async (_req, res) => {
    const offer = res.locals.offer as Offer;
    const job = res.locals.job as JobSpec;
    if (!verified(res)) return;
    const api = deps.api(offer);
    let r: OpenResult;
    try {
      r = await unpaid(api, () => api.open(job));
    } catch (e) {
      return void res.status(502).json({ error: hostMessage(e) });
    }
    if (!LEASE_ID.test(r.leaseId) || ledger.get(r.leaseId)) return void res.status(502).json({ error: 'bad_host_answer' });
    const leaseId = r.leaseId;
    ledger.open({ leaseId, offerId: `${offer.hostPubkey}:${offer.id}`, createdAt: now(), offer: snapshotOffer(offer) });
    res.locals.leaseId = leaseId;
    // The tick route waits for this one: the lease is the rent's until it answers.
    ticking.add(leaseId);
    if (r.state !== 'awaiting_first_tick') {
      return void res.status(502).json({
        error: r.closedReason ?? 'not_running',
        leaseId,
        state: r.state,
        ...(r.closedReason ? { closedReason: r.closedReason } : {}),
        ...(r.error ? { detail: r.error } : {}),
      });
    }
    await payHostTick(
      res,
      api,
      leaseId,
      0,
      offer,
      (t) => ({ leaseId, state: 'running', ...t, next: { path: `/v1/leases/${leaseId}/ticks`, index: 1 }, offer: publicOffer(offer) }),
      { leaseId },
    );
  };

  app.post('/v1/rent', rentGuard, paidRent, rent);

  // What an x402 index (x402scan) reads to list the door: the paid rent route and the free routes.
  app.get('/openapi.json', async (_req, res) => {
    let prices: Micro[] = [];
    try {
      prices = rentable(await offers()).map((o) => o.tickPrice);
    } catch {
      // No offers to read: the document still describes the routes, priced as a range up to the door's maximum.
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.json(openApiDoc(prices, MAX_TICK_PRICE, microToUsdc, deps.contactEmail));
  });

  /** The ledger's lease id, or a 404 written to `res`. */
  const known = (req: express.Request, res: express.Response): string | undefined => {
    const id = req.params.id as string;
    if (LEASE_ID.test(id) && ledger.get(id)) return id;
    res.status(404).json({ error: 'not_found' });
    return undefined;
  };

  const failRead = (res: express.Response, e: unknown): void => {
    if (e instanceof BudgetError) return void res.status(429).json({ error: 'rate_limited' });
    if (e instanceof CapacityError) return void res.status(503).json({ error: 'capacity' });
    readFailure(res, e);
  };

  app.use('/v1/leases', (req, res, next) => {
    if (req.method === 'GET' && !allowGet(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
    next();
  });

  app.get('/v1/leases/:id', async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    try {
      const lease = await leaseStatus(id);
      const rec = ledger.get(id);
      res.json({ lease, stopped: rec?.stopped ?? false, ...(rec ? { offer: publicOffer(offerOfSnapshot(rec.offer)) } : {}) });
    } catch (e) {
      failRead(res, e);
    }
  });

  app.get('/v1/leases/:id/output/:part', async (req, res) => {
    const raw = req.params.part as string;
    if (!NON_NEG_INT.test(raw) || !Number.isSafeInteger(Number(raw))) return void res.status(404).json({ error: 'not_found' });
    const id = known(req, res);
    if (!id) return;
    const part = Number(raw);
    try {
      // A part already fetched is never fetched again, even across a restart.
      try {
        return void res.type('json').send(readFileSync(partFile(id, part), 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const parts = (await leaseStatus(id)).outputParts;
      if (parts === undefined || part >= parts) return void res.status(404).json({ error: 'not_found' });
      const key = `${id}:${part}`;
      let fetching = partInflight.get(key);
      if (!fetching) {
        spendRead(id);
        fetching = (async () => {
          const api = deps.api(leaseOffer(id));
          const answer = await unpaid(api, () => api.outputPart(id, part));
          mkdirSync(join(deps.dataDir, 'output', id), { recursive: true, mode: 0o700 });
          const file = partFile(id, part);
          writeFileSync(`${file}.tmp`, JSON.stringify(answer), { mode: 0o600 });
          renameSync(`${file}.tmp`, file);
          return answer;
        })();
        partInflight.set(key, fetching);
        const clear = () => void partInflight.delete(key);
        fetching.then(clear, clear);
      }
      res.json(await fetching);
    } catch (e) {
      failRead(res, e);
    }
  });

  if (existsSync(webDir)) {
    // `extensions` lets /agents serve agents.html: the address an agent is handed has no file suffix.
    app.use(express.static(webDir, { index: 'index.html', extensions: ['html'] }));
  } else {
    app.get('/', (_req, res) => void res.type('text/plain').send('Charter door'));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal' : 'bad_request' });
  });
  return app;
}
