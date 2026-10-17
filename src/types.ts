/** USDC micro-units (6 decimals): 1000n is 0.001 USDC. */
export type Micro = bigint;

export interface Offer {
  id: string;
  hostPubkey: string;
  ilpBase: string;
  /** The terminating connector's public key, `0x04` and 128 hex digits (`toon describe --json` .description.edgeIdentity.publicKey). A payer that seals by key needs no fetch. */
  sealKey: string;
  /** The terminating connector's `/ilp` URL, usually an onion address. The `toon` CLI seals to a URL only. */
  sealUrl: string;
  cpu: number;
  memoryMiB: number;
  intervalSeconds: number;
  /** How long after a lease opens the host waits for its first tick. The container starts only once that tick is paid. */
  firstTickGraceSeconds: number;
  tickPrice: Micro;
  openPrice: Micro;
  statusPrice: Micro;
  images: string[];
  hiddenHost: boolean;
  hiddenEgress: boolean;
  /** Epoch ms. */
  expiresAt: number;
}

export interface JobSpec {
  image: string;
  args: Record<string, string>;
}

export type LeaseState = 'booting' | 'awaiting_first_tick' | 'running' | 'done' | 'closed';

export type CloseReason = 'boot_failed' | 'missed_tick' | 'max_intervals' | 'host_restart';

export interface Lease {
  id: string;
  offerId: string;
  job: JobSpec;
  state: LeaseState;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  bootedAt?: number;
  paidIntervals: number;
  /** Epoch ms the paid time runs out. */
  paidThrough?: number;
  closedReason?: CloseReason;
  outputParts?: number;
  landing?: { chain: string; tx: string; shared: boolean };
}
