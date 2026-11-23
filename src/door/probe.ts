// The door's probe: a paid python job that hashes a nonce the door picked.
import { createHash, randomBytes } from 'node:crypto';
import { pythonJob } from '../jobs.js';
import { HostError, type HostApi } from '../tenant/host-api.js';
import type { Offer } from '../types.js';
import { CapitalCapError, DepositPendingError } from './host-http.js';
import type { HostRegistry } from './hosts.js';

/** Gap between status reads while a probe job runs. */
export const PROBE_POLL_MS = 2000;
/** The longest a probe waits for its job, whatever the host's interval. */
export const PROBE_MAX_WAIT_MS = 3_600_000;
/** How often startProbes looks for due probes. */
export const PROBE_ROUND_MS = 10 * 60_000;

/** The probe job's script. `nonce` is lowercase hex, so it is safe inside a Python bytes literal. */
export function PROBE_SCRIPT(nonce: string): string {
  if (!/^[0-9a-f]{16,128}$/.test(nonce)) throw new Error('a probe nonce is 16 to 128 lowercase hex digits');
  return `import hashlib\nprint(hashlib.sha256(b"${nonce}").hexdigest())`;
}

export interface ProbeResult {
  passed: boolean;
  /** wrong_output, timeout, host_error (a non-2xx answer), unreachable, or the lease's close reason. */
  reason?: string;
}

/**
 * Opens the probe job on the host, pays tick 0, reads the lease every PROBE_POLL_MS until it is done or one
 * interval (at most PROBE_MAX_WAIT_MS) has passed, then reads the first output part: it passes when that
 * carries sha256(nonce) in hex. A refusal from the door's own capital limits (CapitalCapError,
 * DepositPendingError) is thrown, not failed: the host did nothing wrong.
 */
export async function probeHost(api: HostApi, offer: Offer, o: { nonce: string; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<ProbeResult> {
  const job = pythonJob(PROBE_SCRIPT(o.nonce));
  const want = createHash('sha256').update(o.nonce).digest('hex');
  const fail = (reason: string): ProbeResult => ({ passed: false, reason });
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
 * Probes due hosts (HostRegistry.dueProbes) now and every PROBE_ROUND_MS: fetches each host's offer afresh
 * (a bad one fails the probe), then runs probeHost and records the result. A host already being probed is
 * left alone; a probe the door's capital cannot fund is logged and records nothing. Returns a stop function.
 */
export function startProbes(d: {
  registry: HostRegistry;
  apiOf: (o: Offer) => HostApi;
  fetchOffer: (url: string) => Promise<Offer | 'bad_offer'>;
  perDay: number;
  now: () => number;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): () => void {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const running = new Set<string>();
  let stopped = false;

  const probe = async (hostId: string): Promise<void> => {
    const r = d.registry.get(hostId);
    if (!r) return;
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
      const res = await probeHost(d.apiOf(offer), offer, { nonce: randomBytes(16).toString('hex'), now: d.now, sleep });
      d.registry.probeResult(hostId, res.passed, d.now());
      d.log(`probe ${r.url}: ${res.passed ? 'passed' : `failed, ${res.reason}`}`);
    } catch (e) {
      d.log(`probe ${r.url}: waits for door capital, ${(e as Error).message}`);
    }
  };

  const round = (): void => {
    if (stopped) return;
    const now = d.now();
    for (const id of d.registry.dueProbes(now, d.registry.firstProbesToday(now), d.perDay)) {
      if (running.has(id)) continue;
      running.add(id);
      void probe(id)
        .catch((e) => d.log(`probe ${id}: ${(e as Error).message}`))
        .finally(() => running.delete(id));
    }
  };

  const timer = setInterval(round, PROBE_ROUND_MS);
  timer.unref();
  round();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
