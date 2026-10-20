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
