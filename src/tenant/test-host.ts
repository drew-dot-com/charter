// Test support only: a fake Payer that calls Task 6's hostApps over local HTTP.
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { onJobExit } from '../lease.js';
import type { PacketAnswer, PacketRequest, Payer } from '../payer.js';
import { decodeBody } from '../payer.js';
import { hostApps, outputPartCount } from '../host/server.js';
import type { Runner } from '../host/runner.js';
import { LeaseStore } from '../host/store.js';
import type { Micro, Offer } from '../types.js';

export const OFFER: Offer = {
  id: 'o1', hostPubkey: 'ab'.repeat(32), ilpBase: 'g.test', sealKey: 'http://x.anyone/ilp', cpu: 1, memoryMiB: 1024,
  intervalSeconds: 30, tickPrice: 5000n, openPrice: 1000n, statusPrice: 100n, images: ['charter-job-fetch'],
  hiddenHost: true, hiddenEgress: false, expiresAt: 9_999_999_999_000,
};

export interface TestHost {
  store: LeaseStore;
  payer: Payer;
  /** Packets sent, by app name (`charter-open` and so on). */
  sent: Record<string, number>;
  /** Every dest and sealKey the payer was handed. */
  seen: Array<{ dest: string; sealKey: string; path: string }>;
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
}

export async function testHost(opts: TestHostOpts = {}): Promise<TestHost> {
  const store = new LeaseStore();
  const clock = { t: 1_000_000 };
  const runner: Runner = {
    start: async () => undefined,
    exited: async () => 0,
    stop: async () => undefined,
    output: async () => Buffer.alloc(0),
    alive: async () => true,
    ...opts.runner,
  };
  const apps = hostApps({ store, runner, offer: OFFER, now: () => clock.t + (opts.skewMs ?? 0) });
  const servers: Array<import('node:http').Server> = [];
  const listen = async (app: Express) => {
    const s = app.listen(0, '127.0.0.1');
    servers.push(s);
    await new Promise((res) => s.once('listening', res));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const urls: Record<string, string> = {
    'charter-open': await listen(apps.open),
    'charter-tick': await listen(apps.tick),
    'charter-status': await listen(apps.status),
  };
  const sent: Record<string, number> = { 'charter-open': 0, 'charter-tick': 0, 'charter-status': 0 };
  const seen: TestHost['seen'] = [];
  const sleeps: number[] = [];
  const host: TestHost = {
    store, sent, seen, clock, sleeps,
    sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)),
    close: () => servers.forEach((s) => s.close()),
    payer: undefined as unknown as Payer,
  };
  host.payer = {
    async send(dest: string, req: PacketRequest, o: { sealKey: string; amount: Micro }): Promise<PacketAnswer> {
      const app = dest.slice(dest.lastIndexOf('.') + 1);
      if (dest !== `${OFFER.ilpBase}.${app}` || !urls[app]) throw new Error(`unknown dest ${dest}`);
      sent[app]++;
      seen.push({ dest, sealKey: o.sealKey, path: req.path });
      const res = await fetch(urls[app] + req.path, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
      const body = decodeBody(await res.text());
      // Every packet is paid, 4xx and 5xx included.
      const answer = { status: res.status, body, paid: o.amount };
      if (app === 'charter-tick' && res.status === 200) {
        opts.afterTick?.(host, (body as { paidIntervals: number }).paidIntervals);
      }
      return answer;
    },
  };
  return host;
}

/** Simulates the job exiting by itself: the lease goes `done` with `bytes` as its output. */
export function exitJob(h: TestHost, leaseId: string, bytes: Buffer): void {
  h.store.put(onJobExit(h.store.get(leaseId)!, outputPartCount(bytes.length)));
}
