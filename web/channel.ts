import type { ClientEvmSigner } from '@x402/evm';
import type { BatchSettlementClientContext, ClientChannelStorage } from '@x402/evm/batch-settlement/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * The renter's batch-settlement channel, as the page keeps it: a session key that signs vouchers (so
 * the wallet is asked only for deposits) and the channel context the x402 client keeps between
 * requests. Both live in localStorage per wallet address, so a reload or a later lease reuses the
 * channel instead of depositing again. Losing them costs a fresh deposit; the old channel's balance
 * comes back through the door's idle refund.
 */

/** PayAI's floor for a first deposit, in micro-USDC. */
export const MIN_DEPOSIT = 100000n;
/** A deposit covers at least this many ticks, so a short lease never tops up. */
export const DEPOSIT_TICKS = 20n;

/** What to deposit now: never under the floor, twenty ticks, or what this tick needs on top of the balance. */
export function depositFor(tickPrice: bigint, minimum: bigint): bigint {
  let d = MIN_DEPOSIT;
  if (DEPOSIT_TICKS * tickPrice > d) d = DEPOSIT_TICKS * tickPrice;
  if (minimum > d) d = minimum;
  return d;
}

const prefix = (address: string) => `charter.x402.${address.toLowerCase()}`;

function read(store: Storage, key: string): string | undefined {
  try {
    return store.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(store: Storage, key: string, value: string | undefined): void {
  try {
    if (value === undefined) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Storage denied (private mode): the channel then lives as long as the page.
  }
}

/** The session key that signs this wallet's vouchers; made on first use and kept in the store. */
export function sessionSigner(address: `0x${string}`, store: Storage): ClientEvmSigner {
  const key = `${prefix(address)}.key`;
  let pk = read(store, key);
  if (!pk || !/^0x[0-9a-f]{64}$/.test(pk)) {
    pk = generatePrivateKey();
    write(store, key, pk);
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  return {
    address: account.address,
    signTypedData: (m) => account.signTypedData(m as unknown as Parameters<typeof account.signTypedData>[0]),
  };
}

/** The x402 client's channel records for this wallet, one store key per channel id. */
export function channelStorage(address: `0x${string}`, store: Storage): ClientChannelStorage {
  const keyOf = (channelId: string) => `${prefix(address)}.ch.${channelId.toLowerCase()}`;
  return {
    async get(channelId) {
      const raw = read(store, keyOf(channelId));
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as BatchSettlementClientContext;
      } catch {
        return undefined;
      }
    },
    async set(channelId, context) {
      write(store, keyOf(channelId), JSON.stringify(context));
    },
    async delete(channelId) {
      write(store, keyOf(channelId), undefined);
    },
  };
}

/**
 * Drops this wallet's channel records (not its session key). After the door refused a batch payment the
 * record is wrong, most often because the door refunded the channel: the next payment then reads the
 * channel from chain and carries on from there.
 */
export function forgetChannels(address: `0x${string}`, store: Storage): void {
  const head = `${prefix(address)}.ch.`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(head)) keys.push(k);
    }
  } catch {
    return;
  }
  for (const k of keys) write(store, k, undefined);
}

/** This wallet's stored channel records (unreadable ones skipped). */
export function readChannels(address: `0x${string}`, store: Storage): BatchSettlementClientContext[] {
  const head = `${prefix(address)}.ch.`;
  const out: BatchSettlementClientContext[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k || !k.startsWith(head)) continue;
      const raw = read(store, k);
      if (!raw) continue;
      try {
        const c = JSON.parse(raw) as BatchSettlementClientContext;
        if (c && typeof c === 'object') out.push(c);
      } catch {
        // Not a record.
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** The renter's channels folded into three numbers, micro-USDC, as this page last saw them. */
export interface ChannelSummary {
  channels: number;
  /** On chain, in the channels. */
  balance: bigint;
  /** Vouchered to the door and not yet claimed on chain. */
  owed: bigint;
  /** What is left once the door claims what it is owed: refunded when the channel goes idle. */
  back: bigint;
}

const micro = (s: string | undefined): bigint => (s !== undefined && /^\d+$/.test(s) ? BigInt(s) : 0n);

export function channelSummary(channels: BatchSettlementClientContext[]): ChannelSummary | undefined {
  if (channels.length === 0) return undefined;
  let balance = 0n;
  let owed = 0n;
  for (const c of channels) {
    balance += micro(c.balance);
    const unclaimed = micro(c.chargedCumulativeAmount) - micro(c.totalClaimed);
    if (unclaimed > 0n) owed += unclaimed;
  }
  const back = balance > owed ? balance - owed : 0n;
  return { channels: channels.length, balance, owed, back };
}
