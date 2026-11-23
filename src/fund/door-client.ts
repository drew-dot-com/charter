// Plain x402 calls to Charter's door, `exact` USDC on Base, to the payee the door names, at most a tick's cap.
// The grant fund and the charter CLI pay through it: everything either pays goes through `pay` below.
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

export const BASE = 'eip155:8453';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PAID_MS = 60_000;
const FREE_MS = 20_000;

/** `paid`: micro-USDC this call signed, on a 2xx answer (what an `exact` payment settles). */
export interface Answer { status: number; body: any; tx?: string; paid?: bigint }
export interface DoorClient {
  get(path: string): Promise<Answer>;
  /** A free POST: nothing is signed, whatever the door answers. */
  post(path: string, json: unknown): Promise<Answer>;
  pay(path: string, json: unknown): Promise<Answer>;
  fund(method: 'GET' | 'POST' | 'PUT', path: string, json?: unknown): Promise<Answer>;
  payTo: string;
}

interface Requirement { scheme?: string; network?: string; asset?: string; payTo?: string; amount?: string }

/** Of what a 402 offers, only `exact` USDC on Base, to `payTo`, at a decimal amount no more than `maxTick`. */
export function onlyDoorExact(payTo: string, maxTick: bigint) {
  return (_version: number, reqs: Requirement[]) =>
    reqs.filter(
      (r) =>
        r.scheme === 'exact' &&
        r.network === BASE &&
        String(r.asset).toLowerCase() === BASE_USDC.toLowerCase() &&
        String(r.payTo).toLowerCase() === String(payTo).toLowerCase() &&
        /^\d+$/.test(String(r.amount)) &&
        BigInt(String(r.amount)) <= maxTick,
    );
}

/** The amount of the requirement a payment header signed for, or undefined when it names none. */
function signedAmount(header: string): bigint | undefined {
  try {
    const amount = (decodePaymentSignatureHeader(header) as { accepted?: { amount?: unknown } }).accepted?.amount;
    return typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : undefined;
  } catch {
    return undefined;
  }
}

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function cleanUrl(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error('doorUrl is not a URL');
  }
  const loopback = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopback) throw new Error('doorUrl must be https://');
  return u.replace(/\/+$/, '');
}

/** `key` unset: `pay` throws. `fundToken` unset: `fund` throws. Either throws before sending anything. */
export async function doorClient(o: {
  doorUrl: string;
  key?: `0x${string}`;
  fundToken?: string;
  maxTickMicro: bigint;
  fetch?: typeof fetch;
}): Promise<DoorClient> {
  const door = cleanUrl(o.doorUrl);
  const base_ = o.fetch ?? fetch;
  const call = async (f: typeof fetch, path: string, init: RequestInit, ms: number) =>
    f(`${door}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ms) });

  const info = await answer(await call(base_, '/v1/door', {}, FREE_MS));
  if (info.status !== 200 || info.body?.network !== BASE || !ADDRESS.test(info.body?.payTo ?? '')) {
    throw new Error(`GET /v1/door answered ${info.status} with network ${String(info.body?.network)}: the payTo or network is not usable, nothing signed`);
  }
  const payTo: string = info.body.payTo;

  const scheme = o.key ? new ExactEvmScheme(privateKeyToAccount(o.key)) : undefined;

  const send = async (f: typeof fetch, method: string, path: string, json: unknown, headers: Record<string, string>, ms: number) => {
    const hasBody = json !== undefined;
    return call(f, path, { method, headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers }, ...(hasBody ? { body: JSON.stringify(json) } : {}) }, ms);
  };

  return {
    payTo,
    async get(path) {
      return answer(await send(base_, 'GET', path, undefined, {}, FREE_MS));
    },
    async post(path, json) {
      return answer(await send(base_, 'POST', path, json, {}, PAID_MS));
    },
    async pay(path, json) {
      if (!scheme) throw new Error('this door client holds no key, so it pays nothing');
      // What this call signed, read off the retried request the payment wrapper sends: one wrapper per call,
      // so calls side by side never see each other's payment.
      let signed: bigint | undefined;
      const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const header = input instanceof Request ? input.headers.get('payment-signature') : null;
        if (header) signed = signedAmount(header);
        return base_(input, init);
      }) as typeof fetch;
      const paidFetch = wrapFetchWithPaymentFromConfig(watched, {
        schemes: [{ network: BASE, client: scheme }],
        policies: [onlyDoorExact(payTo, o.maxTickMicro) as never],
      });
      const res = await send(paidFetch, 'POST', path, json, {}, PAID_MS);
      const out = await answer(res);
      if (signed !== undefined && res.status >= 200 && res.status < 300) out.paid = signed;
      const receipt = res.headers.get('payment-response');
      if (receipt) {
        try {
          const d = decodePaymentResponseHeader(receipt);
          if (d.transaction) out.tx = d.transaction;
        } catch {
          // A receipt that does not decode changes nothing about the answer.
        }
      }
      return out;
    },
    async fund(method, path, json) {
      if (!o.fundToken) throw new Error('this door client holds no fund token');
      return answer(await send(base_, method, path, json, { authorization: `Bearer ${o.fundToken}` }, FREE_MS));
    },
  };
}

type Read = (a: { address: `0x${string}`; abi: typeof erc20Abi; functionName: 'balanceOf'; args: [`0x${string}`] }) => Promise<bigint>;

/** USDC balance (6 decimals) of `address` on Base. `read` is injectable for tests. */
export async function usdcBalance(address: string, rpcUrl: string, read?: Read): Promise<bigint> {
  const reader: Read = read ?? ((a) => createPublicClient({ chain: base, transport: http(rpcUrl) }).readContract(a) as Promise<bigint>);
  try {
    return await reader({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address as `0x${string}`] });
  } catch (e) {
    // viem's transport errors carry the request URL, which holds the provider's API key: say nothing of the original.
    throw new Error(`balance read failed (${e instanceof Error ? e.constructor.name : typeof e})`);
  }
}
