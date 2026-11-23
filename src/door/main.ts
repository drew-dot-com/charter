#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BatchSettlementChannelManager } from '@x402/evm/batch-settlement/server';
import { createPublicClient, http, isAddress } from 'viem';
import { base } from 'viem/chains';
import { idleMsFor, startClaims, x402Command } from '../x402/claims.js';
import { createFacilitatorConfig } from '@coinbase/x402';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { privateKeyToAccount } from 'viem/accounts';
import type { HostApi } from '../tenant/host-api.js';
import type { Offer } from '../types.js';
import { CAPITAL_FILE, CapitalBook, capitalAtRisk } from './capital.js';
import { baseChannelChain } from './channel-chain.js';
import { doorFunding, parseSweepKeep, parseCdpKey, parsePayerKey, parseTrustProxy } from './config.js';
import { fetchHostOffer, listedOffers } from './host-offers.js';
import { DEPOSIT_TICK_TIMEOUT_MS, doorPayer, httpHostApi, type DoorPayer, type ReadContract } from './host-http.js';
import { HostQueue } from './host-queue.js';
import { capitalAllocator, hostFundingWaiting, HOSTS_FILE, HostRegistry, leasesTicking, startChannelReaper } from './hosts.js';
import { DoorLedger, LEDGER_FILE } from './ledger.js';
import { startProbes } from './probe.js';
import { fileRequestSink } from './reqlog.js';
import { blockAddresses, safeFetch } from './safe-fetch.js';
import { doorApp } from './server.js';
import { GrantStore, readFundPublic } from './grants.js';
import { BASE_USDC, buildSchemes, facilitatorOffersBatch, parseClaimKey, type Schemes, type X402Config } from '../x402/seller.js';
import { baseUsdcWallet, startSweep } from './sweep.js';
import { unblockCommand } from './unblock.js';
import { hostsCommand } from './hosts-command.js';

const REQUEST_LOG_FILE = 'requests.jsonl';
/** The body a host may answer the door with: an output part (48 KiB as base64) and its JSON wrapper fit. */
const HOST_MAX_BYTES = 128 * 1024;

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** The door's Base key (CHARTER_DOOR_PAYER_KEY_FILE), which pays hosts and is the renters' payTo. Readable by its owner only. */
function payerKey(env: NodeJS.ProcessEnv): `0x${string}` {
  const file = need(env, 'CHARTER_DOOR_PAYER_KEY_FILE');
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`CHARTER_DOOR_PAYER_KEY_FILE ${file} must be readable by its owner only (chmod 0400)`);
  return parsePayerKey(readFileSync(file, 'utf8'));
}

/** The renter-facing x402 config: where payments go, which facilitator, the claim key, the channel records. */
function x402Config(env: NodeJS.ProcessEnv, payTo: `0x${string}`): X402Config {
  return {
    payTo,
    network: 'eip155:8453',
    facilitatorUrl: env.X402_FACILITATOR_URL?.trim() || 'https://facilitator.payai.network',
    claimKey: parseClaimKey(readFileSync(need(env, 'CHARTER_CLAIM_KEY_FILE'), 'utf8')),
    channelDir: join(need(env, 'CHARTER_DATA_DIR'), 'x402-channels'),
    ...cdpExact(env),
  };
}

/** CDP as the exact facilitator, when CHARTER_CDP_KEY_FILE names a key: what lists the door in CDP's Bazaar. */
function cdpExact(env: NodeJS.ProcessEnv): Pick<X402Config, 'exactFacilitator'> {
  const file = env.CHARTER_CDP_KEY_FILE?.trim();
  if (!file) return {};
  const key = parseCdpKey(readFileSync(file, 'utf8'));
  return { exactFacilitator: createFacilitatorConfig(key.id, key.secret) };
}

