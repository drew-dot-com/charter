/** Parsing for the door's environment. See docs/env.md. */

/**
 * CHARTER_DOOR_TRUST_PROXY: Express `trust proxy` for a door behind a reverse proxy, so the rate limits
 * key on the client's address. `true` trusts every hop; a positive integer trusts that many (`1` for
 * one Caddy in front). Unset: the socket's address is the client's.
 */
export function parseTrustProxy(v: string | undefined): boolean | number | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'true') return true;
  if (/^[1-9]\d{0,2}$/.test(s)) return Number(s);
  throw new Error('CHARTER_DOOR_TRUST_PROXY must be true or a hop count (1 for one proxy in front)');
}

/** CHARTER_DOOR_PAYER_KEY_FILE: one 0x-prefixed 64-hex Base private key, the door's payer. Errors never quote the file. */
export function parsePayerKey(fileText: string): `0x${string}` {
  const s = fileText.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('CHARTER_DOOR_PAYER_KEY_FILE must hold one 0x-prefixed 64-hex private key');
  return s as `0x${string}`;
}

/** How the door funds host channels and probes. Amounts in micro-USDC. */
export interface DoorFunding {
  /** CHARTER_PROBES_PER_DAY: first probes the door starts in a UTC day. */
  probesPerDay: number;
  /** CHARTER_PROBE_MAX_TICK: the most a probe pays for its one tick. */
  probeMaxTick: bigint;
  /** CHARTER_PROBE_DEPOSIT and CHARTER_PROBE_CAPITAL_CAP: an unproven host's deposit, and all of them together. */
  probeDeposit: bigint;
  probeCap: bigint;
  /** CHARTER_HOST_DEPOSIT and CHARTER_HOST_CAPITAL_CAP: a proven host's deposit, and all of them together. */
  hostDeposit: bigint;
  hostCap: bigint;
  /** CHARTER_DOOR_SELF_ADDRS: the box's own addresses (IPs or CIDRs), never fetched as a host. */
  selfAddrs: string[];
  /** CHARTER_DOOR_FEE: what the door adds to each tick a renter pays, on top of the host's price. */
  doorFee: bigint;
  /** CHARTER_HOST_DAILY_LOSS: what one host's refused ticks may cost the door in a UTC day before it is hidden. */
  hostDailyLoss: bigint;
  /** CHARTER_DEPOSIT_TIMEOUT_DAILY_CAP: what hosts' first deposit timeouts may cost the door in a UTC day, all together. */
  depositTimeoutDailyCap: bigint;
}

function wholeEnv(env: Record<string, string | undefined>, name: string, dflt: bigint, min: bigint): bigint {
  const v = env[name]?.trim();
  if (v === undefined || v === '') return dflt;
  if (!/^\d{1,18}$/.test(v) || BigInt(v) < min) throw new Error(`${name} must be a whole number${min > 0n ? ' above 0' : ''}`);
  return BigInt(v);
}

export function doorFunding(env: Record<string, string | undefined>): DoorFunding {
  return {
    probesPerDay: Number(wholeEnv(env, 'CHARTER_PROBES_PER_DAY', 10n, 0n)),
    probeMaxTick: wholeEnv(env, 'CHARTER_PROBE_MAX_TICK', 10_000n, 1n),
    probeDeposit: wholeEnv(env, 'CHARTER_PROBE_DEPOSIT', 100_000n, 1n),
    probeCap: wholeEnv(env, 'CHARTER_PROBE_CAPITAL_CAP', 1_000_000n, 0n),
    hostDeposit: wholeEnv(env, 'CHARTER_HOST_DEPOSIT', 500_000n, 1n),
    hostCap: wholeEnv(env, 'CHARTER_HOST_CAPITAL_CAP', 10_000_000n, 0n),
    selfAddrs: (env.CHARTER_DOOR_SELF_ADDRS ?? '').split(',').map((a) => a.trim()).filter(Boolean),
    doorFee: wholeEnv(env, 'CHARTER_DOOR_FEE', 0n, 0n),
    hostDailyLoss: wholeEnv(env, 'CHARTER_HOST_DAILY_LOSS', 50_000n, 0n),
    depositTimeoutDailyCap: wholeEnv(env, 'CHARTER_DEPOSIT_TIMEOUT_DAILY_CAP', 100_000n, 0n),
  };
}

/**
 * A CDP API key as the CDP portal downloads it: `{"id", "privateKey"}` (or the legacy `{"name", "privateKey"}`).
 * The door uses it only to sign the JWTs CDP's facilitator asks for. Errors never quote the file.
 */
export function parseCdpKey(fileText: string): { id: string; secret: string } {
  const bad = new Error('CHARTER_CDP_KEY_FILE must hold the JSON the CDP portal downloads: {"id", "privateKey"}');
  let j: unknown;
  try {
    j = JSON.parse(fileText);
  } catch {
    throw bad;
  }
  const o = (j ?? {}) as { id?: unknown; name?: unknown; privateKey?: unknown };
  const id = typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name : '';
  if (!id || typeof o.privateKey !== 'string' || !o.privateKey) throw bad;
  return { id, secret: o.privateKey };
}

/** CHARTER_SWEEP_KEEP in micro-USDC: a non-negative integer, default 15000000. */
export function parseSweepKeep(v: string | undefined): bigint {
  const t = v?.trim();
  if (!t) return 15_000_000n;
  if (!/^\d+$/.test(t)) throw new Error('CHARTER_SWEEP_KEEP must be a non-negative integer (micro-USDC)');
  return BigInt(t);
}
