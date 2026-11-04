import { due, isHome, onBootFailed, onHomeRestarted, onJobExit } from '../lease.js';
import { offerToEvent } from '../offer.js';
import type { ToonCli } from '../toon-cli.js';
import type { Lease, Offer } from '../types.js';
import { sweepDue, type HomeStore } from './homes.js';
import type { Runner } from './runner.js';
import { outputPartCount } from './server.js';
import type { LeaseStore } from './store.js';

/** A lease may stay `booting` this long before it is closed `boot_failed`. */
export const BOOT_TIMEOUT_MS = 120_000;
/** An offer stays valid this long, and is republished every OFFER_REPUBLISH_MS. */
export const OFFER_LIFETIME_MS = 45 * 60_000;
export const OFFER_REPUBLISH_MS = 20 * 60_000;
/** How often closed homes are checked against the retention rules. */
export const HOME_SWEEP_MS = 3_600_000;

export interface LoopDeps {
  store: LeaseStore;
  runner: Runner;
  now: () => number;
  /** Lease ids whose `runner.exited` is already being awaited. Created on first use. */
  watched?: Set<string>;
  /** Required once any home lease exists. */
  homes?: HomeStore;
  /** Home ids whose onion conf this process has written. Created on first use. */
  published?: Set<string>;
  log?: (msg: string) => void;
}

function isLive(l: Lease): boolean {
  return l.state === 'booting' || l.state === 'awaiting_first_tick' || l.state === 'running';
}

function liveHomeIds(deps: LoopDeps): Set<string> {
  const ids = new Set<string>();
  for (const l of deps.store.all()) if (isLive(l) && l.homeId) ids.add(l.homeId);
  return ids;
}

/** Anon or docker trouble with one home is logged, never thrown: it must not stall the loop. */
async function tryHome(deps: LoopDeps, what: string, f: () => Promise<void>): Promise<boolean> {
  try {
    await f();
    return true;
  } catch (e) {
    deps.log?.(`home ${what} failed: ${String(e)}`);
    return false;
  }
}

/**
 * After a home lease closed and its container stopped: remove a home that never paid, or drop a
 * paid one's onion and keep its disk for the retention time. The server may open a new lease on the
 * same home as soon as the old one is written closed, so liveness is read again after every await.
 */
async function releaseHome(deps: LoopDeps, l: Lease, now: number): Promise<void> {
  const homeId = l.homeId;
  if (!homeId) return;
  const heldElsewhere = () => liveHomeIds(deps).has(homeId);
  if (heldElsewhere()) return;
  deps.published?.delete(homeId);
  const rec = deps.homes?.get(homeId);
  if (l.paidIntervals === 0) {
    // A returning home that paid on an earlier lease keeps its disk; only a never-paid one goes.
    if (rec?.paidOnce) return;
    // removeHome retires the onion itself; no await sits between the check above and this call.
    const ok = await tryHome(deps, `remove ${homeId}`, () => deps.runner.removeHome(homeId));
    if (!ok) return;
    if (heldElsewhere()) {
      deps.log?.(`home ${homeId}: re-opened while it was being removed; record kept`);
      return;
    }
    deps.homes?.delete(homeId);
    return;
  }
  await tryHome(deps, `retire ${homeId}`, () => deps.runner.retireHome(homeId));
  if (!rec) {
    deps.log?.(`home ${homeId}: no record to mark closed`);
    return;
  }
  deps.homes!.put({ ...(deps.homes!.get(homeId) ?? rec), paidOnce: true, lastClosedAt: now });
}

/** Close, stop, and for a home release it. */
async function closeAndStop(deps: LoopDeps, l: Lease, reason: NonNullable<Lease['closedReason']>, now: number): Promise<void> {
  const closed = close(deps, l, reason);
  await stop(deps, l.id);
  if (isHome(closed)) await releaseHome(deps, closed, now);
}

/** A running home: write its onion conf once per process, and fill in its address once anon has one. */
async function tendHome(deps: LoopDeps, l: Lease): Promise<void> {
  const homeId = l.homeId;
  if (!homeId) return;
  const published = (deps.published ??= new Set());
  if (!published.has(homeId) && deps.homes?.get(homeId)) {
    if (await tryHome(deps, `publish ${homeId}`, () => deps.runner.publishHome(homeId))) published.add(homeId);
  }
  if (l.access == null) {
    let access = null;
    try {
      access = await deps.runner.homeAccess(homeId);
    } catch (e) {
      deps.log?.(`home ${homeId}: access unreadable: ${String(e)}`);
    }
    // Re-read: a tick may have been paid while anon was asked.
    const cur = deps.store.get(l.id);
    if (access && cur?.state === 'running') deps.store.put({ ...cur, access });
  }
}

function close(deps: LoopDeps, l: Lease, reason: NonNullable<Lease['closedReason']>): Lease {
  const closed: Lease = { ...l, state: 'closed', closedReason: reason };
  deps.store.put(closed);
  return closed;
}

async function stop(deps: LoopDeps, id: string): Promise<void> {
  try {
    await deps.runner.stop(id);
  } catch (e) {
    deps.log?.(`stop ${id} failed: ${String(e)}`);
  }
}

async function partsFor(deps: LoopDeps, id: string): Promise<number> {
  try {
    return outputPartCount((await deps.runner.output(id)).length);
  } catch (e) {
    // bad_output, or no result.json: the lease is done with nothing to read back.
    deps.log?.(`output for ${id} unreadable: ${String(e)}`);
    return 0;
  }
}

