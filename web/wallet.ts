import { createPublicClient, createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import type { ClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme, type ClientChannelStorage } from '@x402/evm/batch-settlement/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { depositFor } from './channel.js';
import { wrapFetchWithPayment, x402Client, type Network, type PaymentRequirements } from '@x402/fetch';
import { UNEXPECTED_PAYMENT } from './format.js';

/** The door asks for USDC on Base: batch-settlement (a channel) or exact (one authorization per tick). */
export const BASE_NETWORK = 'eip155:8453' as const;
export const BASE_CHAIN_ID_HEX = '0x2105';
/** USDC on Base mainnet. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** An injected EIP-1193 wallet, such as `window.ethereum`. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * viem's wallet client over the injected provider, as the x402 EVM scheme's signer. With `reads`, it also
 * reads contracts through the same provider (eth_call), which the batch scheme needs to rebuild a channel
 * from chain when the page's record is missing or stale.
 */
export function evmSigner(address: `0x${string}`, eth: Eip1193, reads = false): ClientEvmSigner {
  const client = createWalletClient({ account: address, chain: base, transport: custom(eth) });
  const signer: ClientEvmSigner = {
    address,
    signTypedData: (m) => client.signTypedData(m as unknown as Parameters<typeof client.signTypedData>[0]),
  };
  if (reads) {
    const reader = createPublicClient({ chain: base, transport: custom(eth) });
    signer.readContract = (args) => reader.readContract(args as unknown as Parameters<typeof reader.readContract>[0]);
  }
  return signer;
}

/** The only payment the page will sign for a tick. */
export interface ExpectedPayment {
  network: Network;
  asset: string;
  /** USDC micro-units: the offer's tick price. */
  amount: bigint;
  payTo: string;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The renter's batch-settlement channel: a session key for vouchers and the channel records, or batch off. */
export interface ChannelOptions {
  session: ClientEvmSigner;
  storage: ClientChannelStorage;
  /** False after the door refused a batch payment: this page then pays exact only. */
  batch: boolean;
}

const SCHEMES = ['batch-settlement', 'exact'] as const;

function matches(r: PaymentRequirements, e: ExpectedPayment): boolean {
  return (
    (SCHEMES as readonly string[]).includes(r.scheme) &&
    r.network === e.network &&
    sameAddress(r.asset, e.asset) &&
    sameAddress(r.payTo, e.payTo) &&
    /^\d+$/.test(r.amount) &&
    BigInt(r.amount) === e.amount
  );
}

/**
 * fetch that answers a 402 by signing a fresh EIP-3009 authorization with the wallet and resending.
 * It signs only a request for exactly `expected`: any other 402 throws before the wallet is asked.
 */
export function payFetchFor(address: `0x${string}`, eth: Eip1193, expected: ExpectedPayment, fetchImpl: typeof fetch = fetch, channel?: ChannelOptions): typeof fetch {
  const batch = channel?.batch === true;
  const signer = evmSigner(address, eth, batch);
  const client = new x402Client().register(expected.network, new ExactEvmScheme(signer));
  if (batch && channel) {
    client.register(
      expected.network,
      new BatchSettlementEvmScheme(signer, {
        voucherSigner: channel.session,
        storage: channel.storage,
        depositStrategy: ({ minimumDepositAmount }) => depositFor(expected.amount, BigInt(minimumDepositAmount)),
      }),
    );
  }
  client
    // Only entries for this exact payment can be chosen, batch before exact; none left is an error from the client.
    .registerPolicy((_version, reqs) =>
      reqs
        .filter((r) => matches(r, expected) && (batch || r.scheme === 'exact'))
        .sort((a, b) => SCHEMES.indexOf(a.scheme as (typeof SCHEMES)[number]) - SCHEMES.indexOf(b.scheme as (typeof SCHEMES)[number])))
    // And once one is chosen, check it again before anything is signed.
    .onBeforePaymentCreation(async ({ selectedRequirements }) =>
      matches(selectedRequirements, expected) ? undefined : { abort: true, reason: UNEXPECTED_PAYMENT });
  return wrapFetchWithPayment(fetchImpl, client) as typeof fetch;
}
