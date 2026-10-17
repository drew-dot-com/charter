import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { HostError, type HostApi } from '../tenant/host-api.js';
import { findOfferExact } from '../tenant/offers.js';
import type { Lease, Micro, Offer } from '../types.js';
import { SendTimeoutError } from '../payer.js';
import type { DoorLedger, LossKind } from './ledger.js';
import { MIN_WINDOW_SECONDS, isPayerFault, paymentIdOf, realGate, settleReasonOf, stubGate, type Gate, type TestHooks, type X402Config } from './x402.js';

export interface DoorDeps {
  /** Live offers. The door caches the answer for 60 s. */
  offers: () => Promise<Offer[]>;
  api: (o: Offer) => HostApi;
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
const READS_BASE = 20;
const READS_PER_TICK = 4;
const GETS_PER_MINUTE = 120;
const MINUTE_MS = 60_000;
const OPENS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
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

/** The lease's free-read budget is spent. */
class BudgetError extends Error {}

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

  /** The offer each lease was opened on, so a price never depends on the relay still listing it. */
  const leaseOffers = new Map<string, Offer>();
  const priceOf = (leaseId: string): Micro | undefined => leaseOffers.get(leaseId)?.tickPrice;
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

  const allowOpen = slidingLimit(now, OPENS_PER_HOUR, HOUR_MS);
  const allowGet = slidingLimit(now, GETS_PER_MINUTE, MINUTE_MS);

  /** What the door last read from the host for each lease, and any read in flight. */
  const statuses = new Map<string, { lease: Lease; at: number }>();
  const statusInflight = new Map<string, Promise<Lease>>();
  const partInflight = new Map<string, Promise<unknown>>();
  /** Leases with a tick in flight: one at a time. */
  const ticking = new Set<string>();
  /** Payment keys claimed by a request that has not finished verifying. */
  const claimed = new Set<string>();

  const partFile = (id: string, part: number): string => join(deps.dataDir, 'output', id, `${part}.json`);

  /** Spends one of the lease's paid host reads, or throws BudgetError. */
  const spendRead = (id: string): void => {
    const rec = ledger.get(id)!;
    if (rec.hostReads >= READS_BASE + READS_PER_TICK * rec.ticksPaidByRenter) throw new BudgetError();
    ledger.read(id);
  };

  /**
   * The host's lease, from memory while fresh (for good once done or closed) and
   * otherwise one paid status call within the lease's budget. A spent budget serves
   * the last answer, however old.
   */
  const leaseStatus = (id: string, offerOfLease: () => Promise<Offer>): Promise<Lease> => {
    const last = statuses.get(id);
    if (last && (final(last.lease) || now() - last.at < STATUS_TTL_MS)) return Promise.resolve(last.lease);
    const running = statusInflight.get(id);
    if (running) return running;
    try {
      spendRead(id);
    } catch (e) {
      return last ? Promise.resolve(last.lease) : Promise.reject(e);
    }
    const p = (async () => {
      const lease = await deps.api(await offerOfLease()).status(id);
      statuses.set(id, { lease, at: now() });
      return lease;
    })();
    statusInflight.set(id, p);
    const clear = () => void statusInflight.delete(id);
    p.then(clear, clear);
    return p;
  };

  /** The offer behind a door lease, from memory or, after a restart, the relay. */
  const offerOf = async (leaseId: string, offerId: string): Promise<Offer | undefined> => {
    const known = leaseOffers.get(leaseId);
    if (known) return known;
    const found = findOfferExact(await offers(), offerId);
    if (found) leaseOffers.set(leaseId, found);
    return found;
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

  // A browser on another origin calls every /v1 route. The payment headers go both ways.
  app.use('/v1', (req, res, next) => {
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
  app.use(express.json({ limit: '16kb', type: () => true }));

  app.get('/v1/offers', async (_req, res) => {
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    res.json(
      list
        .filter((o) => o.images.includes(JOB_IMAGE) && o.expiresAt > now())
        .map((o) => ({
          offerId: `${o.hostPubkey}:${o.id}`,
          cpu: o.cpu,
          memoryMiB: o.memoryMiB,
          intervalSeconds: o.intervalSeconds,
          tickPrice: o.tickPrice.toString(),
          images: o.images,
          hiddenHost: o.hiddenHost,
          hiddenEgress: o.hiddenEgress,
          expiresAt: o.expiresAt,
        })),
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
      offer = findOfferExact(await offers(), offerId);
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    if (!offer || offer.expiresAt <= now()) return void res.status(404).json({ error: 'not_found' });
    if (!offer.images.includes(JOB_IMAGE)) return void res.status(400).json({ error: 'image_not_offered' });

    try {
      const r = await deps.api(offer).open({ image: JOB_IMAGE, args: { URLS: (urls as string[]).join(',') } });
      if (!LEASE_ID.test(r.leaseId) || ledger.get(r.leaseId)) return void res.status(502).json({ error: 'bad_host_answer' });
      ledger.open({ leaseId: r.leaseId, offerId, createdAt: now() });
      leaseOffers.set(r.leaseId, offer);
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
    const id = req.params.id as string;
    const first = LEASE_ID.test(id) ? ledger.get(id) : undefined;
    if (!first) return void res.status(404).json({ error: 'not_found' });
    const index = (req.body as { index?: unknown } | undefined)?.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    let offer: Offer | undefined;
    try {
      offer = await offerOf(id, first.offerId);
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    // No await from here to next(): the checks and the claim on the lease happen together.
    const rec = ledger.get(id)!;
    if (rec.stopped) return void res.status(409).json({ error: 'stopped' });
    if (!offer) return void res.status(503).json({ error: 'offer_unavailable' });
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
    }
    ticking.add(id);
    res.locals.offer = offer;
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
    const api = deps.api(offer);
    const before = api.spent();
    try {
      const t = await api.tick(id, res.locals.index as number);
      ledger.hostTick(id);
      res.locals.hostPaid = { leaseId: id, price: offer.tickPrice };
      res.status(200).json(t);
    } catch (e) {
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

  /** The lease's offer, for a read that has to go to the host. */
  const offerFor = async (id: string): Promise<Offer> => {
    const offer = await offerOf(id, ledger.get(id)!.offerId);
    if (!offer) throw new HostError(503, 'offer_unavailable');
    return offer;
  };

  const failRead = (res: express.Response, e: unknown): void => {
    if (e instanceof BudgetError) return void res.status(429).json({ error: 'rate_limited' });
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
      const lease = await leaseStatus(id, () => offerFor(id));
      res.json({ lease, stopped: ledger.get(id)?.stopped ?? false });
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
      const parts = (await leaseStatus(id, () => offerFor(id))).outputParts;
      if (parts === undefined || part >= parts) return void res.status(404).json({ error: 'not_found' });
      const key = `${id}:${part}`;
      let fetching = partInflight.get(key);
      if (!fetching) {
        spendRead(id);
        fetching = (async () => {
          const answer = await deps.api(await offerFor(id)).outputPart(id, part);
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
