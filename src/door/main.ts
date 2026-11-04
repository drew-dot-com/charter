#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToonClientPayer, serialized } from '../payer.js';
import { toonClientConfigFromEnv } from '../payer-env.js';
import { hostApi } from '../tenant/host-api.js';
import { fetchOffers } from '../tenant/offers.js';
import { BatchSettlementChannelManager } from '@x402/evm/batch-settlement/server';
import { channelCommand } from './channel.js';
import { idleMsFor, startClaims, x402Command } from './claims.js';
import { parseClaimKey, parseDoorHosts, parseTrustProxy } from './config.js';
import { DoorLedger, LEDGER_FILE } from './ledger.js';
import { doorApp } from './server.js';
import { BASE_USDC, buildSchemes, facilitatorOffersBatch, type Schemes, type X402Config } from './x402.js';
import { unblockCommand } from './unblock.js';

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** The door's own TOON wallet, which pays hosts. */
async function doorPayer(env: NodeJS.ProcessEnv): Promise<ToonClientPayer> {
  return ToonClientPayer.create(toonClientConfigFromEnv(env));
}

/** The renter-facing x402 config: where payments go, which facilitator, the claim key, the channel records. */
function x402Config(env: NodeJS.ProcessEnv): X402Config {
  return {
    payTo: need(env, 'CHARTER_PAY_TO'),
    network: 'eip155:8453',
    facilitatorUrl: env.X402_FACILITATOR_URL?.trim() || 'https://facilitator.payai.network',
    claimKey: parseClaimKey(readFileSync(need(env, 'CHARTER_CLAIM_KEY_FILE'), 'utf8')),
    channelDir: join(need(env, 'CHARTER_DATA_DIR'), 'x402-channels'),
  };
}

function claimManager(cfg: X402Config, schemes: Schemes): BatchSettlementChannelManager {
  return new BatchSettlementChannelManager({ scheme: schemes.batch, facilitator: schemes.facilitator, receiver: cfg.payTo as `0x${string}`, token: BASE_USDC, network: cfg.network });
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(need(env, 'CHARTER_DOOR_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHARTER_DOOR_PORT must be a port number');
  const relayUrl = need(env, 'CHARTER_RELAY_URL');
  const dataDir = need(env, 'CHARTER_DATA_DIR');
  const ledger = new DoorLedger(join(dataDir, LEDGER_FILE));
  const trustProxy = parseTrustProxy(env.CHARTER_DOOR_TRUST_PROXY);
  const hosts = parseDoorHosts(env.CHARTER_DOOR_HOSTS);

  const client = await doorPayer(env);
  // The channel is opened (or found) now, at boot, not inside the first tick's payment window.
  try {
    await client.warm();
    const left = await client.headroom();
    console.log(`charter-door channel ready, headroom ${left === undefined ? 'unknown' : left.toString()} micro-USDC`);
  } catch (e) {
    console.error(`charter-door could not open its channel at boot (opens and ticks retry it at most once a minute): ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  const payer = serialized(client);
  const x402 = x402Config(env);
  const schemes = buildSchemes(x402);
  const claims = claimManager(x402, schemes);
  // Batch is offered only when the facilitator lists it: otherwise every tick, exact included, would fail.
  const offerBatch = await facilitatorOffersBatch(x402.facilitatorUrl, x402.network);
  if (!offerBatch) console.error(`charter-door: ${x402.facilitatorUrl} does not list batch-settlement on ${x402.network}; ticks are exact only until a restart`);

  const app = doorApp({
    offers: () => fetchOffers(relayUrl, Date.now()),
    api: (o) => hostApi(payer, o),
    hosts,
    headroom: () => client.headroom(),
    reopen: () => client.warm(),
    ledger,
    dataDir,
    x402,
    schemes,
    offerBatch,
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });
  const host = env.CHARTER_DOOR_HOST?.trim() || '127.0.0.1';
  const server = app.listen(port, host);
  console.log(`charter-door listening on ${host}:${port}`);
  // The refund idle window follows the longest interval of any lease this door has opened (two hours on an hourly offer).
  startClaims(claims, (m) => console.log(m), setTimeout, () => idleMsFor(ledger.all().map((l) => l.offer.intervalSeconds)));
  await new Promise<void>((resolve) => {
    const stop = () => {
      void claims.stop();
      server.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (process.argv[2] === 'unblock') {
  process.exit(unblockCommand(process.argv.slice(3), process.env, Date.now, (m) => console.log(m)));
}

/** `charter-door x402 …` reads only CHARTER_PAY_TO, CHARTER_CLAIM_KEY_FILE, CHARTER_DATA_DIR and X402_FACILITATOR_URL. */
async function x402Main(args: string[]): Promise<number> {
  const cfg = x402Config(process.env);
  const schemes = buildSchemes(cfg);
  // The same idle window the door uses: read from the ledger the door writes (the constructor only reads).
  const ledger = new DoorLedger(join(need(process.env, 'CHARTER_DATA_DIR'), LEDGER_FILE));
  return x402Command(args, claimManager(cfg, schemes), schemes.batch.getStorage(), Date.now, (m) => console.log(m), () => idleMsFor(ledger.all().map((l) => l.offer.intervalSeconds)));
}

const run = process.argv[2] === 'channel'
  ? doorPayer(process.env).then((p) => channelCommand(process.argv.slice(3), p, (m) => console.log(m))).then((code) => process.exit(code))
  : process.argv[2] === 'x402'
    ? x402Main(process.argv.slice(3)).then((code) => process.exit(code))
    : main();

run.then(
  () => process.exit(0),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
