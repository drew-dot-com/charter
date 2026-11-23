#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BatchSettlementChannelManager } from '@x402/evm/batch-settlement/server';
import { execFileExec } from '../exec.js';
import { offerToJson } from '../offer.js';
import type { Offer } from '../types.js';
import { hostX402Command, idleMsFor, REFUND_IDLE_HOST_MS, startClaims } from '../x402/claims.js';
import { BASE_USDC, buildSchemes, facilitatorOffersBatch, parseClaimKey, type X402Config } from '../x402/seller.js';
import { loadConfig } from './config.js';
import { doorWatch, hostRegistrar } from './door-link.js';
import { HOME_SWEEP_MS, homesFree, OFFER_LIFETIME_MS, homeSweep, reconcile, windowTick } from './loop.js';
import { HomeStore } from './homes.js';
import { hostHttpApp } from './http.js';
import { dockerRunner } from './runner.js';
import { LeaseStore } from './store.js';
import { hostTickGate } from './x402.js';

/** How often the host checks whether its free home slots changed, to register again. */
const OFFER_FREE_CHECK_MS = 60_000;

const USAGE = 'usage: charter-host run | offer --print | x402 status | claim';

function every(ms: number, fn: () => Promise<unknown>, what: string): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    fn()
      .catch((e) => console.error(`${what} failed: ${String(e)}`))
      .finally(() => {
        busy = false;
      });
  }, ms);
}

/** The host's x402 config: ticks are paid to CHARTER_HOST_PAY_TO, its claim key signs claims, records under the data dir. */
function x402ConfigOf(cfg: ReturnType<typeof loadConfig>): X402Config {
  return {
    payTo: cfg.payTo,
    network: 'eip155:8453',
    facilitatorUrl: cfg.facilitatorUrl,
    claimKey: parseClaimKey(readFileSync(cfg.claimKeyFile, 'utf8')),
    channelDir: join(cfg.dataDir, 'x402-channels'),
  };
}

