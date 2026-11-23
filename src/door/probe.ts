// The door's probe: a paid python job that hashes a nonce the door picked.
import { createHash, randomBytes } from 'node:crypto';
import { pythonJob } from '../jobs.js';
import { HostError, type HostApi } from '../tenant/host-api.js';
import type { Micro, Offer } from '../types.js';
import { CapitalCapError, DepositPendingError, type DepositFor } from './host-http.js';
import type { HostRegistry } from './hosts.js';

/** Gap between status reads while a probe job runs. */
export const PROBE_POLL_MS = 2000;
/** The longest a probe waits for its job, whatever the host's interval. */
export const PROBE_MAX_WAIT_MS = 3_600_000;
/** How often startProbes looks for due probes. */
export const PROBE_ROUND_MS = 10 * 60_000;
/** The most a probe pays for its one tick (micro-USDC), unless the door sets CHARTER_PROBE_MAX_TICK. */
export const DEFAULT_PROBE_MAX_TICK: Micro = 10_000n;

/** The probe job's script. `nonce` is lowercase hex, so it is safe inside a Python bytes literal. */
export function PROBE_SCRIPT(nonce: string): string {
  if (!/^[0-9a-f]{16,128}$/.test(nonce)) throw new Error('a probe nonce is 16 to 128 lowercase hex digits');
  return `import hashlib\nprint(hashlib.sha256(b"${nonce}").hexdigest())`;
}

export interface ProbeResult {
  passed: boolean;
  /** price_too_high, wrong_output, timeout, host_error (a non-2xx answer), unreachable, or the lease's close reason. */
  reason?: string;
}

/**
 * Refuses an offer whose tick costs more than `probeMaxTick` (price_too_high) before opening anything. Else
 * opens the probe job on the host, pays tick 0, reads the lease every PROBE_POLL_MS until it is done or one
 * interval (at most PROBE_MAX_WAIT_MS) has passed, then reads the first output part: it passes when that
 * carries sha256(nonce) in hex. A refusal from the door's own capital limits (CapitalCapError,
 * DepositPendingError) is thrown, not failed: the host did nothing wrong.
 */
export async function probeHost(
  api: HostApi,
  offer: Offer,
  o: { nonce: string; probeMaxTick: Micro; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<ProbeResult> {
  const job = pythonJob(PROBE_SCRIPT(o.nonce));
  const want = createHash('sha256').update(o.nonce).digest('hex');
  const fail = (reason: string): ProbeResult => ({ passed: false, reason });
  if (offer.tickPrice > o.probeMaxTick) return fail('price_too_high');
  try {
    const opened = await api.open(job);
    if (opened.state === 'closed') return fail(opened.closedReason ?? 'boot_failed');
    await api.tick(opened.leaseId, 0);
    const until = o.now() + Math.min(offer.intervalSeconds * 1000, PROBE_MAX_WAIT_MS);
    for (;;) {
      const lease = await api.status(opened.leaseId);
      if (lease.state === 'done') {
        if (!lease.outputParts) return fail('wrong_output');
        // The digest is the script's only output, well inside the first part.
        const p = await api.outputPart(opened.leaseId, 0);
        return Buffer.from(p.data, 'base64').toString('utf8').includes(want) ? { passed: true } : fail('wrong_output');
      }
      if (lease.state === 'closed') return fail(lease.closedReason ?? 'closed');
      if (o.now() >= until) return fail('timeout');
      await o.sleep(PROBE_POLL_MS);
    }
  } catch (e) {
    if (e instanceof CapitalCapError || e instanceof DepositPendingError) throw e;
    return fail(e instanceof HostError ? 'host_error' : 'unreachable');
  }
}

/**
 * Probes due hosts (HostRegistry.dueProbes) now and every PROBE_ROUND_MS, one after another, so each sees the
 * capital the one before it locked. A round skips a host with nothing `locked` that `depositFor` answers
 * 'over_cap' for, before anything else: no first probe counted, no lease opened, nothing recorded. A host whose
 * channel already holds funds needs no deposit and is never skipped for capital. Otherwise it fetches the host's offer afresh
 * (a bad one fails the probe), then runs probeHost and records the result. A probe the door's capital still
 * refuses mid-way is logged and records nothing. A round still running when the next is due is not doubled.
 * Returns a stop function.
 */
export function startProbes(d: {
  registry: HostRegistry;
  apiOf: (o: Offer) => HostApi;
  fetchOffer: (url: string) => Promise<Offer | 'bad_offer'>;
  depositFor: DepositFor;
  /** What the door has put into the host's channels and not withdrawn (as for capitalAllocator). */
  locked: (hostId: string) => bigint;
  probeMaxTick: Micro;
  perDay: number;
  now: () => number;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): () => void {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let busy = false;
  let stopped = false;

  const probe = async (hostId: string): Promise<void> => {
    const r = d.registry.get(hostId);
    if (!r) return;
    // A host whose channel already holds funds needs no new deposit, so a full tier does not hold it back.
    if (d.locked(hostId) === 0n && d.depositFor(hostId) === 'over_cap') {
      d.log(`probe ${r.url}: waits for door capital`);
      return;
    }
    if (r.state === 'probing') d.registry.countFirstProbe(d.now());
    let offer: Offer | 'bad_offer';
    try {
      offer = await d.fetchOffer(r.url);
    } catch {
      offer = 'bad_offer';
    }
    if (offer === 'bad_offer') {
      d.registry.probeResult(hostId, false, d.now());
      d.log(`probe ${r.url}: failed, bad_offer`);
      return;
    }
    d.registry.setOffer(hostId, offer, d.now());
    try {
      const res = await probeHost(d.apiOf(offer), offer, { nonce: randomBytes(16).toString('hex'), probeMaxTick: d.probeMaxTick, now: d.now, sleep });
      d.registry.probeResult(hostId, res.passed, d.now());
      d.log(`probe ${r.url}: ${res.passed ? 'passed' : `failed, ${res.reason}`}`);
    } catch (e) {
      d.log(`probe ${r.url}: waits for door capital, ${(e as Error).message}`);
    }
  };

  const round = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      const now = d.now();
      for (const id of d.registry.dueProbes(now, d.registry.firstProbesToday(now), d.perDay)) {
        if (stopped) return;
        await probe(id).catch((e) => d.log(`probe ${id}: ${(e as Error).message}`));
      }
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void round(), PROBE_ROUND_MS);
  timer.unref();
  void round();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
