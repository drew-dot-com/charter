// Test support only: a host app (hostHttpApp) on a loopback port, and the door's HostApi (httpHostApi) to it.
// The tick gate asks no payment; a stand-in door payer counts a tick's price as charged when the host
// answers it 2xx, as a settling x402 server would.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { httpHostApi, type DoorPayer } from '../door/host-http.js';
import { HostQueue } from '../door/host-queue.js';
import { HOSTS_FILE, HostRegistry, type HostRecord } from '../door/hosts.js';
import { stubGate } from '../door/x402.js';
import { onJobExit } from '../lease.js';
import { hostHttpApp } from '../host/http.js';
import type { Runner } from '../host/runner.js';
import { outputPartCount } from '../host/server.js';
import { LeaseStore } from '../host/store.js';
import type { Offer } from '../types.js';
import type { HostApi } from './host-api.js';

export const OFFER: Offer = {
  id: 'o1', hostId: 'ab'.repeat(32), url: 'https://host.example', payTo: `0x${'3'.repeat(40)}`, cpu: 1, memoryMiB: 1024,
  intervalSeconds: 30, firstTickGraceSeconds: 90, tickPrice: 5000n, openPrice: 0n, statusPrice: 0n, images: ['charter-job-fetch'],
  hiddenHost: true, hiddenEgress: false, expiresAt: 9_999_999_999_000,
};
/** The live host's schedule since 2026-11-04: one hour at 0.007 USDC. */
export const HOURLY: Offer = { ...OFFER, id: 'o-hourly', intervalSeconds: 3600, tickPrice: 7000n };

/** The test door's key. */
export const DOOR_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;

/**
 * A door registry in `dir` holding these host ids as listed hosts that passed one probe (OFFER's by default).
 * Written as a file, since `register` derives the id from a URL and these ids are fixed.
 */
export function listedRegistry(dir: string, hostIds: string[] = [OFFER.hostId]): HostRegistry {
  const file = join(dir, HOSTS_FILE);
  const hosts: HostRecord[] = hostIds.map((hostId, i) => ({
    hostId, url: `https://host${i}.example`, state: 'listed', registeredAt: 0,
    probes: { passed: 1, failed: 0, consecutiveFailed: 0, lastAt: 0 },
    leases: { opened: 0, finished: 0, hostFailed: 0, consecutiveHostFailed: 0 },
    intervalsPaid: 0, homeTested: false,
  }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ hosts, homes: {}, firstProbes: { day: '', count: 0 } }));
  return new HostRegistry(file);
}

export type CallKind = 'open' | 'tick' | 'status';

export interface TestHost {
  store: LeaseStore;
  /** The door's HostApi to this host, for the offer it serves. */
  api: HostApi;
  /** Calls sent, by kind. */
  sent: Record<CallKind, number>;
  /** Wraps every call: `send` makes it. Set by a test to act before or after one, or to change its answer. */
  hook?: (kind: CallKind, send: () => Promise<Response>) => Promise<Response>;
  clock: { t: number };
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  close: () => void;
}

export interface TestHostOpts {
  runner?: Partial<Runner>;
  /** Called after each answered tick, to simulate the job. */
  afterTick?: (h: TestHost, paidIntervals: number) => void;
  /** The host's clock runs this far ahead (or behind, when negative) of the tenant's. */
  skewMs?: number;
  /** The offer the host serves; OFFER (30 s intervals) unless given. */
  offer?: Offer;
}

function kindOf(method: string, path: string): CallKind {
  if (method === 'POST') return path.endsWith('/ticks') ? 'tick' : 'open';
  return 'status';
}

export async function testHost(opts: TestHostOpts = {}): Promise<TestHost> {
  const store = new LeaseStore();
  const clock = { t: 1_000_000 };
  const runner: Runner = {
    create: async () => undefined,
    start: async () => undefined,
    exited: async () => 0,
    stop: async () => undefined,
    output: async () => Buffer.alloc(0),
    alive: async () => true,
    ready: async () => true,
    ...opts.runner,
  } as Runner;
  const offer = opts.offer ?? OFFER;
  const hostNow = () => clock.t + (opts.skewMs ?? 0);
  const account = privateKeyToAccount(DOOR_KEY);
  let origin = '';
  const app = hostHttpApp({
    store, runner, offer, now: hostNow,
    door: () => account.address, origin: () => origin, tickGate: stubGate(() => offer.tickPrice), offerJson: () => ({}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const sent: Record<CallKind, number> = { open: 0, tick: 0, status: 0 };
  const sleeps: number[] = [];
  let charged = 0n;
  const host: TestHost = {
    store, sent, clock, sleeps,
    sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)),
    close: () => void server.close(),
    api: undefined as unknown as HostApi,
  };
  const counted: typeof fetch = async (input, init) => {
    const req = new Request(input as string | URL | Request, init);
    const kind = kindOf(req.method, new URL(req.url).pathname);
    sent[kind]++;
    const send = () => fetch(req);
    const res = await (host.hook ? host.hook(kind, send) : send());
    if (kind === 'tick' && res.status === 200) {
      const body = (await res.clone().json()) as { paidIntervals?: number };
      if (typeof body.paidIntervals === 'number') opts.afterTick?.(host, body.paidIntervals);
    }
    return res;
  };
  const payer: DoorPayer = {
    address: account.address,
    account,
    paidFetch: (_o, price) => (async (input, init) => {
      const res = await counted(input, init);
      if (res.ok) charged += price;
      return res;
    }) as typeof fetch,
    charged: async () => charged,
    clearPendingDeposit: () => undefined,
    resyncAll: async () => undefined,
    channels: async () => [],
    resync: async () => undefined,
    chargedNow: () => charged,
  };
  // The door signs with the host's clock, so a skewed host still takes its signature.
  host.api = httpHostApi({ ...offer, url: origin }, { payer, queue: new HostQueue(), fetch: counted, now: hostNow });
  return host;
}

/** Simulates the job exiting by itself: the lease goes `done` with `bytes` as its output. */
export function exitJob(h: TestHost, leaseId: string, bytes: Buffer): void {
  h.store.put(onJobExit(h.store.get(leaseId)!, outputPartCount(bytes.length)));
}
