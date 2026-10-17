import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Eip1193 } from './wallet.js';

/** Test support: a local key, and an injected-wallet stand-in that signs EIP-712 requests with it. */
export const account = privateKeyToAccount(generatePrivateKey());

/** A wallet that signs EIP-712 requests with a local key, as an injected provider would. */
export function fakeWallet(seen: string[] = []): Eip1193 {
  return {
    async request({ method, params }) {
      seen.push(method);
      if (method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${method}`);
      const [from, json] = params as [string, string];
      if (from.toLowerCase() !== account.address.toLowerCase()) throw new Error('wrong account');
      const t = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };
      const { EIP712Domain: _domain, ...types } = t.types;
      // The wire form carries uint256 as strings; the signer wants bigints.
      const message = { ...t.message };
      for (const f of types[t.primaryType]!) if (f.type.startsWith('uint')) message[f.name] = BigInt(message[f.name] as string);
      return account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message } as never);
    },
  };
}

