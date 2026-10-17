import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { HostError, type HostApi } from '../tenant/host-api.js';
import { findOfferExact } from '../tenant/offers.js';
import type { Lease, Micro, Offer } from '../types.js';
import { DeadlinePassedError, SendTimeoutError } from '../payer.js';
import { offerOfSnapshot, snapshotOffer, type DoorLedger, type LossKind } from './ledger.js';
import { MIN_WINDOW_SECONDS, SETTLE_MARGIN_SECONDS, isPayerFault, paymentIdOf, realGate, settleReasonOf, stubGate, type Gate, type TestHooks, type X402Config } from './x402.js';

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
  ledger: DoorLedger;
  x402: X402Config | 'free-for-tests';
  /** Epoch ms. */
  now?: () => number;
  /** The door's data directory: output parts are kept under `output/` here. */
  dataDir: string;
  /** Where the built web page lives. Default: `web/dist` beside the package. */
  webDir?: string;
  /** Express `trust proxy`, for a door behind a reverse proxy (the rate limit keys on the client IP). */
  trustProxy?: boolean | number | string;
  /** Only read when `x402` is 'free-for-tests'. */
  testHooks?: TestHooks;
}

export const JOB_IMAGE = 'charter-job-fetch';
const MAX_URLS = 5;
const OFFERS_TTL_MS = 60_000;
const STATUS_TTL_MS = 5_000;
/** Paid host reads a lease's free GET routes may cause: this, plus READS_PER_TICK for each tick the renter paid. */
const READS_BASE = 40;
const READS_PER_TICK = 8;
/** A done lease with paid intervals and no landing yet is read from the host again after this long, at most. */
const LANDING_REFRESH_MS = 10 * 60_000;
const GETS_PER_MINUTE = 120;
const TICKS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;
const OPENS_PER_HOUR = 10;
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
  };
}

/** The lease's free-read budget is spent. */
class BudgetError extends Error {}

/** The door's daily cap on spend no renter paid for is reached. */
class CapacityError extends Error {}

function final(l: Lease): boolean {
  return l.state === 'done' || l.state === 'closed';
}

function isUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2000 || v.includes(',')) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
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
  const gate: Gate =
    deps.x402 === 'free-for-tests' ? stubGate(priceOf, deps.testHooks) : realGate(deps.x402, priceOf);

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
    if (rec.hostReads >= READS_BASE + READS_PER_TICK * rec.ticksPaidByRenter) throw new BudgetError();
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
  app.use((req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) return void res.status(415).json({ error: 'unsupported_media_type' });
    next();
  });
  app.use(express.json({ limit: '16kb', type: () => true }));

  // Only a door with no payment gate (local development) answers this, so the page knows to skip x402.
  if (deps.x402 === 'free-for-tests') app.get('/v1/dev', (_req, res) => void res.json({ dev: true }));

  // Where payments go, so the page can refuse a payment request that names any other payee.
  if (deps.x402 !== 'free-for-tests') {
    const { payTo, network } = deps.x402;
    app.get('/v1/door', (_req, res) => void res.json({ payTo, network }));
  }

  app.get('/v1/offers', async (_req, res) => {
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    res.json(
      list
        .filter((o) => trusted(o) && o.images.includes(JOB_IMAGE) && o.expiresAt > now())
        .map(publicOffer),
    );
  });

  app.post('/v1/leases', async (req, res) => {
    if (!allowOpen(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
    const { offerId, urls } = (req.body ?? {}) as { offerId?: unknown; urls?: unknown };
    if (typeof offerId !== 'string' || !Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS || !urls.every(isUrl)) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    let offer: Offer | undefined;
    try {
      offer = findOfferExact((await offers()).filter(trusted), offerId);
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    if (!offer || offer.expiresAt <= now()) return void res.status(404).json({ error: 'not_found' });
    if (!offer.images.includes(JOB_IMAGE)) return void res.status(400).json({ error: 'image_not_offered' });
    // Door-wide: an open costs the door and no renter pays for it.
    if (overCap() || !allowDoorOpen('door')) return void res.status(503).json({ error: 'capacity' });
    // A lease the channel cannot carry through its open and first tick is not started.
    if (await headroomShort(offer.openPrice + offer.tickPrice + HEADROOM_MARGIN, 'opens')) {
      return void res.status(503).json({ error: 'capacity' });
    }

    try {
      const api = deps.api(offer);
      const job = { image: JOB_IMAGE, args: { URLS: (urls as string[]).join(',') } };
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
  const tickGuard: express.RequestHandler = (req, res, next) => {
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
    // A payment is the authorization it carries, not the bytes of the header that carries it.
    const payment = paymentIdOf(req);
    if (payment === 'bad') return void res.status(400).json({ error: 'bad_payment' });
    if (payment !== 'none') {
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
    ticking.add(id);
    res.locals.offer = offerOfSnapshot(rec.offer);
    res.locals.index = index;
    next();
  };

  /** Runs the payment gate, then books the outcome once the response is final. */
  const paidTick: express.RequestHandler = async (req, res, next) => {
    const id = req.params.id as string;
    let failure: unknown;
    try {
      await gate(req, res, next);
    } catch (e) {
      failure = e;
    } finally {
      ticking.delete(id);
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

  const tick: express.RequestHandler = async (req, res) => {
    const id = req.params.id as string;
    const offer = res.locals.offer as Offer;
    const payer = res.locals.payer as string | undefined;
    // Reaching here means the payment verified: from now on it is spent, whatever happens next.
    if (res.locals.paymentKey) ledger.addPayment(res.locals.paymentKey as string);
    // The payment has verified, so the payer is known. One that cost the door before does not cost it again.
    if (payer && ledger.payerHasLoss(payer, now())) return void res.status(403).json({ error: 'payer_blocked' });
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
    const before = api.spent();
    try {
      const t = await api.tick(id, res.locals.index as number, sendOpts);
      if (t.duplicate) {
        // The host already counted this index: it was paid for nothing, and the renter is not charged.
        const lost = api.spent() - before;
        if (lost > 0n) ledger.loss(id, lost, 'host_refused', now(), payer);
        ledger.stop(id);
        return void res.status(409).json({ error: 'duplicate' });
      }
      ledger.hostTick(id);
      res.locals.hostPaid = { leaseId: id, price: offer.tickPrice };
      res.status(200).json(t);
    } catch (e) {
      // The send waited too long to start: nothing was sent, nothing is owed, and the renter's payment
      // will not settle (non-2xx). The renter retries the same index with a fresh authorization.
      if (e instanceof DeadlinePassedError) return void res.status(503).json({ error: 'retry_later' });
      // A host that answered, even with an error, took the door's money. It will not be paid again.
      // A send that timed out may have been paid, though nothing was counted.
      const lost = e instanceof SendTimeoutError ? offer.tickPrice : api.spent() - before;
      if (lost > 0n) {
        ledger.loss(id, lost, 'host_refused', now(), payer);
        ledger.stop(id);
      }
      if (e instanceof HostError && e.status === 409 && (e.error === 'lease_done' || e.error === 'not_running')) {
        return void res.status(409).json({ error: e.error });
      }
      res.status(502).json({ error: hostMessage(e) });
    }
  };

  app.post('/v1/leases/:id/ticks', tickGuard, paidTick, tick);

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
    app.use(express.static(webDir, { index: 'index.html' }));
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
