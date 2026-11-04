#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileExec } from '../exec.js';
import { offerToEvent, offerToJson } from '../offer.js';
import { ToonCli } from '../toon-cli.js';
import { loadConfig } from './config.js';
import { HOME_SWEEP_MS, OFFER_LIFETIME_MS, OFFER_REPUBLISH_MS, homeSweep, landAll, offerTick, reconcile, windowTick } from './loop.js';
import { HomeStore } from './homes.js';
import { dockerRunner } from './runner.js';
import { hostApps } from './server.js';
import { LeaseStore } from './store.js';

const USAGE = 'usage: charter-host run | land | offer --print';

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

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run' && cmd !== 'land' && cmd !== 'offer') {
    console.error(USAGE);
    return 2;
  }
  const cfg = loadConfig(process.env);
  const now = () => Date.now();

  if (cmd === 'offer') {
    if (!rest.includes('--print')) {
      console.error(USAGE);
      return 2;
    }
    console.log(JSON.stringify(offerToEvent({ ...cfg.offer, expiresAt: now() + OFFER_LIFETIME_MS }), null, 2));
    return 0;
  }

  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const store = new LeaseStore(join(cfg.dataDir, 'leases.json'));
  const cli = new ToonCli({ passphraseFile: cfg.passphraseFile });

  if (cmd === 'land') {
    const r = await landAll({ cli, store });
    for (const e of r.errors) console.error(e);
    if (r.txs.length === 0) {
      console.log(r.errors.length ? 'nothing landed' : 'no inbound channel or nothing to land');
      return r.errors.length ? 1 : 0;
    }
    for (const t of r.txs) console.log(`${t.chain} ${t.tx}`);
    console.log(`recorded on ${r.recorded.length} lease(s)`);
    return r.errors.length ? 1 : 0;
  }

  const log = (m: string) => console.error(m);
  const homes = cfg.home ? new HomeStore(join(cfg.dataDir, 'homes.json')) : undefined;
  const h = cfg.home;
  const runner = dockerRunner({
    exec: execFileExec('docker'),
    outRoot: join(cfg.dataDir, 'out'),
    allow: cfg.allowImages,
    proxy: cfg.proxy,
    runtime: cfg.runtime,
    home:
      h && homes
        ? {
            homesDir: h.dir,
            network: h.network,
            gateway: h.gateway,
            socksPort: h.socksPort,
            httpPort: h.httpPort,
            homes,
            anon: { hsDir: h.anonHsDir, homesDir: h.dir, pidFile: h.anonPidFile },
            tools: {
              truncate: execFileExec('truncate'),
              mkfs: execFileExec('mkfs.ext4'),
              // Loop devices need root; -n fails fast instead of waiting on a password prompt.
              losetup: (args, env) => execFileExec('sudo')(['-n', 'losetup', ...args], env),
            },
            offerJson: offerToJson({ ...cfg.offer, expiresAt: 0 }),
            connectorUrl: h.tenantConnectorUrl,
          }
        : undefined,
  });
  // One object for reconcile, windowTick and homeSweep, so watched and published persist across ticks.
  const deps = { store, runner, now, homes, log, published: new Set<string>() };
  await reconcile(deps);

  const apps = hostApps({
    store, runner, offer: cfg.offer, now, maxLeases: cfg.maxLeases, maxHomes: cfg.maxHomes, log, homes, published: deps.published,
  });
  const servers = [
    apps.open.listen(cfg.ports.open, '127.0.0.1'),
    apps.tick.listen(cfg.ports.tick, '127.0.0.1'),
    apps.status.listen(cfg.ports.status, '127.0.0.1'),
  ];
  const publish = async () => {
    const id = await offerTick({ cli, offer: cfg.offer, relayUrl: cfg.relayUrl, now });
    console.log(`offer published ${id}`);
  };
  const timers = [every(1000, () => windowTick(deps), 'window tick'), every(OFFER_REPUBLISH_MS, publish, 'offer publish')];
  if (homes) timers.push(every(HOME_SWEEP_MS, () => homeSweep(deps), 'home sweep'));
  publish().catch((e) => console.error(`offer publish failed: ${String(e)}`));
  console.log(`charter-host listening on 127.0.0.1 ${cfg.ports.open},${cfg.ports.tick},${cfg.ports.status}`);

  await new Promise<void>((resolve) => {
    const stopAll = () => {
      timers.forEach(clearInterval);
      servers.forEach((s) => s.close());
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
