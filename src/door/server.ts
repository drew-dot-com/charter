import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { HostError, type HostApi, type OpenResult } from '../tenant/host-api.js';
import { JOB_IMAGES, homeIdOf, isHomeImage, jobFromBody } from '../jobs.js';
import { ALLOWED_MOVES as ALLOWANCE_MOVES, KEEP_HOME_FROM_HOURS, BadMove as AllowanceBadMove, LIVE_STATES as ALLOWANCE_LIVE, billerView, personMessage, ownerView as allowanceOwnerView, pageView as allowancePageView, validatePermission, validateRequest as validateAllowanceRequest, type AllowanceState, type AllowanceStore, type EndReason } from './allowances.js';
import { ALLOWED_MOVES, BadMove, ownerView, publicView, readFundPublic, validatePitch, type Grant, type GrantState, type GrantStore } from './grants.js';
import type { JobSpec, Lease, Micro, Offer } from '../types.js';
import { DeadlinePassedError, SendTimeoutError } from '../errors.js';
import { offerOfSnapshot, snapshotOffer, type DoorLedger, type LeaseOutcome, type LossKind } from './ledger.js';
import { CapitalCapError, DepositPendingError, DepositTimeoutError } from './host-http.js';
import { publicRecord, rankOffers, type HostRecord, type HostRegistry } from './hosts.js';
import { hostRoutes } from './hosts-routes.js';
import { slidingLimit } from './limit.js';
import { safeFetch } from './safe-fetch.js';
import { logRequests, type RequestSink } from './reqlog.js';
import { MAX_TIMEOUT_SECONDS, MIN_WINDOW_SECONDS, SETTLE_MARGIN_SECONDS, isPayerFault, microToUsdc, paymentIdOf, settleReasonOf, settleTxOf, type Gate, type PaymentId, type Schemes, type TestHooks, type X402Config } from '../x402/seller.js';
import { realGate, stubGate } from './x402.js';
import { openApiDoc } from './openapi.js';
import { parseReferral, shareOf, type ReferralStore } from './referrals.js';
import type { PayoutLog } from './referral-payouts.js';

export interface DoorDeps {
  /** Live offers. The door caches the answer for 60 s. */
  offers: () => Promise<Offer[]>;
  /** The host's lease API for an offer (one per host and price, so what a tick paid is remembered across calls). */
  api: (o: Offer) => HostApi;
  /** The door's payer address, which pays hosts and is paid by renters. `GET /v1/door` answers it. */
  payer?: `0x${string}`;
  /** Every host the door knows: who is listed, their records, which host holds each home. Serves `/v1/hosts`. */
  registry: HostRegistry;
  /** Micro-USDC the door adds to each tick a renter pays (CHARTER_DOOR_FEE). Default 0. A lease keeps the fee of its open. */
  fee?: Micro;
  /** What one host's refused ticks may cost the door in a UTC day (CHARTER_HOST_DAILY_LOSS); past it the host is hidden. Default 50000. */
  hostDailyLoss?: Micro;
  /** Door-wide `deposit_timeout` spend allowed in a UTC day (CHARTER_DEPOSIT_TIMEOUT_DAILY_CAP); past it they go to the host's budget. Default 100000. */
  depositTimeoutDailyCap?: Micro;
  /** A proven host the door cannot fund now: listed with `funding: 'waiting'`, never picked. Default: none. */
  fundingWaiting?: (hostId: string) => boolean;
  /** fetch for a registering host's offer. Default: safeFetch. */
  hostFetch?: typeof fetch;
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
  /** The grant fund's pitch log. Left out: the /v1/grants routes are not mounted. */
  grants?: GrantStore;
  /** False answers a pitch `503 fund_closed`. Default: open. */
  fundOpen?: () => boolean;
  /** The grant fund's bearer token. Left out (or no `grants`): the /v1/fund routes do not exist. */
  fundToken?: string;
  /** The fund's own payer address, lowercased. A payer equal to it is never answered payer_blocked. */
  fundAddress?: string;
  /** The allowance store. Left out (or no `allowAddress` or `allowToken`): the /v1/allowances routes are not mounted. */
  allowances?: AllowanceStore;
  /** The biller's bearer token. Left out: the /v1/biller routes do not exist. */
  allowToken?: string;
  /** The biller's spender address, lowercased: the spend permissions are granted to it. A payer equal to it is never answered payer_blocked. */
  allowAddress?: string;
  /** Where the approval page lives. Default: https://charterhome.dev/allow. */
  allowPageUrl?: string;
  /** Referral accrual. Left out: the field is still checked, recorded and echoed, and nothing accrues. */
  referrals?: { store: ReferralStore; bps: number; hosts: Set<string>; log?: PayoutLog };
}

const PITCHES_PER_HOUR = 5;
const QUEUE_CAP = 50;
const LIST_CAP = 200;

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
const GETS_PER_MINUTE = 120;
const TICKS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;
const OPENS_PER_HOUR = 10;
/** Leases `GET /v1/recent` lists. */
const RECENT_LEASES = 12;
const HOUR_MS = 3_600_000;
/** Opens across every IP in an hour. */
export const DOOR_OPENS_PER_HOUR = 30;
/**
 * Door spend no renter paid for (opens, free reads, losses a renter's payment caused, a host's first deposit
 * timeout of the UTC day within DEPOSIT_TIMEOUT_DAILY_CAP unless its deposit lapses unlanded) in one UTC day, in
 * micro-USDC. Past it: 503 capacity. A host's refused ticks, and its other deposit timeouts, count against its own
 * budget instead (HOST_DAILY_LOSS).
 */
