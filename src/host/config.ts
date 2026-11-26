import { join } from 'node:path';
import { FIRST_TICK_GRACE_MS } from '../lease.js';
import { HOME_IMAGES } from '../jobs.js';
import { hostIdOf, normalizeHostUrl } from '../door/hosts.js';
import { parseXHandle } from '../door/optin-codes.js';
import type { Micro, Offer } from '../types.js';
import { HOME_DISK_GIB, HOME_DISK_GIB_MAX, HOME_RETENTION_MS } from './homes.js';

export interface HostConfig {
  /** CHARTER_HOST_URL, normalized: the public HTTPS address the door reaches this host at, and its identity. */
  hostUrl: string;
  /** CHARTER_HOST_PAY_TO: the Base address ticks are paid to. */
  payTo: `0x${string}`;
  /** CHARTER_HOST_PORT: the loopback port the host app listens on, behind the TLS proxy. Default 7401. */
  port: number;
  /** CHARTER_DOOR_URL: the door this host registers with and answers. */
  doorUrl: string;
  /** CHARTER_CLAIM_KEY_FILE: the host's x402 claim authorizer key. */
  claimKeyFile: string;
  /** X402_FACILITATOR_URL: who settles the door's vouchers. Default PayAI. */
  facilitatorUrl: string;
  dataDir: string;
  allowImages: string[];
  proxy?: string;
  /** Where a proxied job's names resolve: an Anyone DNS port on the docker bridge's gateway. Unset: docker's default (the host's resolvers). */
  jobDns?: string;
  /** OCI runtime for every job container (`runsc` for gVisor). Default: docker's own. */
  runtime?: string;
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
    /** GiB of each new home's disk (CHARTER_HOME_DISK_GIB). */
    diskGib: number;
    /** New homes are root homes (CHARTER_HOME_ROOT): root login and apt, the system on the home's own disk. Needs gVisor. */
    root: boolean;
    /** A public dotted IPv4 address homes are reached on (docker -p binds it, so not a name). Unset: homes are onion-only. */
    publicHost?: string;
    /** Publish each home as an onion service. True unless a public host is set and CHARTER_HOME_ONION is off. */
    onion: boolean;
    /** Directory the anon daemon reads onion confs from. Set when `onion` is true. */
    anonHsDir?: string;
    anonPidFile?: string;
  };
  /** The base offer. `expiresAt` is 0 here; `GET /v1/offer` sets it on each answer. */
  offer: Offer;
}

/** The door a host registers with unless CHARTER_DOOR_URL names another. */
export const DEFAULT_DOOR_URL = 'https://charterhome.dev';

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

