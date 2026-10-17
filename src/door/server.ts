import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { HostError, type HostApi } from '../tenant/host-api.js';
import { findOfferExact } from '../tenant/offers.js';
import type { Micro, Offer } from '../types.js';
import type { DoorLedger } from './ledger.js';
import { realGate, stubGate, type Gate, type TestHooks, type X402Config } from './x402.js';

export interface DoorDeps {
  /** Live offers. The door caches the answer for 60 s. */
  offers: () => Promise<Offer[]>;
  api: (o: Offer) => HostApi;
  ledger: DoorLedger;
  x402: X402Config | 'free-for-tests';
  /** Epoch ms. */
  now?: () => number;
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
const OUTPUT_TTL_MS = 60_000;
const OUTPUT_CACHE_MAX = 256;
const OPENS_PER_HOUR = 10;
const HOUR_MS = 3_600_000;
const LEASE_ID = /^[0-9a-f]{32}$/;
const NON_NEG_INT = /^\d+$/;

const EXPOSED = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE';
const ALLOWED = 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT';

/** Keeps one answer per key for a while, errors included, so a free route cannot spend the door dry. */
function ttlCache<T>(now: () => number, okMs: number, errMs: number, max: number) {
  const m = new Map<string, { at: number; ok: boolean | undefined; p: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && now() - hit.at < (hit.ok === false ? errMs : okMs)) return hit.p;
    const e: { at: number; ok: boolean | undefined; p: Promise<T> } = { at: now(), ok: undefined, p: load() };
    e.p.then(
      () => void (e.ok = true),
      () => void (e.ok = false),
    );
    m.delete(key);
    m.set(key, e);
    if (m.size > max) m.delete(m.keys().next().value!);
    return e.p;
  };
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

  const statusCache = ttlCache<Awaited<ReturnType<HostApi['status']>>>(now, STATUS_TTL_MS, STATUS_TTL_MS, 1024);
  const outputCache = ttlCache<Awaited<ReturnType<HostApi['outputPart']>>>(now, OUTPUT_TTL_MS, STATUS_TTL_MS, OUTPUT_CACHE_MAX);

  const opens = new Map<string, number[]>();
  /** Counts this attempt. False when the IP already opened its ten within the hour. */
  const allowOpen = (ip: string): boolean => {
    const t = now();
    for (const [k, v] of opens) {
      if (v[v.length - 1]! <= t - HOUR_MS) opens.delete(k);
    }
    const recent = (opens.get(ip) ?? []).filter((x) => x > t - HOUR_MS);
    if (recent.length >= OPENS_PER_HOUR) {
      opens.set(ip, recent);
      return false;
    }
    recent.push(t);
    opens.set(ip, recent);
    return true;
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
    const rec = LEASE_ID.test(id) ? ledger.get(id) : undefined;
    if (!rec) return void res.status(404).json({ error: 'not_found' });
    if (rec.stopped) return void res.status(409).json({ error: 'stopped' });
    const index = (req.body as { index?: unknown } | undefined)?.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return void res.status(400).json({ error: 'bad_request' });
    }
    let offer: Offer | undefined;
    try {
      offer = await offerOf(id, rec.offerId);
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    if (!offer) return void res.status(503).json({ error: 'offer_unavailable' });
    res.locals.offer = offer;
    res.locals.index = index;
    next();
  };

  /** Runs the payment gate, then books the outcome once the response is final. */
  const paidTick: express.RequestHandler = async (req, res, next) => {
    let failure: unknown;
    try {
      await gate(req, res, next);
    } catch (e) {
      failure = e;
    }
    const paid = res.locals.hostPaid as { leaseId: string; price: Micro } | undefined;
    if (paid) {
      if (!failure && res.statusCode >= 200 && res.statusCode < 300) {
        ledger.renterTick(paid.leaseId, res.locals.payer as string | undefined);
      } else {
        // The host has its tick and the renter's payment never settled.
        ledger.loss(paid.leaseId, paid.price);
        ledger.stop(paid.leaseId);
      }
    }
    if (failure) throw failure;
  };

  const tick: express.RequestHandler = async (req, res) => {
    const id = req.params.id as string;
    const offer = res.locals.offer as Offer;
    const api = deps.api(offer);
    const before = api.spent();
    try {
      const t = await api.tick(id, res.locals.index as number);
      ledger.hostTick(id);
      res.locals.hostPaid = { leaseId: id, price: offer.tickPrice };
      res.status(200).json(t);
    } catch (e) {
      // A host that answered, even with an error, took the door's money. It will not be paid again.
      const lost = api.spent() - before;
      if (lost > 0n) {
        ledger.loss(id, lost);
        ledger.stop(id);
      }
      if (e instanceof HostError && e.status === 409 && (e.error === 'lease_done' || e.error === 'not_running')) {
        return void res.status(409).json({ error: e.error });
      }
      res.status(502).json({ error: hostMessage(e) });
    }
  };

  app.post('/v1/leases/:id/ticks', tickGuard, paidTick, tick);

  /** The ledger's lease and its offer, or a 404 written to `res`. */
  const known = async (req: express.Request, res: express.Response): Promise<{ id: string; offer: Offer } | undefined> => {
    const id = req.params.id as string;
    const rec = LEASE_ID.test(id) ? ledger.get(id) : undefined;
    if (!rec) return void res.status(404).json({ error: 'not_found' });
    try {
      const offer = await offerOf(id, rec.offerId);
      if (offer) return { id, offer };
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    return void res.status(503).json({ error: 'offer_unavailable' });
  };

  app.get('/v1/leases/:id', async (req, res) => {
    const k = await known(req, res);
    if (!k) return;
    try {
      const lease = await statusCache(k.id, () => deps.api(k.offer).status(k.id));
      res.json({ lease, stopped: ledger.get(k.id)?.stopped ?? false });
    } catch (e) {
      readFailure(res, e);
    }
  });

  app.get('/v1/leases/:id/output/:part', async (req, res) => {
    const part = req.params.part as string;
    if (!NON_NEG_INT.test(part) || !Number.isSafeInteger(Number(part))) return void res.status(404).json({ error: 'not_found' });
    const k = await known(req, res);
    if (!k) return;
    try {
      res.json(await outputCache(`${k.id}:${part}`, () => deps.api(k.offer).outputPart(k.id, Number(part))));
    } catch (e) {
      readFailure(res, e);
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