function claimManager(cfg: ReturnType<typeof loadConfig>, x402: X402Config, schemes: ReturnType<typeof buildSchemes>): BatchSettlementChannelManager {
  return new BatchSettlementChannelManager({ scheme: schemes.batch, facilitator: schemes.facilitator, receiver: cfg.payTo, token: BASE_USDC, network: x402.network });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run' && cmd !== 'offer' && cmd !== 'x402') {
    console.error(USAGE);
    return 2;
  }
  const cfg = loadConfig(process.env);
  const now = () => Date.now();

  if (cmd === 'x402') {
    const x402 = x402ConfigOf(cfg);
    const schemes = buildSchemes(x402);
    return hostX402Command(rest, claimManager(cfg, x402, schemes), schemes.batch.getStorage(), now, (m) => console.log(m));
  }

  if (cmd === 'offer') {
    if (!rest.includes('--print')) {
      console.error(USAGE);
      return 2;
    }
    console.log(JSON.stringify(JSON.parse(offerToJson({ ...cfg.offer, expiresAt: now() + OFFER_LIFETIME_MS })), null, 2));
    return 0;
  }

  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const store = new LeaseStore(join(cfg.dataDir, 'leases.json'));

  const log = (m: string) => console.error(m);
  const homes = cfg.home ? new HomeStore(join(cfg.dataDir, 'homes.json')) : undefined;
  const h = cfg.home;
  const runner = dockerRunner({
    exec: execFileExec('docker'),
    outRoot: join(cfg.dataDir, 'out'),
    allow: cfg.allowImages,
    proxy: cfg.proxy,
    jobDns: cfg.jobDns,
    runtime: cfg.runtime,
    home:
      h && homes
        ? {
            homesDir: h.dir,
            network: h.network,
            gateway: h.gateway,
            socksPort: h.socksPort,
            httpPort: h.httpPort,
            diskGib: h.diskGib,
            root: h.root,
            homes,
            ...(h.publicHost ? { publicHost: h.publicHost } : {}),
            ...(h.onion && h.anonHsDir && h.anonPidFile
              ? { anon: { hsDir: h.anonHsDir, homesDir: h.dir, pidFile: h.anonPidFile } }
              : {}),
            tools: {
              truncate: execFileExec('truncate'),
              mkfs: execFileExec('mkfs.ext4'),
              // Loop devices need root; -n fails fast instead of waiting on a password prompt.
              losetup: (args, env) => execFileExec('sudo')(['-n', 'losetup', ...args], env),
            },
            doorUrl: cfg.doorUrl,
          }
        : undefined,
  });
  // One object for reconcile, windowTick and homeSweep, so watched and published persist across ticks.
  const deps = { store, runner, now, homes, log, published: new Set<string>(), onionBeside: !!(h?.publicHost && h.onion) };
  await reconcile(deps);

  // Ticks are paid to CHARTER_HOST_PAY_TO by the door's batch-settlement vouchers, claimed here through the facilitator.
  const x402 = x402ConfigOf(cfg);
  const schemes = buildSchemes(x402);
  if (!(await facilitatorOffersBatch(x402.facilitatorUrl, x402.network))) {
    console.error(`charter-host: ${x402.facilitatorUrl} does not list batch-settlement on ${x402.network}; ticks cannot settle`);
  }
  const watch = doorWatch({ doorUrl: cfg.doorUrl, log });
  await watch.refresh();
  watch.start();

  const offerNow = (): Offer => {
    const free = cfg.offer.home ? homesFree(store, cfg.maxHomes) : undefined;
    const base = { ...cfg.offer, expiresAt: now() + OFFER_LIFETIME_MS };
    return cfg.offer.home && free !== undefined ? { ...base, home: { ...cfg.offer.home, free } } : base;
  };
  const origin = new URL(cfg.hostUrl).origin;
  const app = hostHttpApp({
    store, runner, offer: cfg.offer, now, maxLeases: cfg.maxLeases, maxHomes: cfg.maxHomes, log, homes, published: deps.published,
    door: watch.door,
    origin: () => origin,
    tickGate: hostTickGate(x402, () => cfg.offer.tickPrice, schemes, watch.door),
    offerJson: () => JSON.parse(offerToJson(offerNow())) as unknown,
  });
  const server = app.listen(cfg.port, '127.0.0.1');
  const claims = claimManager(cfg, x402, schemes);
  // Vouchers are claimed once the channel has been quiet for two intervals (10 minutes at least), as the door
  // claims its own; the door's unspent deposit is refunded only after a quiet week, so a renter's home outlives
  // a quiet few days.
  startClaims(claims, { log: (m) => console.log(m), idleMs: () => idleMsFor([cfg.offer.intervalSeconds]), refundIdleMs: () => REFUND_IDLE_HOST_MS });

  const registrar = hostRegistrar({ doorUrl: cfg.doorUrl, hostUrl: cfg.hostUrl, log });
  let lastFree = cfg.offer.home ? homesFree(store, cfg.maxHomes) : undefined;
  // Free home slots change when a home opens or closes: the door is told at once, not at its next refresh.
  const registerIfFreeChanged = async () => {
    if (!cfg.offer.home) return;
    const free = homesFree(store, cfg.maxHomes);
    if (free === lastFree) return;
    lastFree = free;
    await registrar.register();
  };
  const timers = [every(1000, () => windowTick(deps), 'window tick'), every(OFFER_FREE_CHECK_MS, registerIfFreeChanged, 'offer free check')];
  if (homes) timers.push(every(HOME_SWEEP_MS, () => homeSweep(deps), 'home sweep'));
  void registrar.register();
  console.log(`charter-host listening on 127.0.0.1:${cfg.port} as ${cfg.hostUrl}, paid to ${cfg.payTo}, door ${cfg.doorUrl}`);

  await new Promise<void>((resolve) => {
    const stopAll = () => {
      timers.forEach(clearInterval);
      watch.stop();
      registrar.stop();
      void claims.stop();
      server.close();
      resolve();
    };
    process.once('SIGINT', stopAll);
    process.once('SIGTERM', stopAll);
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
