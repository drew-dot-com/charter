import { PRICE_UNCONFIRMED, UNEXPECTED_PAYMENT, type PublicOffer } from './format.js';
import type { Answer } from './ticker.js';
import { channelStorage, sessionSigner } from './channel.js';
import { BASE_NETWORK, BASE_USDC, payFetchFor, type Eip1193 } from './wallet.js';

export type { Answer } from './ticker.js';

/** Where the door says payments go. */
export interface DoorInfo {
  payTo: string;
  network: string;
}

export async function call(f: typeof fetch, path: string, init?: RequestInit): Promise<Answer> {
  const res = await f(path, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

export interface PayDeps {
  leaseId: string;
  /** The door's origin: the payment client builds a `Request`, which needs an absolute URL. */
  origin: string;
  /** The door has no payment gate (local development): ticks go out unpaid. */
  dev: boolean;
  wallet: { address: `0x${string}`; eth: Eip1193 } | undefined;
  fetch: typeof fetch;
  /** The door's payee, or undefined when it could not be loaded. */
  door(): Promise<DoorInfo | undefined>;
  /** The lease's offer as its status carries it: the door's record from open time, not today's offer list. */
  offer(): PublicOffer | undefined;
  /** Where the renter's channel (session key and records) is kept: localStorage. Undefined: no channel, exact only. */
  store?: Storage | undefined;
}

/**
 * Batch off for the rest of this page: set when the door answered a batch payment with a 402 (the
 * facilitator would not take the deposit, or the channel is out of step). The ticker's retry then pays exact.
 */
export const batchState = { disabled: false };

/**
 * The tick sender of one lease page. It signs one payment only: the lease's tick price, to the door's
 * payee, in USDC on Base. A lookup that fails before signing throws PRICE_UNCONFIRMED (the page can try
 * again); a payment request that does not match throws UNEXPECTED_PAYMENT from the payment client.
 */
export function makePost(d: PayDeps): (index: number) => Promise<Answer> {
  return async (index) => {
    let pay: typeof fetch = d.fetch;
    if (!d.dev) {
      const door = await d.door();
      const offer = d.offer();
      if (!door || !offer || !d.wallet) throw new Error(PRICE_UNCONFIRMED);
      if (door.network !== BASE_NETWORK) throw new Error(UNEXPECTED_PAYMENT);
      const batch = d.store !== undefined && !batchState.disabled;
      pay = payFetchFor(
        d.wallet.address,
        d.wallet.eth,
        { network: BASE_NETWORK, asset: BASE_USDC, amount: BigInt(offer.tickPrice), payTo: door.payTo },
        d.fetch,
        d.store === undefined ? undefined : { session: sessionSigner(d.wallet.address, d.store), storage: channelStorage(d.wallet.address, d.store), batch },
      );
      const answer = await call(pay, new URL(`/v1/leases/${d.leaseId}/ticks`, d.origin).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      // A 402 after paying means the batch payment was refused: this page pays exact from here on.
      if (batch && answer.status === 402) batchState.disabled = true;
      return answer;
    }
    return call(pay, new URL(`/v1/leases/${d.leaseId}/ticks`, d.origin).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index }),
    });
  };
}