/** A dotted IPv4 address, each octet 0-255. `docker run -p <host>:<port>:2222` binds it, and docker takes only an IP there. */
function publicIPv4(v: string): boolean {
  const octets = v.split('.');
  return octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

export function loadConfig(env: Record<string, string | undefined>): HostConfig {
  const hostUrl = normalizeHostUrl(need(env, 'CHARTER_HOST_URL'));
  if (hostUrl === null) throw new Error('CHARTER_HOST_URL must be the public https:// address of this host (a name with a dot, or a public IP), with no query');
  const payTo = need(env, 'CHARTER_HOST_PAY_TO');
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error('CHARTER_HOST_PAY_TO must be a 0x address (40 hex characters)');
  const port = num(env, 'CHARTER_HOST_PORT', 7401);
  if (port > 65535) throw new Error('CHARTER_HOST_PORT must be a port number');
  const doorUrl = (env.CHARTER_DOOR_URL?.trim() || DEFAULT_DOOR_URL).replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(doorUrl)) throw new Error('CHARTER_DOOR_URL must be an https:// URL');
  const allowImages = need(env, 'CHARTER_ALLOW_IMAGES')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowImages.length === 0) throw new Error('CHARTER_ALLOW_IMAGES is required');
  const proxy = env.CHARTER_PROXY?.trim() || undefined;
  const jobDns = env.CHARTER_JOB_DNS?.trim() || undefined;
  if (jobDns !== undefined) {
    const o = jobDns.split('.');
    if (o.length !== 4 || o.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) {
      throw new Error('CHARTER_JOB_DNS must be a dotted IPv4 address, such as 172.17.0.1');
    }
    if (proxy === undefined) throw new Error('CHARTER_JOB_DNS is for proxied jobs: set CHARTER_PROXY too');
  }
  const runtime = env.CHARTER_RUNTIME?.trim() || undefined;
  if (runtime !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(runtime)) {
    throw new Error('CHARTER_RUNTIME must be a docker runtime name, such as runsc');
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
    const gateway = env.CHARTER_HOME_GATEWAY?.trim() || '172.19.0.1';
    const octets = gateway.split('.');
    if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
      throw new Error('CHARTER_HOME_GATEWAY must be a dotted IPv4 address');
    }
    const publicHost = env.CHARTER_HOME_PUBLIC_HOST?.trim() || undefined;
    if (publicHost !== undefined && !publicIPv4(publicHost)) {
      throw new Error('CHARTER_HOME_PUBLIC_HOST must be a dotted IPv4 address (docker binds it; a hostname is not accepted), without a scheme or port');
    }
    const rawDisk = env.CHARTER_HOME_DISK_GIB?.trim() || String(HOME_DISK_GIB);
    const diskGib = /^\d+$/.test(rawDisk) ? Number(rawDisk) : NaN;
    if (!Number.isInteger(diskGib) || diskGib < 1 || diskGib > HOME_DISK_GIB_MAX) {
      throw new Error(`CHARTER_HOME_DISK_GIB must be a whole number of GiB from 1 to ${HOME_DISK_GIB_MAX}`);
    }
    const root = flag(env, 'CHARTER_HOME_ROOT');
    if (root && runtime !== 'runsc') {
      throw new Error('CHARTER_HOME_ROOT needs CHARTER_RUNTIME=runsc: a root home is only as contained as gVisor makes it');
    }
    const onion = publicHost === undefined || flag(env, 'CHARTER_HOME_ONION');
    home = {
      dir: env.CHARTER_HOME_DIR?.trim() || join(dataDir, 'homes'),
      network: env.CHARTER_HOME_NETWORK?.trim() || 'charter-home',
      gateway,
      socksPort: num(env, 'CHARTER_HOME_SOCKS_PORT', 9050),
      httpPort: num(env, 'CHARTER_HOME_HTTP_PORT', 9080),
      diskGib,
      root,
      ...(publicHost !== undefined ? { publicHost } : {}),
      onion,
      ...(onion ? { anonHsDir: need(env, 'CHARTER_ANON_HS_DIR'), anonPidFile: need(env, 'CHARTER_ANON_PIDFILE') } : {}),
    };
  }

  // Optional: the operator's X handle. Serving it in the offer is this host's half of agreeing to be named on X.
  const xHandle = parseXHandle(env.CHARTER_HOST_X_HANDLE, 'CHARTER_HOST_X_HANDLE');

  return {
    hostUrl,
    payTo: payTo as `0x${string}`,
    port,
    doorUrl,
    claimKeyFile: need(env, 'CHARTER_CLAIM_KEY_FILE'),
    facilitatorUrl: env.X402_FACILITATOR_URL?.trim() || 'https://facilitator.payai.network',
    dataDir,
    allowImages,
    proxy,
    ...(jobDns !== undefined ? { jobDns } : {}),
    runtime,
    maxLeases,
    maxHomes,
    home,
    offer: {
      id: need(env, 'CHARTER_OFFER_ID'),
      hostId: hostIdOf(hostUrl),
      url: hostUrl,
      payTo: payTo as `0x${string}`,
      cpu: num(env, 'CHARTER_CPU', 1),
      memoryMiB: num(env, 'CHARTER_MEMORY_MIB', 1024),
      // One hour at 0.011 USDC; with the door's 0.001 fee a renter pays 0.012, about 8.64 USDC for 30 days.
      intervalSeconds: num(env, 'CHARTER_INTERVAL_SECONDS', 3600),
      firstTickGraceSeconds: FIRST_TICK_GRACE_MS / 1000,
      tickPrice: price(env, 'CHARTER_TICK_PRICE', 11000n),
      // The door pays ticks only: opens and status reads are free.
      openPrice: 0n,
      statusPrice: 0n,
      images: allowImages,
      hiddenHost: flag(env, 'CHARTER_HIDDEN_HOST'),
      hiddenEgress: proxy !== undefined,
      expiresAt: 0,
      ...(maxHomes > 0
        ? { home: { diskGiB: home?.diskGib ?? HOME_DISK_GIB, retentionDays: HOME_RETENTION_MS / 86_400_000, slots: maxHomes, ...(home?.root ? { root: true as const } : {}) } }
        : {}),
      ...(xHandle !== undefined ? { xHandle } : {}),
    },
  };
}
