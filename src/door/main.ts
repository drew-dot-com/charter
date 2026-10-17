#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToonClientPayer, serialized } from '../payer.js';
import { hostApi } from '../tenant/host-api.js';
import { fetchOffers } from '../tenant/offers.js';
import { channelCommand } from './channel.js';
import { parseDoorHosts, parseTrustProxy } from './config.js';
import { DoorLedger, LEDGER_FILE } from './ledger.js';
import { doorApp } from './server.js';
import { unblockCommand } from './unblock.js';

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** The door's own TOON wallet, which pays hosts. */
async function doorPayer(env: NodeJS.ProcessEnv): Promise<ToonClientPayer> {
  const chain = need(env, 'CHARTER_TOON_CHAIN');
  if (chain !== 'evm' && chain !== 'solana') throw new Error('CHARTER_TOON_CHAIN must be evm or solana');
  // The key stays in the file the env names. A bad key file fails with KeyFileError's fixed message;
  // other startup errors carry no key material and print as they are.
  const payerConfig: Parameters<typeof ToonClientPayer.create>[0] = {
    connectorUrl: need(env, 'CHARTER_TOON_CONNECTOR_URL'),
    keyFile: need(env, 'CHARTER_TOON_KEY_FILE'),
    channelStore: need(env, 'CHARTER_TOON_CHANNEL_STORE'),
    chain,
  };
  // The RPC URL may carry an API key, so it comes from a file like the other secrets.
  const rpcFile = env.CHARTER_TOON_RPC_URL_FILE?.trim();
  if (rpcFile) {
    const rpcUrl = readFileSync(rpcFile, 'utf8').trim();
    if (!/^https:\/\/\S+$/.test(rpcUrl)) throw new Error('CHARTER_TOON_RPC_URL_FILE must hold one https:// URL');
    payerConfig.rpcUrl = rpcUrl;
  }
  return ToonClientPayer.create(payerConfig);
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(need(env, 'CHARTER_DOOR_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHARTER_DOOR_PORT must be a port number');
  const relayUrl = need(env, 'CHARTER_RELAY_URL');
  const dataDir = need(env, 'CHARTER_DATA_DIR');
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

  const app = doorApp({
    offers: () => fetchOffers(relayUrl, Date.now()),
    api: (o) => hostApi(payer, o),
    hosts,
    headroom: () => client.headroom(),
    reopen: () => client.warm(),
    ledger: new DoorLedger(join(dataDir, LEDGER_FILE)),
    dataDir,
    x402: {
      payTo: need(env, 'CHARTER_PAY_TO'),
      network: 'eip155:8453',
      facilitatorUrl: env.X402_FACILITATOR_URL?.trim() || 'https://facilitator.payai.network',
    },
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });
  const host = env.CHARTER_DOOR_HOST?.trim() || '127.0.0.1';
  const server = app.listen(port, host);
  console.log(`charter-door listening on ${host}:${port}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
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

const run = process.argv[2] === 'channel'
  ? doorPayer(process.env).then((p) => channelCommand(process.argv.slice(3), p, (m) => console.log(m))).then((code) => process.exit(code))
  : main();

run.then(
  () => process.exit(0),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
