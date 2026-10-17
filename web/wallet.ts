import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import type { ClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment, x402Client, type Network, type PaymentRequirements } from '@x402/fetch';
import { UNEXPECTED_PAYMENT } from './format.js';

/** The door asks for exact-scheme USDC on Base. */
export const BASE_NETWORK = 'eip155:8453' as const;
export const BASE_CHAIN_ID_HEX = '0x2105';
/** USDC on Base mainnet. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** An injected EIP-1193 wallet, such as `window.ethereum`. */
export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** viem's wallet client over the injected provider, as the x402 EVM scheme's signer. */
export function evmSigner(address: `0x${string}`, eth: Eip1193): ClientEvmSigner {
  const client = createWalletClient({ account: address, chain: base, transport: custom(eth) });
  return {
    address,
    signTypedData: (m) => client.signTypedData(m as unknown as Parameters<typeof client.signTypedData>[0]),
  };
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

function matches(r: PaymentRequirements, e: ExpectedPayment): boolean {
  return (
    r.scheme === 'exact' &&
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
export function payFetchFor(address: `0x${string}`, eth: Eip1193, expected: ExpectedPayment, fetchImpl: typeof fetch = fetch): typeof fetch {
  const client = new x402Client()
    .register(expected.network, new ExactEvmScheme(evmSigner(address, eth)))
    // Only entries for this exact payment can be chosen; none left is an error from the client.
    .registerPolicy((_version, reqs) => reqs.filter((r) => matches(r, expected)))
    // And once one is chosen, check it again before anything is signed.
    .onBeforePaymentCreation(async ({ selectedRequirements }) =>
      matches(selectedRequirements, expected) ? undefined : { abort: true, reason: UNEXPECTED_PAYMENT });
  return wrapFetchWithPayment(fetchImpl, client) as typeof fetch;
}