export const DAILY_UNPAID_CAP: Micro = 500_000n;
/** What one host's refused ticks may cost the door in a UTC day, unless CHARTER_HOST_DAILY_LOSS says otherwise. */
export const HOST_DAILY_LOSS: Micro = 50_000n;
/**
 * What hosts' first deposit timeouts of the day may cost the door in a UTC day, all hosts together, unless
 * CHARTER_DEPOSIT_TIMEOUT_DAILY_CAP says otherwise: 20% of DAILY_UNPAID_CAP. Past it, a deposit timeout counts
 * against the host's own budget.
 */
export const DEPOSIT_TIMEOUT_DAILY_CAP: Micro = 100_000n;
/** The most the door pays for an offer's open, status read and tick, in micro-USDC. A pricier offer is not listed. */
export const MAX_OPEN_PRICE: Micro = 10_000n;
export const MAX_STATUS_PRICE: Micro = 1_000n;
export const MAX_TICK_PRICE: Micro = 50_000n;
const LEASE_ID = /^[0-9a-f]{32}$/;
const NON_NEG_INT = /^\d+$/;

const EXPOSED = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE';
const ALLOWED = 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT';

/** The id a renter names an offer by: `<hostId>:<id>`. */
const offerIdOf = (o: Offer): string => `${o.hostId}:${o.id}`;

/** The offer named exactly `<hostId>:<id>`, or undefined. A bare id never matches. */
function findOfferExact(offers: Offer[], ref: string): Offer | undefined {
  const m = /^([0-9a-f]{64}):(.+)$/.exec(ref);
  if (!m) return undefined;
  return offers.find((x) => x.hostId === m[1] && x.id === m[2]);
}

/**
 * An offer as the door shows it: what `GET /v1/offers` lists, and what a lease's status carries. `tickPrice` is
 * what the renter pays: the host's tick plus the door's `fee`. Every host is run by an independent operator.
 */
function publicOffer(o: Offer, r: HostRecord | undefined, fee: Micro, fundingWaiting = false, referralShare: bigint = 0n) {
  return {
    offerId: offerIdOf(o),
    cpu: o.cpu,
    memoryMiB: o.memoryMiB,
    intervalSeconds: o.intervalSeconds,
    tickPrice: (o.tickPrice + fee).toString(),
    images: o.images,
    hiddenHost: o.hiddenHost,
    hiddenEgress: o.hiddenEgress,
    expiresAt: o.expiresAt,
    ...(o.home ? { home: { ...o.home, tested: r?.homeTested ?? false } } : {}),
    operator: 'independent' as const,
    ...(referralShare > 0n ? { referralShare: referralShare.toString() } : {}),
    ...(r ? { record: publicRecord(r, fundingWaiting) } : {}),
  };
}