function claimManager(cfg: X402Config, schemes: Schemes): BatchSettlementChannelManager {
  return new BatchSettlementChannelManager({ scheme: schemes.batch, facilitator: schemes.facilitator, receiver: cfg.payTo as `0x${string}`, token: BASE_USDC, network: cfg.network });
}

/** BASE_RPC_URL, default the public Base endpoint. */
const baseRpcUrl = (env: NodeJS.ProcessEnv): string => env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';

/** Base reads for the door's host channels. */
function baseReader(env: NodeJS.ProcessEnv): ReadContract {
  const client = createPublicClient({ chain: base, transport: http(baseRpcUrl(env)) });
  return (args) => client.readContract(args as Parameters<typeof client.readContract>[0]);
}

/**
 * fetch for every call to a host, free or paid: safeFetch, with room for an output part. Its time limit is the
 * longest a call may run (a tick carrying a deposit); httpHostApi holds every other call to HOST_TIMEOUT_MS.
 */
const hostFetch: typeof fetch = (input, init) => safeFetch(input as string | URL | Request, { ...init, maxBytes: HOST_MAX_BYTES, timeoutMs: DEPOSIT_TICK_TIMEOUT_MS });

/**
 * One HostApi per host and payment terms (url, payTo, tick price), kept for the door's life: what a tick
 * paid is remembered across calls, so a spent index is never sent again. A lease snapshots its offer, so all
 * of one lease's calls reach one instance; every instance shares the door's payer and one queue.
 */
