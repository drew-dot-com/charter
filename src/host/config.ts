import { join } from 'node:path';
import { FIRST_TICK_GRACE_MS } from '../lease.js';
import { HOME_IMAGES } from '../jobs.js';
import { isSealKey, isSealUrl } from '../offer.js';
import type { Micro, Offer } from '../types.js';
import { HOME_DISK_GIB, HOME_RETENTION_MS } from './homes.js';

export interface HostConfig {
  ports: { open: number; tick: number; status: number };
  dataDir: string;
  allowImages: string[];
  proxy?: string;
  /** OCI runtime for every job container (`runsc` for gVisor). Default: docker's own. */
  runtime?: string;
  relayUrl: string;
  passphraseFile: string;
  /** Leases this host runs at once (booting, awaiting the first tick, or running). An open past it answers closed `busy`. */
  maxLeases: number;
  /** Home leases this host runs at once, inside maxLeases. 0: no homes. */
  maxHomes: number;
  /** Set when maxHomes > 0. */
  home?: {
    dir: string;
    network: string;
    gateway: string;
    socksPort: number;
    httpPort: number;
    /** Directory the anon daemon reads onion confs from. */
    anonHsDir: string;
    anonPidFile: string;
    /** The connector a box pays through, as the box sees it. */
    tenantConnectorUrl: string;
  };
  /** The base offer. `expiresAt` is 0 here; the offer loop sets it on each publish. */
  offer: Offer;
}

function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new Error(`${name} is required`);
  return v.trim();
}

function num(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const v = env[name]?.trim();
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(v);
}

/** Like num, but 0 is a valid answer. */
function count(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const v = env[name]?.trim();
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

function price(env: Record<string, string | undefined>, name: string, dflt: Micro): Micro {
  const v = env[name]?.trim();
  if (v === undefined || v === '') return dflt;
  if (!/^\d+$/.test(v) || BigInt(v) <= 0n) throw new Error(`${name} must be a positive integer (USDC micro-units)`);
  return BigInt(v);
}

function flag(env: Record<string, string | undefined>, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function loadConfig(env: Record<string, string | undefined>): HostConfig {
  const rawPorts = (env.CHARTER_PORTS?.trim() || '7401,7402,7403').split(',').map((s) => s.trim());
  const nums = rawPorts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.length !== 3 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > 65535) || new Set(nums).size !== 3) {
    throw new Error('CHARTER_PORTS must be three distinct ports: open,tick,status');
  }
  const allowImages = need(env, 'CHARTER_ALLOW_IMAGES')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowImages.length === 0) throw new Error('CHARTER_ALLOW_IMAGES is required');
  const proxy = env.CHARTER_PROXY?.trim() || undefined;
  const runtime = env.CHARTER_RUNTIME?.trim() || undefined;
  if (runtime !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(runtime)) {
    throw new Error('CHARTER_RUNTIME must be a docker runtime name, such as runsc');
  }
  const sealKey = need(env, 'CHARTER_SEAL_KEY');
  if (!isSealKey(sealKey)) throw new Error('CHARTER_SEAL_KEY must be the connector public key: 0x04 and 128 hex digits (toon describe --json .description.edgeIdentity.publicKey)');
  const sealUrl = need(env, 'CHARTER_SEAL_URL');
  if (!isSealUrl(sealUrl)) throw new Error('CHARTER_SEAL_URL must be the connector /ilp URL (toon describe --json .description.httpEndpoint)');

  const hostPubkey = env.CHARTER_HOST_PUBKEY?.trim() ?? '';
  if (hostPubkey !== '' && !/^[0-9a-f]{64}$/.test(hostPubkey)) {
    throw new Error('CHARTER_HOST_PUBKEY must be the host Nostr pubkey: 64 lowercase hex digits');
  }

  const maxLeases = num(env, 'CHARTER_MAX_LEASES', 1);
  const maxHomes = count(env, 'CHARTER_MAX_HOMES', 0);
  if (allowImages.some((i) => HOME_IMAGES.includes(i)) && maxHomes === 0) {
    throw new Error('a home image (charter-home or charter-hermes) is allowed but CHARTER_MAX_HOMES is 0: set it to at least 1');
  }
  if (maxHomes > maxLeases) throw new Error('CHARTER_MAX_HOMES cannot exceed CHARTER_MAX_LEASES');
  const dataDir = need(env, 'CHARTER_DATA_DIR');
  let home: HostConfig['home'];
  if (maxHomes > 0) {
    const tenantConnectorUrl = need(env, 'CHARTER_TENANT_CONNECTOR_URL');
    if (!/^https?:\/\/[^\s/]+/.test(tenantConnectorUrl)) throw new Error('CHARTER_TENANT_CONNECTOR_URL must be an http(s) URL');
    const gateway = env.CHARTER_HOME_GATEWAY?.trim() || '172.19.0.1';
    const octets = gateway.split('.');
    if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
      throw new Error('CHARTER_HOME_GATEWAY must be a dotted IPv4 address');
    }
    home = {
      dir: env.CHARTER_HOME_DIR?.trim() || join(dataDir, 'homes'),
      network: env.CHARTER_HOME_NETWORK?.trim() || 'charter-home',
      gateway,
      socksPort: num(env, 'CHARTER_HOME_SOCKS_PORT', 9050),
      httpPort: num(env, 'CHARTER_HOME_HTTP_PORT', 9080),
      anonHsDir: need(env, 'CHARTER_ANON_HS_DIR'),
      anonPidFile: need(env, 'CHARTER_ANON_PIDFILE'),
      tenantConnectorUrl,
    };
  }

  return {
    ports: { open: nums[0]!, tick: nums[1]!, status: nums[2]! },
    dataDir,
    allowImages,
    proxy,
    runtime,
    relayUrl: need(env, 'CHARTER_RELAY_URL'),
    passphraseFile: need(env, 'TOON_PASSPHRASE_FILE'),
    maxLeases,
    maxHomes,
    home,
    offer: {
      id: need(env, 'CHARTER_OFFER_ID'),
      // The signer's pubkey is stamped on the event when toon signs it. Set here only so the offer
      // handed to a home box (CHARTER_OFFER_JSON) names its host and resolves `<pubkey>:<id>`.
      hostPubkey,
      ilpBase: need(env, 'CHARTER_ILP_BASE'),
      sealKey,
      sealUrl,
      cpu: num(env, 'CHARTER_CPU', 1),
      memoryMiB: num(env, 'CHARTER_MEMORY_MIB', 1024),
      // One hour at 0.007 USDC: about 5 USDC for 30 days, the price a model weighs against a 5 EUR VPS.
      intervalSeconds: num(env, 'CHARTER_INTERVAL_SECONDS', 3600),
      firstTickGraceSeconds: FIRST_TICK_GRACE_MS / 1000,
      tickPrice: price(env, 'CHARTER_TICK_PRICE', 7000n),
      openPrice: price(env, 'CHARTER_OPEN_PRICE', 1000n),
      statusPrice: price(env, 'CHARTER_STATUS_PRICE', 100n),
      images: allowImages,
      hiddenHost: flag(env, 'CHARTER_HIDDEN_HOST'),
      hiddenEgress: proxy !== undefined,
      expiresAt: 0,
      ...(maxHomes > 0
        ? { home: { diskGiB: HOME_DISK_GIB, retentionDays: HOME_RETENTION_MS / 86_400_000, slots: maxHomes } }
        : {}),
    },
  };
}