/** How `GET /v1/door` tells an agent to name a referral. */
const REFERRAL_HOW =
  'Add "referral": "<0x address on Base>" to POST /v1/rent. That address earns a share of every hour the renter pays for, paid in USDC on Base. Read GET /v1/referrals/<address>.';

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
  const { ledger, registry } = deps;
  const now = deps.now ?? Date.now;
  const fee = deps.fee ?? 0n;
  const waiting = deps.fundingWaiting ?? (() => false);
  const hostDailyLoss = deps.hostDailyLoss ?? HOST_DAILY_LOSS;
  const depositTimeoutDailyCap = deps.depositTimeoutDailyCap ?? DEPOSIT_TIMEOUT_DAILY_CAP;
  const listed = (hostId: string): boolean => registry.get(hostId)?.state === 'listed';
  const webDir = deps.webDir ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

  /** The offer a lease was opened on, from the ledger's snapshot: a price or a host call never depends on the host still listing it. */
  const leaseOffer = (leaseId: string): Offer => offerOfSnapshot(ledger.get(leaseId)!.offer);
  /** The door's fee a lease pays per tick: the one at its open. */
  const leaseFee = (leaseId: string): Micro => BigInt(ledger.get(leaseId)?.fee ?? '0');
  /** What a renter pays for one tick of a lease: its host's tick price and the door's fee, both as at open. */
  const priceOf = (leaseId: string): Micro | undefined => (ledger.get(leaseId) ? leaseOffer(leaseId).tickPrice + leaseFee(leaseId) : undefined);
  const withdrawing: (channelId: string) => Promise<boolean> =
    deps.withdrawing ?? (deps.schemes ? async (id) => ((await deps.schemes!.batch.getStorage().get(id))?.withdrawRequestedAt ?? 0) > 0 : async () => false);
  /**
   * The offer each paid rent was guarded against, keyed by its parsed body, so the gate prices exactly the
   * offer the handler opens on. A body with no entry (a bare probe) is priced from the offers as they stand.
   */
  const rentPicks = new WeakMap<object, Offer>();
  const rentPriceOf = async (body: unknown): Promise<Micro | undefined> => {
    if (typeof body === 'object' && body !== null && rentPicks.has(body)) return rentPicks.get(body)!.tickPrice + fee;
    const pick = pickRentOffer(await offers(), body);
    return typeof pick === 'string' ? undefined : pick.offer.tickPrice + fee;
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

  /** An offer within the door's price maxima. */
  const trusted = (o: Offer): boolean =>
    o.openPrice <= MAX_OPEN_PRICE &&
    o.statusPrice <= MAX_STATUS_PRICE &&
    o.tickPrice <= MAX_TICK_PRICE;
  const overCap = (): boolean => ledger.unpaidToday(now()) >= DAILY_UNPAID_CAP;
  /** Offers a renter can open a job on now: trusted, unexpired, carrying a job image, of a listed host. */
  const rentable = (list: Offer[]): Offer[] =>
    list.filter((o) => trusted(o) && o.expiresAt > now() && o.images.some((i) => JOB_IMAGES.includes(i)) && listed(o.hostId));

  /** The id of the home a job is, or undefined for a job that is not a home. */
  const homeOf = (job: JobSpec | null): string | undefined =>
    job && isHomeImage(job.image) ? homeIdOf((job.args.SSH_KEYS ?? '').split('\n')) : undefined;

  const referralFailed = (e: unknown): void => console.error(`charter-door referral accrual failed: ${e instanceof Error ? e.message : String(e)}`);
  /** Addresses a renter may not name as its referral: the door's own payer and pay-to, and the fund's. */
  const notReferrals = [deps.payer, deps.x402 === 'free-for-tests' ? undefined : deps.x402.payTo, deps.fundAddress].map((a) => a?.toLowerCase());
  /** The body's `referral`: undefined when none is named, 'bad_referral' when it cannot be one. */
  const referralOf = (body: unknown): string | undefined | 'bad_referral' =>
    parseReferral(typeof body === 'object' && body !== null ? (body as { referral?: unknown }).referral : undefined, notReferrals);
  /**
   * Who a lease opened now will earn for. Not a home: the address named. A home: the address it is bound to,
   * else the one named while the home has no paid hour (its first paid hour binds it), else nobody. Only an
   * echo: a read that throws is logged and answers nobody, never failing the open.
   */
  const earnerAtOpen = (homeId: string | undefined, named: string | undefined): string | undefined => {
    if (homeId === undefined || !deps.referrals) return named;
    try {
      return deps.referrals.store.homeReferrer(homeId) ?? (ledger.homeHasPaidHour(homeId) ? undefined : named);
    } catch (e) {
      referralFailed(e);
      return undefined;
    }
  };
  /**
   * After the renter's hour of this lease is booked: binds a new home to its lease's referral on the home's
   * first paid hour (`first`, read before the booking), then accrues the earner's share of what was paid.
   */
  const accrueReferral = (leaseId: string, payer: string | undefined, first: boolean): void => {
    const r = deps.referrals;
    const rec = ledger.get(leaseId);
    if (!r || !rec) return;
    if (first && rec.homeId !== undefined && rec.referral !== undefined) r.store.bindHome(rec.homeId, rec.referral);
    const earner = rec.homeId !== undefined ? r.store.homeReferrer(rec.homeId) : rec.referral;
    if (earner === undefined || r.bps === 0) return;
    if (payer !== undefined && payer.toLowerCase() === deps.fundAddress?.toLowerCase()) return;
    const fee = BigInt(rec.fee ?? '0');
    const share = shareOf({ paid: BigInt(rec.offer.tickPrice) + fee, fee, bps: r.bps, hostListed: r.hosts.has(rec.offer.hostId) });
    if (share > 0n) r.store.accrue(earner, share, now());
  };

  /** What a referrer earns from one hour of this offer at this fee, as a public offer shows it; 0 when none is earned. */
  const shareFor = (o: Offer, f: Micro): bigint => {
    const r = deps.referrals;
    if (!r || r.bps === 0) return 0n;
    return shareOf({ paid: o.tickPrice + f, fee: f, bps: r.bps, hostListed: r.hosts.has(o.hostId) });
  };

  /**
   * A home whose disk is on a listed host opens there, whatever the ranking or a named offer says: the named
   * offer when it is that host's, else that host's best offer for the image. While that host is hidden or
   * probing, every request for the home is 'home_host_gone': its disk may come back. Once it is dropped, a named
   * offer opens a fresh home on purpose (its first paid tick pins the home there); without one, 'home_host_gone'.
   * Also 'home_host_gone' when a listed holder lists nothing open. Undefined for a home no host holds yet, or a
   * job that is not a home.
   */
  const pinnedOffer = (open: Offer[], job: JobSpec | null, named?: Offer): Offer | 'home_host_gone' | 'image_not_offered' | undefined => {
    const homeId = homeOf(job);
    const hostId = homeId === undefined ? undefined : registry.homeHost(homeId);
    if (!job || hostId === undefined) return undefined;
    if (named?.hostId === hostId) return named;
    const holder = registry.get(hostId)?.state;
    if (holder === undefined || holder === 'dropped') return named ?? 'home_host_gone';
    if (holder !== 'listed') return 'home_host_gone';
    const its = open.filter((o) => o.hostId === hostId);
    if (its.length === 0) return 'home_host_gone';
    return rankOffers(its.filter((o) => o.images.includes(job.image)), registry, { home: true })[0] ?? 'image_not_offered';
  };

  /**
   * The offer a rent body opens on, and its job (null for an empty body: a probe, priced at the default).
   * A home goes to the host that holds it (pinnedOffer). Else a named offerId must be listed; with none, the
   * first offer that runs the job as rankOffers orders them.
   */
  const pickRentOffer = (list: Offer[], body: unknown): { offer: Offer; job: JobSpec | null } | 'bad_request' | 'not_found' | 'image_not_offered' | 'home_host_gone' => {
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) return 'bad_request';
    const b = (body ?? {}) as { offerId?: unknown; urls?: unknown; python?: unknown; home?: unknown };
    const empty = Object.keys(b).length === 0;
    const job = empty ? null : jobFromBody(b);
    if (!empty && (!job || (b.offerId !== undefined && typeof b.offerId !== 'string'))) return 'bad_request';
    const open = rentable(list);
    let named: Offer | undefined;
    if (typeof b.offerId === 'string') {
      named = findOfferExact(open, b.offerId);
      if (!named) return 'not_found';
      if (job && !named.images.includes(job.image)) return 'image_not_offered';
    }
    const pinned = pinnedOffer(open, job, named);
    if (typeof pinned === 'string') return pinned;
    if (pinned) return { offer: pinned, job };
    if (named) return { offer: named, job };
    const fits = rankOffers(
      open.filter((o) => !job || o.images.includes(job.image)),
      registry,
      { home: homeOf(job) !== undefined, waiting },
    );
    return fits[0] ? { offer: fits[0], job } : 'not_found';
  };
  /** Books a tick the host took the door's money for and refused: against its own budget, which hides it once spent. */
  const hostRefused = (id: string, lost: Micro, payer: string | undefined): void => {
    ledger.loss(id, lost, 'host_refused', now(), payer);
    const hostId = ledger.get(id)?.offer.hostId;
    if (hostId && registry.get(hostId) && ledger.hostLossToday(hostId, now()) >= hostDailyLoss) registry.hide(hostId);
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
  const allowPitch = slidingLimit(now, PITCHES_PER_HOUR, HOUR_MS);

  /** What the door last read from the host for each lease, and any read in flight. */
  const statuses = new Map<string, { lease: Lease; at: number }>();
  const statusInflight = new Map<string, Promise<Lease>>();
  const partInflight = new Map<string, Promise<unknown>>();
  /** Leases with a tick in flight: one at a time. */
  const ticking = new Set<string>();
  /** Payment keys claimed by a request that has not finished verifying. */
  const claimed = new Set<string>();
  const partFile = (id: string, part: number): string => join(deps.dataDir, 'output', id, `${part}.json`);

  /** Tells the registry how a lease went on its host, once per lease. A lease of a host the registry lacks tells nothing. */
  const outcome = (id: string, kind: LeaseOutcome): void => {
    const hostId = ledger.get(id)?.offer.hostId;
    if (!hostId || !registry.get(hostId) || !ledger.outcome(id, kind)) return;
    if (kind === 'finished') registry.leaseFinished(hostId, ledger.get(id)!.ticksPaidToHost);
    else registry.leaseHostFailed(hostId, now());
  };
  /** A status the host just answered: kept for reads, and what it says of the host told to the registry. */
  const seen = (id: string, lease: Lease): void => {
    statuses.set(id, { lease, at: now() });
    if (lease.state === 'done' || (lease.state === 'closed' && lease.closedReason === 'max_intervals')) outcome(id, 'finished');
    else if (lease.state === 'closed' && lease.closedReason === 'boot_failed') outcome(id, 'host_failed');
    const rec = ledger.get(id);
    const host = rec && registry.get(rec.offer.hostId);
    // A paid home lease running with its access published: the host's homes work.
    if (host && !host.homeTested && rec!.homeId && rec!.ticksPaidToHost > 0 && lease.state === 'running' && lease.access) registry.markHomeTested(host.hostId);
  };
  /** A lease the door just opened on a host: counted, and a host that could not boot it told. */
  const opened = (r: OpenResult, offer: Offer): void => {
    if (registry.get(offer.hostId)) registry.leaseOpened(offer.hostId);
    if (r.state === 'closed' && r.closedReason === 'boot_failed') outcome(r.leaseId, 'host_failed');
  };

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
    // A final status is kept for good.
    if (last && final(last.lease)) return Promise.resolve(last.lease);
    const running = statusInflight.get(id);
    if (running) return running;
    try {
      spendRead(id);
    } catch (e) {
      return last ? Promise.resolve(last.lease) : Promise.reject(e);
    }
    const p = (async () => {
      const api = deps.api(leaseOffer(id));
      const lease = await unpaid(api, () => api.status(id));
      seen(id, lease);
      return lease;
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
    const payer = deps.payer;
    const referralBps = deps.referrals?.bps ?? 0;
    app.get('/v1/door', (_req, res) => void res.json({ payTo, network, ...(payer ? { payer } : {}), ...(referralBps > 0 ? { referral: { bps: referralBps, how: REFERRAL_HOW } } : {}) }));
  }

  if (deps.grants) {
    const grants = deps.grants;
    app.post('/v1/grants', (req, res) => {
      if (!allowPitch(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
      if (deps.fundOpen && !deps.fundOpen()) return void res.status(503).json({ error: 'fund_closed' });
      const v = validatePitch(req.body);
      if (!v.ok) return void res.status(400).json({ error: v.error });
      if (grants.homeIdGranted(homeIdOf(v.pitch.sshKeys))) return void res.status(409).json({ error: 'already_granted' });
      if (grants.queued().length >= QUEUE_CAP) return void res.status(503).json({ error: 'full' });
      const token = randomBytes(32).toString('hex');
      const g = grants.add(v.pitch, token);
      res.status(201).json({ grantId: g.grantId, grantToken: token, state: g.state, next: `/v1/grants/${g.grantId}` });
    });
    app.get('/v1/grants/:id', (req, res) => {
      const id = String(req.params.id);
      const g = grants.get(id);
      if (!g) return void res.status(404).json({ error: 'not_found' });
      // No token header: the public view. A token that does not match: 403, so a client can say so.
      const token = req.get('x-grant-token');
      if (token === undefined) return void res.json(publicView(g));
      if (!grants.tokenOk(id, token)) return void res.status(403).json({ error: 'bad_token' });
      const view = ownerView(g);
      // The last 48 hours of a paid grant: hand the grantee a link its person can use to keep the home paid.
      const tickMicro = g.leaseId ? priceOf(g.leaseId) : undefined;
      // Offered only when this read can make the allowance itself, so its token always goes with it: a live
      // allowance someone else asked for (anyone who knows the home's public keys can) is never handed out.
      if (deps.allowances && deps.allowAddress && deps.allowToken && g.state === 'active' && g.paidHours >= KEEP_HOME_FROM_HOURS && tickMicro !== undefined && !deps.allowances.liveForHome(g.homeId)) {
        const pageUrl = deps.allowPageUrl ?? 'https://charterhome.dev/allow';
        const ownerToken = randomBytes(32).toString('hex');
        const a = deps.allowances.add({ sshKeys: g.sshKeys, image: g.image, tickMicro }, ownerToken);
        const approveUrl = `${pageUrl}?id=${a.allowanceId}`;
        return void res.json({ ...view, keepHome: { allowanceId: a.allowanceId, ownerToken, approveUrl, state: a.state, message: `Your grant ends soon. To keep this home after it, send your person this message as it is:\n\n${personMessage(approveUrl)}` } });
      }
      res.json(view);
    });
    app.get('/v1/grants', (_req, res) => {
      const list = grants.all().sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_CAP).map(publicView);
      // null until the fund has reported; `open` is false once its report is older than 10 minutes.
      const fund = readFundPublic(join(deps.dataDir, 'fund-public.json'), now());
      res.json({ grants: list, fund });
    });
  }

  if (deps.grants && deps.fundToken) {
    const grants = deps.grants;
    const want = createHash('sha256').update(deps.fundToken).digest();
    const fundAuth: express.RequestHandler = (req, res, next) => {
      const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
      const got = createHash('sha256').update(m?.[1] ?? '').digest();
      if (!m || !timingSafeEqual(got, want)) return void res.status(401).json({ error: 'unauthorized' });
      next();
    };
    const fundView = (g: Grant): Record<string, unknown> => {
      const { tokenHash: _t, ...rest } = g;
      return rest;
    };
    app.get('/v1/fund/queue', fundAuth, (_req, res) => {
      const g = grants.queued().sort((a, b) => a.createdAt - b.createdAt)[0];
      const live = grants.all().filter((x) => x.state === 'active' || x.state === 'approved_waiting').length;
      res.json({ grant: g ? { grantId: g.grantId, name: g.name, link: g.link ?? null, image: g.image, pitch: g.pitch ?? '', homeId: g.homeId } : null, live });
    });
    app.get('/v1/fund/grants', fundAuth, (req, res) => {
      const state = req.query.state;
      if (state !== undefined && (typeof state !== 'string' || !Object.hasOwn(ALLOWED_MOVES, state))) return void res.status(400).json({ error: 'bad_state' });
      res.json({ grants: grants.all().filter((g) => state === undefined || g.state === state).map(fundView) });
    });
    app.post('/v1/fund/grants/:id', fundAuth, (req, res) => {
      const id = String(req.params.id);
      if (!grants.get(id)) return void res.status(404).json({ error: 'not_found' });
      const b = req.body;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) return void res.status(400).json({ error: 'body must be a JSON object' });
      const patch: Parameters<GrantStore['update']>[1] = {};
      for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
        if (k === 'state' && typeof v === 'string' && Object.hasOwn(ALLOWED_MOVES, v)) patch.state = v as GrantState;
        else if ((k === 'summary' || k === 'reason' || k === 'leaseId') && typeof v === 'string' && v.length <= 2000) patch[k] = v;
        else if (k === 'paidHours' && typeof v === 'number' && Number.isInteger(v) && v >= 0) patch.paidHours = v;
        else if (k === 'renewedByGrantee' && typeof v === 'boolean') patch.renewedByGrantee = v;
        else return void res.status(400).json({ error: `bad field ${k}` });
      }
      if (patch.state !== undefined && grants.get(id)!.state === 'queued') patch.decidedAt = now();
      try {
        res.json(fundView(grants.update(id, patch)));
      } catch (e) {
        if (e instanceof BadMove) return void res.status(409).json({ error: 'bad_move' });
        throw e;
      }
    });
    app.put('/v1/fund/public', fundAuth, (req, res) => {
      const b = req.body as Record<string, unknown> | null;
      const ok = typeof b === 'object' && b !== null && !Array.isArray(b)
        && typeof b.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(b.address)
        && typeof b.balanceMicro === 'string' && /^[0-9]+$/.test(b.balanceMicro)
        && typeof b.grantsLeft === 'number' && Number.isInteger(b.grantsLeft) && b.grantsLeft >= 0
        && typeof b.open === 'boolean';
      if (!ok) return void res.status(400).json({ error: 'address, balanceMicro (digits), grantsLeft (integer) and open (boolean) are required' });
      // reportedAt is the door's clock: a report older than 10 minutes reads as closed (readFundPublic).
      const pub = { address: b.address, balanceMicro: b.balanceMicro, grantsLeft: b.grantsLeft, open: b.open, reportedAt: now() };
      const file = join(deps.dataDir, 'fund-public.json');
      mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(pub), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      res.json(pub);
    });
  }

  // Mounted only with both the biller's address and its token: an allowance nobody can bill would sit
  // approved forever.
  if (deps.allowances && deps.allowAddress && deps.allowToken) {
    const allowances = deps.allowances;
    const spender = deps.allowAddress;
    const allowToken = deps.allowToken;
    const pageUrl = deps.allowPageUrl ?? 'https://charterhome.dev/allow';
    const ENDS: readonly string[] = ['cancelled', 'stopped', 'home_gone', 'operator'];
    /** The home's newest lease on the host that holds its disk. A newer lease may be an unpaid open
     *  elsewhere, and the biller never pays or opens on another host, so no price comes from one. */
    const ownLease = (homeId: string) => {
      const holder = registry.homeHost(homeId);
      return holder === undefined ? undefined : ledger.all().filter((l) => l.homeId === homeId && l.offerId.startsWith(`${holder}:`)).sort((a, b) => b.createdAt - a.createdAt)[0];
    };

    app.post('/v1/allowances', (req, res) => {
      if (!allowPitch(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
      const v = validateAllowanceRequest(req.body);
      if (!v.ok) return void res.status(400).json({ error: v.error });
      const homeId = homeIdOf(v.sshKeys);
      const own = ownLease(homeId);
      const paid = ledger.all().some((l) => l.homeId === homeId && l.ticksPaidByRenter > 0);
      if (!own || !paid) return void res.status(404).json({ error: 'no_home' });
      const live = allowances.liveForHome(homeId);
      // Never the live one's id: anyone who knows a home's public keys can ask.
      if (live) return void res.status(409).json({ error: 'already_live' });
      const token = randomBytes(32).toString('hex');
      const a = allowances.add({ sshKeys: v.sshKeys, image: v.image, tickMicro: priceOf(own.leaseId)! }, token);
      res.status(201).json({ allowanceId: a.allowanceId, ownerToken: token, approveUrl: `${pageUrl}?id=${a.allowanceId}`, state: a.state, next: `/v1/allowances/${a.allowanceId}` });
    });
    app.get('/v1/allowances/:id', (req, res) => {
      const id = String(req.params.id);
      const a = allowances.get(id);
      if (!a) return void res.status(404).json({ error: 'not_found' });
      const token = req.get('x-allowance-token');
      if (token === undefined) return void res.json(allowancePageView(a, spender));
      if (!allowances.tokenOk(id, token)) return void res.status(403).json({ error: 'bad_token' });
      res.json(allowanceOwnerView(a, spender));
    });
    app.post('/v1/allowances/:id/permission', (req, res) => {
      const id = String(req.params.id);
      const a = allowances.get(id);
      if (!a) return void res.status(404).json({ error: 'not_found' });
      if (a.state !== 'waiting') return void res.status(409).json({ error: 'not_waiting' });
      const v = validatePermission(req.body, { spender, tickMicro: BigInt(a.tickMicro), now: now() });
      if (!v.ok) return void res.status(400).json({ error: v.error });
      // One permission, one allowance: a permission is public on chain once used, so a copy is refused.
      if (allowances.permissionHolder(v.signed.permission.account, v.signed.permission.salt) !== undefined) return void res.status(409).json({ error: 'permission_in_use' });
      res.json(allowancePageView(allowances.update(id, { state: 'approved', signed: v.signed, account: v.signed.permission.account }), spender));
    });
    app.post('/v1/allowances/:id/stop', (req, res) => {
      const id = String(req.params.id);
      const a = allowances.get(id);
      if (!a) return void res.status(404).json({ error: 'not_found' });
      const token = req.get('x-allowance-token');
      if (token === undefined || !allowances.tokenOk(id, token)) return void res.status(403).json({ error: 'bad_token' });
      if (!ALLOWANCE_LIVE.includes(a.state)) return void res.status(409).json({ error: 'not_live' });
      res.json(allowanceOwnerView(allowances.update(id, { state: a.state === 'waiting' ? 'expired' : 'stopping' }), spender));
    });

    {
      const want = createHash('sha256').update(allowToken).digest();
      const billerAuth: express.RequestHandler = (req, res, next) => {
        const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
        const got = createHash('sha256').update(m?.[1] ?? '').digest();
        if (!m || !timingSafeEqual(got, want)) return void res.status(401).json({ error: 'unauthorized' });
        next();
      };
      app.get('/v1/biller/allowances', billerAuth, (_req, res) => {
        // liveForHome expires a stale waiting allowance, so run it for each home first.
        for (const h of new Set(allowances.all().map((a) => a.homeId))) allowances.liveForHome(h);
        // `spender`: the address people approve, which the biller checks is its own before it does anything.
        res.json({ spender, allowances: allowances.all().filter((a) => ALLOWANCE_LIVE.includes(a.state)).map(billerView) });
      });
      app.post('/v1/biller/allowances/:id', billerAuth, (req, res) => {
        const id = String(req.params.id);
        if (!allowances.get(id)) return void res.status(404).json({ error: 'not_found' });
        const b = req.body;
        if (typeof b !== 'object' || b === null || Array.isArray(b)) return void res.status(400).json({ error: 'body must be a JSON object' });
        const patch: Parameters<AllowanceStore['update']>[1] = {};
        const digits = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,78}$/.test(v);
        for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
          if (k === 'state' && typeof v === 'string' && Object.hasOwn(ALLOWANCE_MOVES, v)) patch.state = v as AllowanceState;
          else if (k === 'endReason' && typeof v === 'string' && ENDS.includes(v)) patch.endReason = v as EndReason;
          else if ((k === 'reason' || k === 'account' || k === 'lastPullTx' || k === 'leaseId') && typeof v === 'string' && v.length <= 2000) patch[k] = v;
          else if ((k === 'remainingMicro' || k === 'creditMicro') && digits(v)) patch[k] = v;
          else if (k === 'periodEndsAt' && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) patch.periodEndsAt = v;
          else if (k === 'hoursPaid' && typeof v === 'number' && Number.isInteger(v) && v >= 0) patch.hoursPaid = v;
          else return void res.status(400).json({ error: `bad field ${k}` });
        }
        try {
          res.json(billerView(allowances.update(id, patch)));
        } catch (e) {
          if (e instanceof AllowanceBadMove) return void res.status(409).json({ error: 'bad_move' });
          throw e;
        }
      });
      app.get('/v1/biller/homes/:homeId', billerAuth, (req, res) => {
        const homeId = String(req.params.homeId);
        // The lease to pay and the offer to re-open on are the home's own host's.
        const holder = registry.homeHost(homeId);
        const own = ownLease(homeId);
        const grantLive = deps.grants?.all().some((g) => g.homeId === homeId && (g.state === 'active' || g.state === 'approved_waiting')) ?? false;
        res.json({ leaseId: own?.leaseId ?? null, offerId: own?.offerId ?? null, hostKnown: holder !== undefined, grantLive });
      });
    }
  }

  app.use(hostRoutes({
    registry,
    fetch: deps.hostFetch ?? ((input, init) => safeFetch(input as string | URL | Request, init ?? {})),
    now,
    maxTickPrice: MAX_TICK_PRICE,
    waiting,
  }));

  /** What the door's ledger says about a host: leases with a renter-paid interval, and the newest one. */
  const hostStats = (hostId: string): { leases: number; lastLeaseAt?: number } => {
    let leases = 0;
    let lastLeaseAt: number | undefined;
    for (const l of ledger.all()) {
      if (l.ticksPaidByRenter === 0 || !l.offerId.startsWith(`${hostId}:`)) continue;
      leases++;
      if (lastLeaseAt === undefined || l.createdAt > lastLeaseAt) lastLeaseAt = l.createdAt;
    }
    return { leases, ...(lastLeaseAt === undefined ? {} : { lastLeaseAt }) };
  };

  /**
   * Offers in the order the door picks from: what rankOffers picks first, then, tier by tier, what it passed
   * over (a host below the success floor), and hosts waiting for funding last, ranked the same way.
   */
  const doorOrder = (shown: Offer[]): Offer[] => {
    const out: Offer[] = [];
    let left = shown;
    for (const opts of [{ waiting }, {}]) {
      for (let tier = rankOffers(left, registry, opts); tier.length > 0; tier = rankOffers(left, registry, opts)) {
        out.push(...tier);
        left = left.filter((x) => !tier.includes(x));
      }
    }
    return [...out, ...left];
  };

  app.get('/v1/offers', async (_req, res) => {
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    res.json(
      doorOrder(list.filter((o) => trusted(o) && o.images.some((i) => JOB_IMAGES.includes(i)) && o.expiresAt > now() && listed(o.hostId)))
        .map((o) => ({ ...publicOffer(o, registry.get(o.hostId), fee, waiting(o.hostId), shareFor(o, fee)), ...hostStats(o.hostId) })),
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
    const named = referralOf(body);
    if (named === 'bad_referral') return void res.status(400).json({ error: named });
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    let offer = findOfferExact(list.filter((o) => trusted(o) && listed(o.hostId)), offerId);
    if (!offer || offer.expiresAt <= now()) return void res.status(404).json({ error: 'not_found' });
    if (!offer.images.includes(job.image)) return void res.status(400).json({ error: 'image_not_offered' });
    const pinned = pinnedOffer(rentable(list), job, offer);
    if (pinned === 'home_host_gone') return void res.status(409).json({ error: pinned });
    if (pinned === 'image_not_offered') return void res.status(400).json({ error: pinned });
    if (pinned) offer = pinned;
    // Door-wide: an open costs the door and no renter pays for it.
    if (overCap() || !allowDoorOpen('door')) return void res.status(503).json({ error: 'capacity' });

    try {
      const api = deps.api(offer);
      const r = await unpaid(api, () => api.open(job));
      if (!LEASE_ID.test(r.leaseId) || ledger.get(r.leaseId)) return void res.status(502).json({ error: 'bad_host_answer' });
      const homeId = homeOf(job);
      ledger.open({ leaseId: r.leaseId, offerId: offerIdOf(offer), createdAt: now(), offer: snapshotOffer(offer), fee: fee.toString(), ...(homeId ? { homeId } : {}), ...(named ? { referral: named } : {}) });
      opened(r, offer);
      const earner = earnerAtOpen(homeId, named);
      res.json({
        leaseId: r.leaseId,
        state: r.state,
        ...(r.closedReason ? { closedReason: r.closedReason } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(earner ? { referral: earner } : {}),
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
        const payer = res.locals.payer as string | undefined;
        // Referral code only reads what was booked: whatever it throws, the hour is booked as before.
        let first = false;
        try {
          const homeId = deps.referrals ? ledger.get(paid.leaseId)?.homeId : undefined;
          first = homeId !== undefined && !ledger.homeHasPaidHour(homeId);
        } catch (e) {
          referralFailed(e);
        }
        ledger.renterTick(paid.leaseId, payer);
        try {
          accrueReferral(paid.leaseId, payer, first);
        } catch (e) {
          referralFailed(e);
        }
        // An exact hour is one transaction on Base: keep its hash. A batch voucher settles later, in a batch.
        const id = paymentIdOf(req);
        const tx = settleTxOf(res);
        if (typeof id === 'object' && id.kind === 'exact' && tx) ledger.tickTx(paid.leaseId, tx, now());
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
    // The fund's own wallet and the allowance biller's are exempt: its losses are booked, but it is never turned away.
    if (payer && payer.toLowerCase() !== deps.fundAddress && payer.toLowerCase() !== deps.allowAddress && ledger.payerHasLoss(payer, now())) return void res.status(403).json({ error: 'payer_blocked' }), false;
    return true;
  };

  const tick: express.RequestHandler = async (req, res) => {
    const id = req.params.id as string;
    const offer = res.locals.offer as Offer;
    if (!verified(res)) return;
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
      // The host could not say how its lease stands when it was due a tick.
      outcome(id, 'host_failed');
      return void res.status(502).json({ error: hostMessage(e) });
    }
    seen(id, fresh);
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
        if (lost > 0n) {
          hostRefused(id, lost, payer);
          outcome(id, 'host_failed');
        }
        ledger.stop(id);
        return void res.status(409).json({ error: 'duplicate', ...extra });
      }
      ledger.hostTick(id, now());
      // A home's disk is on the host its first paid tick reached: renewals and re-opens go there.
      const rec = ledger.get(id)!;
      if (rec.homeId && rec.ticksPaidToHost === 1 && registry.homeHost(rec.homeId) !== offer.hostId) registry.setHomeHost(rec.homeId, offer.hostId);
      res.locals.hostPaid = { leaseId: id, price: offer.tickPrice };
      res.status(200).json(answer(t));
    } catch (e) {
      // The send waited too long to start: nothing was sent, nothing is owed, and the renter's payment
      // will not settle (non-2xx). The renter retries the same index with a fresh authorization.
      if (e instanceof DeadlinePassedError) return void res.status(503).json({ error: 'retry_later', ...extra });
      // The door's own capital refused the deposit: nothing was sent, the host did nothing wrong, the renter may retry.
      if (e instanceof CapitalCapError || e instanceof DepositPendingError) return void res.status(503).json({ error: 'capacity', ...extra });
      const over = e instanceof HostError && e.status === 409 && (e.error === 'lease_done' || e.error === 'not_running');
      // A refused, failed or unanswered tick (a 402 the door will not pay included) counts against the host,
      // except one that timed out while its deposit was landing on chain: that wait is the door's own.
      if (!over && !(e instanceof DepositTimeoutError)) outcome(id, 'host_failed');
      // A host that answered, even with an error, took the door's money. It will not be paid again.
      // A send that timed out may have been paid, though nothing was counted.
      const lost = e instanceof SendTimeoutError ? offer.tickPrice : api.spent() - before;
      if (lost > 0n) {
        // A host's first deposit timeout in a UTC day is the door's own wait: door spend, credited back if the
        // deposit lapses unlanded, while all hosts' such spend that day stays within its sub-cap. A second one that
        // day, or one past the sub-cap, is the host's: it counts against its budget like a refusal.
        const doorWait =
          e instanceof DepositTimeoutError &&
          ledger.countDepositTimeout(offer.hostId, now()) === 1 &&
          ledger.depositTimeoutSpendToday(now()) + lost <= depositTimeoutDailyCap;
        if (doorWait) ledger.loss(id, lost, 'deposit_timeout', now(), payer);
        else hostRefused(id, lost, payer);
        ledger.stop(id);
      }
      if (over) return void res.status(409).json({ error: (e as HostError).error, ...extra });
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
    // Checked on the unpaid challenge too, so a renter learns of a bad referral before it pays.
    const named = referralOf(body);
    if (named === 'bad_referral') return void res.status(400).json({ error: named });
    let list: Offer[];
    try {
      list = await offers();
    } catch {
      return void res.status(502).json({ error: 'offers_unavailable' });
    }
    const pick = pickRentOffer(list, body);
    if (pick === 'not_found') return void res.status(404).json({ error: 'not_found' });
    if (pick === 'home_host_gone') return void res.status(409).json({ error: pick });
    if (typeof pick === 'string') return void res.status(400).json({ error: pick });
    const { offer, job } = pick;
    if (overCap()) return void res.status(503).json({ error: 'capacity' });
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
    res.locals.referral = named;
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
    const homeId = homeOf(job);
    const named = res.locals.referral as string | undefined;
    ledger.open({ leaseId, offerId: offerIdOf(offer), createdAt: now(), offer: snapshotOffer(offer), fee: fee.toString(), ...(homeId ? { homeId } : {}), ...(named ? { referral: named } : {}) });
    const earner = earnerAtOpen(homeId, named);
    opened(r, offer);
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
      (t) => ({ leaseId, state: 'running', ...t, next: { path: `/v1/leases/${leaseId}/ticks`, index: 1 }, offer: publicOffer(offer, registry.get(offer.hostId), fee, false, shareFor(offer, fee)), ...(earner ? { referral: earner } : {}) }),
      { leaseId },
    );
  };

  app.post('/v1/rent', rentGuard, paidRent, rent);

  // What an x402 index (x402scan) reads to list the door: the paid rent route and the free routes.
  app.get('/openapi.json', async (_req, res) => {
    let prices: Micro[] = [];
    try {
      prices = rentable(await offers()).map((o) => o.tickPrice + fee);
    } catch {
      // No offers to read: the document still describes the routes, priced as a range up to the door's maximum.
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.json(openApiDoc(prices, MAX_TICK_PRICE + fee, microToUsdc, deps.contactEmail));
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

  // What a referrer has earned and been paid. Free; a hold shows as `held`, never its reason.
  app.get('/v1/referrals/:address', (req, res) => {
    if (!allowGet(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
    const a = parseReferral(req.params.address, []);
    if (a === undefined || a === 'bad_referral') return void res.status(400).json({ error: 'bad_referral' });
    const r = deps.referrals;
    const rec = r?.store.get(a);
    const earned = rec?.earned ?? 0n;
    const paid = rec?.paid ?? 0n;
    res.json({
      address: a,
      bps: r?.bps ?? 0,
      hours: rec?.hours ?? 0,
      earned: earned.toString(),
      paid: paid.toString(),
      owed: (earned - paid).toString(),
      held: rec?.held !== undefined,
      payouts: (r?.log?.sentTo(a, 50) ?? []).map((p) => ({ amount: p.amount.toString(), tx: p.tx, at: p.at })),
    });
  });

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
      const offer = rec && offerOfSnapshot(rec.offer);
      res.json({ lease, stopped: rec?.stopped ?? false, ...(offer ? { offer: publicOffer(offer, registry.get(offer.hostId), leaseFee(id), false, shareFor(offer, leaseFee(id))) } : {}) });
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

  // A directory that lists Charter (x402-list.com) checks ownership by reading a token here.
  // express.static skips dot paths, so this one file is served by name, from web/well-known.
  app.get('/.well-known/x402list.txt', (_req, res) => {
    const file = join(webDir, 'well-known', 'x402list.txt');
    if (!existsSync(file)) return void res.status(404).json({ error: 'not_found' });
    res.type('text/plain').send(readFileSync(file, 'utf8'));
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
