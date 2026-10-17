import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';
import type { ClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';

/** The door asks for exact-scheme USDC on Base. */
export const BASE_NETWORK = 'eip155:8453';
export const BASE_CHAIN_ID_HEX = '0x2105';

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

/** fetch that answers a 402 by signing a fresh EIP-3009 authorization with the wallet and resending. */
export function payFetchFor(address: `0x${string}`, eth: Eip1193, fetchImpl: typeof fetch = fetch): typeof fetch {
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme(evmSigner(address, eth)));
  return wrapFetchWithPayment(fetchImpl, client) as typeof fetch;
}
