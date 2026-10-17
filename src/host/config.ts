import { FIRST_TICK_GRACE_MS } from '../lease.js';
import { isSealKey, isSealUrl } from '../offer.js';
import type { Micro, Offer } from '../types.js';

export interface HostConfig {
  ports: { open: number; tick: number; status: number };
  dataDir: string;
  allowImages: string[];
  proxy?: string;
  relayUrl: string;
  passphraseFile: string;
  /** Leases this host runs at once (booting, awaiting the first tick, or running). An open past it answers closed `busy`. */
  maxLeases: number;
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
  const sealKey = need(env, 'CHARTER_SEAL_KEY');
  if (!isSealKey(sealKey)) throw new Error('CHARTER_SEAL_KEY must be the connector public key: 0x04 and 128 hex digits (toon describe --json .description.edgeIdentity.publicKey)');
  const sealUrl = need(env, 'CHARTER_SEAL_URL');
  if (!isSealUrl(sealUrl)) throw new Error('CHARTER_SEAL_URL must be the connector /ilp URL (toon describe --json .description.httpEndpoint)');

  return {
    ports: { open: nums[0]!, tick: nums[1]!, status: nums[2]! },
    dataDir: need(env, 'CHARTER_DATA_DIR'),
    allowImages,
    proxy,
    relayUrl: need(env, 'CHARTER_RELAY_URL'),
    passphraseFile: need(env, 'TOON_PASSPHRASE_FILE'),
    maxLeases: num(env, 'CHARTER_MAX_LEASES', 1),
    offer: {
      id: need(env, 'CHARTER_OFFER_ID'),
      // The signer's pubkey is stamped on the event when toon signs it.
      hostPubkey: '',
      ilpBase: need(env, 'CHARTER_ILP_BASE'),
      sealKey,
      sealUrl,
      cpu: num(env, 'CHARTER_CPU', 1),
      memoryMiB: num(env, 'CHARTER_MEMORY_MIB', 1024),
      intervalSeconds: num(env, 'CHARTER_INTERVAL_SECONDS', 30),
      firstTickGraceSeconds: FIRST_TICK_GRACE_MS / 1000,
      tickPrice: price(env, 'CHARTER_TICK_PRICE', 5000n),
      openPrice: price(env, 'CHARTER_OPEN_PRICE', 1000n),
      statusPrice: price(env, 'CHARTER_STATUS_PRICE', 100n),
      images: allowImages,
      hiddenHost: flag(env, 'CHARTER_HIDDEN_HOST'),
      hiddenEgress: proxy !== undefined,
      expiresAt: 0,
    },
  };
}