function hostApis(payer: DoorPayer): (o: Offer) => HostApi {
  const queue = new HostQueue();
  const apis = new Map<string, HostApi>();
  return (o) => {
    // A lease from before the cut-over names no HTTPS host: there is nothing to call.
    if (!o.url || !o.hostId || !o.payTo) throw new Error('host_unreachable');
    const key = `${o.hostId} ${o.url} ${o.payTo.toLowerCase()} ${o.tickPrice}`;
    let api = apis.get(key);
    if (!api) apis.set(key, (api = httpHostApi(o, { payer, queue, fetch: hostFetch })));
    return api;
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const port = Number(need(env, 'CHARTER_DOOR_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHARTER_DOOR_PORT must be a port number');
  const dataDir = need(env, 'CHARTER_DATA_DIR');
  const ledger = new DoorLedger(join(dataDir, LEDGER_FILE));
  const trustProxy = parseTrustProxy(env.CHARTER_DOOR_TRUST_PROXY);
  const funding = doorFunding(env);
  blockAddresses(funding.selfAddrs);

  const grants = new GrantStore(join(dataDir, 'grants.jsonl'), Date.now);
  grants.dropOldPitches();
  setInterval(() => grants.dropOldPitches(), 3_600_000).unref();
  // Intake is open only while the fund says so and its last report is under 10 minutes old; a fund that
  // has not reported (no file) or has stopped reporting means closed.
  const fundOpen = (): boolean => readFundPublic(join(dataDir, 'fund-public.json'), Date.now())?.open === true;

  const fundTokenFile = env.CHARTER_FUND_TOKEN_FILE?.trim();
  const fundToken = fundTokenFile ? readFileSync(fundTokenFile, 'utf8').trim() : undefined;
  if (fundTokenFile && !fundToken) throw new Error(`CHARTER_FUND_TOKEN_FILE ${fundTokenFile} is empty`);
  const fundAddressRaw = env.CHARTER_FUND_ADDRESS?.trim();
  if (fundAddressRaw && !/^0x[0-9a-fA-F]{40}$/.test(fundAddressRaw)) throw new Error('CHARTER_FUND_ADDRESS must be a 0x address (40 hex characters)');

  // Hosts: who registered, what the door has locked in their channels, and how much more it may lock.
  const registry = new HostRegistry(join(dataDir, HOSTS_FILE));
  const capital = new CapitalBook(join(dataDir, CAPITAL_FILE));
  // What the caps count: deposits not withdrawn and not yet charged by the host (R10). `payer` is built below; this runs later.
  const locked = capitalAtRisk(capital, (hostId) => payer.chargedNow(hostId));
  const depositFor = capitalAllocator({
    registry, locked, probeDeposit: funding.probeDeposit, hostDeposit: funding.hostDeposit, probeCap: funding.probeCap, hostCap: funding.hostCap,
  });
  const key = payerKey(env);
  const payer = doorPayer({
    key,
    channelDir: env.CHARTER_HOST_CHANNEL_DIR?.trim() || join(dataDir, 'host-channels'),
    depositFor,
    atRisk: locked,
    fetch: hostFetch,
    onDeposit: (hostId, channelId, amount) => {
      capital.deposited(hostId, amount);
      console.log(`charter-door: deposit ${amount} micro-USDC signed into channel ${channelId} of host ${hostId}`);
    },
    onDepositLapsed: (hostId, channelId, amount) => {
      capital.withdrawn(hostId, amount);
      console.log(`charter-door: deposit ${amount} micro-USDC into channel ${channelId} of host ${hostId} lapsed unlanded; released`);
    },
    readContract: baseReader(env),
  });
  // A deposit or settle whose answer was lost before a restart: the chain says what landed.
  try {
    await payer.resyncAll();
  } catch (e) {
    console.error(`charter-door: host channels not resynced from chain at boot: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  const apiOf = hostApis(payer);
  const fetchOffer = (url: string) => fetchHostOffer(url, (input, init) => safeFetch(input as string | URL | Request, init ?? {}));

  const x402 = x402Config(env, payer.address);
  const schemes = buildSchemes(x402);
  const claims = claimManager(x402, schemes);
  // Batch is offered only when the facilitator lists it: otherwise every tick, exact included, would fail.
  const offerBatch = await facilitatorOffersBatch(x402.facilitatorUrl, x402.network);
  if (!offerBatch) console.error(`charter-door: ${x402.facilitatorUrl} does not list batch-settlement on ${x402.network}; ticks are exact only until a restart`);
  if (x402.exactFacilitator) {
    // Said at boot because the resource server falls back to the main facilitator without a word.
    try {
      const kinds = (await new HTTPFacilitatorClient(x402.exactFacilitator).getSupported()).kinds;
      const ok = kinds.some((k) => k.scheme === 'exact' && k.network === x402.network);
      if (ok) console.log(`charter-door: exact settles through ${x402.exactFacilitator.url}`);
      else console.error(`charter-door: ${x402.exactFacilitator.url} does not list exact on ${x402.network}; exact settles through ${x402.facilitatorUrl}`);
    } catch (e) {
      console.error(`charter-door: ${x402.exactFacilitator.url} unreachable or refused the key (${String(e instanceof Error ? e.message : e).slice(0, 160)}); exact settles through ${x402.facilitatorUrl} until a restart`);
    }
  }

  const fundingWaiting = hostFundingWaiting({ registry, locked, depositFor });
  const app = doorApp({
    offers: listedOffers({ registry, fetchOffer, now: Date.now }),
    api: apiOf,
    payer: payer.address,
    registry,
    fee: funding.doorFee,
    hostDailyLoss: funding.hostDailyLoss,
    fundingWaiting,
    ledger,
    dataDir,
    grants,
    fundOpen,
    ...(fundToken ? { fundToken } : {}),
    ...(fundAddressRaw ? { fundAddress: fundAddressRaw.toLowerCase() } : {}),
    x402,
    schemes,
    offerBatch,
    ...(trustProxy === undefined ? {} : { trustProxy }),
    ...(env.CHARTER_CONTACT_EMAIL?.trim() ? { contactEmail: env.CHARTER_CONTACT_EMAIL.trim() } : {}),
    ...(env.CHARTER_REQUEST_LOG?.trim() === 'off' ? {} : { requestSink: fileRequestSink(join(dataDir, REQUEST_LOG_FILE)) }),
  });
  const host = env.CHARTER_DOOR_HOST?.trim() || '127.0.0.1';
  const server = app.listen(port, host);
  console.log(`charter-door listening on ${host}:${port}, paying hosts as ${payer.address}`);
  // The refund idle window follows the longest interval of any lease this door has opened (two hours on an hourly offer).
  startClaims(claims, { log: (m) => console.log(m), idleMs: () => idleMsFor(ledger.all().map((l) => l.offer.intervalSeconds)) });
  const stopProbes = startProbes({
    registry, apiOf, fetchOffer, depositFor, locked, probeMaxTick: funding.probeMaxTick, perDay: funding.probesPerDay,
    now: Date.now, log: (m) => console.log(`charter-door: ${m}`),
  });
  // A host's channel goes quiet once neither a renter's lease nor a probe has paid through it.
  const lastLeaseAt = (hostId: string): number | undefined => {
    let last = registry.get(hostId)?.probes.lastAt;
    for (const l of ledger.all()) {
      if (l.offer.hostId !== hostId) continue;
      const at = Math.max(l.createdAt, l.lastTickAt ?? 0);
      if (last === undefined || at > last) last = at;
    }
    return last;
  };
  // A renter still paying a dropped host: its channel is left until that lease stops ticking.
  const ticking = (hostId: string): boolean => leasesTicking(ledger.all(), hostId, Date.now());
  const stopReaper = startChannelReaper({
    registry, payer, chain: baseChannelChain(baseRpcUrl(env), key), lastLeaseAt, ticking,
    // Releasing what is at risk leaves the book equal to what the host charged: nothing counted once channels are empty.
    capital: { locked, withdrawn: (hostId, amount) => capital.withdrawn(hostId, amount) },
    now: Date.now, log: (m) => console.log(`charter-door: ${m}`),
  });
  // Daily: everything the wallet holds above CHARTER_SWEEP_KEEP goes to CHARTER_SWEEP_TO. A failure is logged
  // at error level with a stable prefix the ops check greps for.
  const sweepTo = need(env, 'CHARTER_SWEEP_TO');
  if (!isAddress(sweepTo)) throw new Error('CHARTER_SWEEP_TO must be a valid 0x address (a mixed-case one must match its checksum)');
  const sweepKeep = parseSweepKeep(env.CHARTER_SWEEP_KEEP);
  const stopSweep = startSweep({
    ...baseUsdcWallet(baseRpcUrl(env), key),
    keep: sweepKeep,
    to: sweepTo as `0x${string}`,
    log: (m) => console.log(`charter-door: ${m}`),
    alert: async (m) => console.error(`charter-door ${m}`),
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      stopSweep();
      stopProbes();
      stopReaper();
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

if (process.argv[2] === 'hosts') {
  process.exit(hostsCommand(process.argv.slice(3), process.env, Date.now, (m) => console.log(m)));
}

/** `charter-door x402 …` reads only CHARTER_DOOR_PAYER_KEY_FILE, CHARTER_CLAIM_KEY_FILE, CHARTER_DATA_DIR and X402_FACILITATOR_URL. */
async function x402Main(args: string[]): Promise<number> {
  const cfg = x402Config(process.env, privateKeyToAccount(payerKey(process.env)).address);
  const schemes = buildSchemes(cfg);
  // The same idle window the door uses: read from the ledger the door writes (the constructor only reads).
  const ledger = new DoorLedger(join(need(process.env, 'CHARTER_DATA_DIR'), LEDGER_FILE));
  return x402Command(args, claimManager(cfg, schemes), schemes.batch.getStorage(), Date.now, (m) => console.log(m), () => idleMsFor(ledger.all().map((l) => l.offer.intervalSeconds)));
}

const run = process.argv[2] === 'x402' ? x402Main(process.argv.slice(3)).then((code) => process.exit(code)) : main();

run.then(
  () => process.exit(0),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
