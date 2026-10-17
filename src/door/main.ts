#!/usr/bin/env node
import { join } from 'node:path';
import { ToonClientPayer, serialized } from '../payer.js';
import { hostApi } from '../tenant/host-api.js';
import { fetchOffers } from '../tenant/offers.js';
import { DoorLedger } from './ledger.js';
import { doorApp } from './server.js';

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(need(env, 'CHARTER_DOOR_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHARTER_DOOR_PORT must be a port number');
  const relayUrl = need(env, 'CHARTER_RELAY_URL');
  const chain = need(env, 'CHARTER_TOON_CHAIN');
  if (chain !== 'evm' && chain !== 'solana') throw new Error('CHARTER_TOON_CHAIN must be evm or solana');
  const dataDir = need(env, 'CHARTER_DATA_DIR');
  const trustProxy = env.CHARTER_DOOR_TRUST_PROXY?.trim();

  // The door's own TOON wallet pays hosts. The key stays in the file the env names. A bad key file
  // fails with KeyFileError's fixed message; other startup errors carry no key material and print as they are.
  const payerConfig: Parameters<typeof ToonClientPayer.create>[0] = {
    connectorUrl: need(env, 'CHARTER_TOON_CONNECTOR_URL'),
    keyFile: need(env, 'CHARTER_TOON_KEY_FILE'),
    channelStore: need(env, 'CHARTER_TOON_CHANNEL_STORE'),
    chain,
  };
  const payer = serialized(await ToonClientPayer.create(payerConfig));

  const app = doorApp({
    offers: () => fetchOffers(relayUrl, Date.now()),
    api: (o) => hostApi(payer, o),
    ledger: new DoorLedger(join(dataDir, 'door-ledger.json')),
    dataDir,
    x402: {
      payTo: need(env, 'CHARTER_PAY_TO'),
      network: 'eip155:8453',
      facilitatorUrl: env.X402_FACILITATOR_URL?.trim() || 'https://facilitator.payai.network',
    },
    ...(trustProxy ? { trustProxy: Number(trustProxy) } : {}),
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

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
