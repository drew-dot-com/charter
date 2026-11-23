/** USDC micro-units (6 decimals): 1000n is 0.001 USDC. */
export type Micro = bigint;

export interface Offer {
  id: string;
  /** sha256 hex of the host's normalized URL (hostIdOf): the 64 hex of every `offerId` the door lists for it. */
  hostId: string;
  /** The host's HTTPS base URL, normalized (normalizeHostUrl). */
  url: string;
  /** Where the host is paid: its Base address. */
  payTo: `0x${string}`;
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
  /** Present when the host offers a durable home (the `charter-home` image). */
  /** `root: true`: a new home is also reached as `root@` with the same keys, and `apt` works in it. */
  home?: { diskGiB: number; retentionDays: number; slots: number; free?: number; root?: true };
}

export interface JobSpec {
  image: string;
  args: Record<string, string>;
}

export type LeaseState = 'booting' | 'awaiting_first_tick' | 'running' | 'done' | 'closed';

export type CloseReason = 'boot_failed' | 'missed_tick' | 'max_intervals' | 'host_restart' | 'busy' | 'home_in_use';

/** Where a tenant reaches its running home. */
export interface HomeAccess {
  ssh: { host: string; port: number; user: string };
  /** Also reachable as an onion service, once anon has published its hostname. */
  onion?: { host: string; port: number; user: string };
}

export interface Lease {
  id: string;
  offerId: string;
  job: JobSpec;
  state: LeaseState;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms the container was created: the first tick is due within the offer's first-tick grace of this. */
  bootedAt?: number;
  /** Epoch ms the container was started, once tick 0 was paid. Until then no job work has run. */
  startedAt?: number;
  paidIntervals: number;
  /** Epoch ms the paid time runs out. */
  paidThrough?: number;
  closedReason?: CloseReason;
  outputParts?: number;
  /** Home lease only: the id of the persistent home (from the key set), so a later lease finds the same disk. */
  homeId?: string;
  /** Home lease only: how many times the host restarted the container after it exited. */
  restarts?: number;
  /** Home lease only: how to reach it once running. */
  access?: HomeAccess | null;
  landing?: { chain: string; tx: string; shared: boolean };
}