/** Wait once for the container to exit; a lease still open then becomes `done`. */
function watchExit(deps: LoopDeps, id: string): void {
  void (async () => {
    let code: number;
    try {
      code = await deps.runner.exited(id);
    } catch {
      // The container was removed (closed lease) or docker could not say. Nothing to record.
      return;
    }
    const parts = code === 0 ? await partsFor(deps, id) : 0;
    const cur = deps.store.get(id);
    if (!cur) return;
    const next = onJobExit(cur, parts);
    if (next !== cur) deps.store.put(next);
  })();
}

/**
 * Runs every second: closes unpaid and stuck leases, and starts exit watches on started containers.
 * Ticks arrive while this awaits `stop`, so each lease is re-read, and judged
 * against a fresh clock, right before it is decided; the write goes before the await.
 */
export async function windowTick(deps: LoopDeps): Promise<void> {
  const watched = (deps.watched ??= new Set());
  for (const { id } of deps.store.all()) {
    const l = deps.store.get(id);
    if (!l) continue;
    const now = deps.now();
    if (l.state === 'booting') {
      if (now > l.createdAt + BOOT_TIMEOUT_MS) {
        const failed = onBootFailed(l);
        deps.store.put(failed);
        await stop(deps, id);
        if (isHome(failed)) await releaseHome(deps, failed, now);
      }
      continue;
    }
    if (l.state !== 'awaiting_first_tick' && l.state !== 'running') continue;
    const reason = due(l, now);
    if (reason !== null) {
      await closeAndStop(deps, l, reason, now);
      continue;
    }
    if (isHome(l)) {
      // A home's exit is not the end of its lease: no exit watch, only its onion and address.
      if (l.state === 'running' && l.startedAt !== undefined) await tendHome(deps, l);
      continue;
    }
    // Only a started container is watched: `docker wait` on one that is only created returns at once.
    if (l.state === 'running' && l.startedAt !== undefined && !watched.has(id)) {
      watched.add(id);
      watchExit(deps, id);
    }
  }
}

/**
 * Once at boot: a lease whose container is not running after a restart is closed, and its container
 * (one that was only created, or never made) is removed. A paid running home is brought back instead.
 */
export async function reconcile(deps: LoopDeps): Promise<void> {
  for (const l of deps.store.all()) {
    if (!isLive(l)) continue;
    if (await deps.runner.alive(l.id)) continue;
    const now = deps.now();
    if (isHome(l) && l.state === 'running') {
      await restartHome(deps, l, now);
      continue;
    }
    await closeAndStop(deps, l, 'host_restart', now);
  }
}

/** A running home whose container is gone: re-create it while it is paid, close it once it is not. */
async function restartHome(deps: LoopDeps, l: Lease, now: number): Promise<void> {
  const reason = due(l, now);
  if (reason !== null) return closeAndStop(deps, l, reason, now);
  try {
    // docker's own restart may have left a dead container holding the volume: remove it first, so the
    // volume can be re-pointed. Then, after a host reboot, re-attach the disk before creating again.
    await deps.runner.stop(l.id);
    if (l.homeId) await deps.runner.ensureHome(l.homeId);
    await deps.runner.create(l.id, l.job);
    await deps.runner.start(l.id);
  } catch (e) {
    deps.log?.(`home lease ${l.id}: restart failed: ${String(e)}`);
    return closeAndStop(deps, l, 'host_restart', now);
  }
  deps.store.put(onHomeRestarted(l));
  const homeId = l.homeId;
  if (homeId && (await tryHome(deps, `publish ${homeId}`, () => deps.runner.publishHome(homeId)))) {
    (deps.published ??= new Set()).add(homeId);
  }
}

/** Removes every home the retention rules say is done with. Returns the removed ids. */
export async function homeSweep(deps: LoopDeps): Promise<string[]> {
  if (!deps.homes) return [];
  const removed: string[] = [];
  for (const rec of sweepDue(deps.homes, liveHomeIds(deps), deps.now())) {
    if (await tryHome(deps, `remove ${rec.homeId}`, () => deps.runner.removeHome(rec.homeId))) {
      deps.homes.delete(rec.homeId);
      removed.push(rec.homeId);
    }
  }
  return removed;
}

export interface OfferDeps {
  cli: Pick<ToonCli, 'publishEvent'>;
  offer: Offer;
  relayUrl: string;
  now: () => number;
}

/** Publishes the offer, good for the next 45 minutes. Returns the event id. */
export async function offerTick(deps: OfferDeps): Promise<string> {
  const ev = offerToEvent({ ...deps.offer, expiresAt: deps.now() + OFFER_LIFETIME_MS });
  return deps.cli.publishEvent(ev, deps.relayUrl);
}

export interface LandDeps {
  cli: Pick<ToonCli, 'channels' | 'land'>;
  store: LeaseStore;
}

export interface LandResult {
  txs: Array<{ chain: string; tx: string }>;
  errors: string[];
  /** Ids of the leases that got a landing recorded. */
  recorded: string[];
}

/** Lands every inbound channel, then records the first tx on each paid lease that has none. */
export async function landAll(deps: LandDeps): Promise<LandResult> {
  const result: LandResult = { txs: [], errors: [], recorded: [] };
  const inbound = (await deps.cli.channels()).filter((c) => c.direction === 'inbound');
  for (const ch of inbound) {
    try {
      result.txs.push(...(await deps.cli.land(ch.id)));
    } catch (e) {
      result.errors.push(`channel ${ch.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const first = result.txs[0];
  if (!first) return result;
  for (const l of deps.store.all()) {
    if (l.paidIntervals > 0 && !l.landing) {
      deps.store.put({ ...l, landing: { chain: first.chain, tx: first.tx, shared: true } });
      result.recorded.push(l.id);
    }
  }
  return result;
}
