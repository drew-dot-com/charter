import { GRACE_MS, due, onBootFailed, onJobExit } from '../lease.js';
import { offerToEvent } from '../offer.js';
import type { ToonCli } from '../toon-cli.js';
import type { Lease, Offer } from '../types.js';
import type { Runner } from './runner.js';
import { outputPartCount } from './server.js';
import type { LeaseStore } from './store.js';

/** A lease may stay `booting` this long before it is closed `boot_failed`. */
export const BOOT_TIMEOUT_MS = 120_000;
/** An offer stays valid this long, and is republished every OFFER_REPUBLISH_MS. */
export const OFFER_LIFETIME_MS = 30 * 60_000;
export const OFFER_REPUBLISH_MS = 10 * 60_000;

export interface LoopDeps {
  store: LeaseStore;
  runner: Runner;
  now: () => number;
  /** Lease ids whose `runner.exited` is already being awaited. Created on first use. */
  watched?: Set<string>;
  log?: (msg: string) => void;
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

/** Runs every second: closes unpaid and stuck leases, and starts exit watches. */
export async function windowTick(deps: LoopDeps): Promise<void> {
  const watched = (deps.watched ??= new Set());
  const now = deps.now();
  for (const l of deps.store.all()) {
    if (l.state === 'booting') {
      if (now > l.createdAt + BOOT_TIMEOUT_MS) {
        deps.store.put(onBootFailed(l));
        await stop(deps, l.id);
      }
      continue;
    }
    if (l.state !== 'awaiting_first_tick' && l.state !== 'running') continue;
    const reason = due(l, now, GRACE_MS);
    if (reason !== null) {
      close(deps, l, reason);
      await stop(deps, l.id);
      continue;
    }
    if (!watched.has(l.id)) {
      watched.add(l.id);
      watchExit(deps, l.id);
    }
  }
}

/** Once at boot: a lease whose container is gone after a restart is closed. */
export async function reconcile(deps: LoopDeps): Promise<void> {
  for (const l of deps.store.all()) {
    if (l.state !== 'booting' && l.state !== 'awaiting_first_tick' && l.state !== 'running') continue;
    if (!(await deps.runner.alive(l.id))) close(deps, l, 'host_restart');
  }
}

export interface OfferDeps {
  cli: Pick<ToonCli, 'publishEvent'>;
  offer: Offer;
  relayUrl: string;
  now: () => number;
}

/** Publishes the offer, good for the next 30 minutes. Returns the event id. */
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
