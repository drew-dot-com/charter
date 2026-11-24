// The biller's only door to Base: a thin wrapper over @base-org/account's spend-permission helpers and viem.
// It reads a permission's status, asks the contract whether a pull would go through, pulls, revokes,
// refunds and reads balances. It decides nothing; the cycle in biller.ts does. Every error it throws has
// the RPC URL (which holds the provider's key) taken out.
import { getPermissionStatus, prepareRevokeCallData, prepareSpendCallData } from '@base-org/account/spend-permission';
import { BaseError, createPublicClient, createWalletClient, decodeErrorResult, encodeFunctionData, erc20Abi, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { SignedPermission } from '../door/allowances.js';
import { BASE_USDC } from '../fund/door-client.js';

export type CanPull = { ok: true } | { ok: false; why: 'short' | 'over_limit' | 'invalid' | 'revoked'; detail: string };

export interface Chain {
  /** `periodEndsAt`: when the current period ends and the next starts, epoch ms. */
  status(p: SignedPermission): Promise<{ isRevoked: boolean; isExpired: boolean; remainingMicro: bigint; periodSpentMicro: bigint; periodEndsAt: number }>;
  canPull(p: SignedPermission, micro: bigint): Promise<CanPull>;
  pull(p: SignedPermission, micro: bigint): Promise<{ tx: string }>;
  revoke(p: SignedPermission): Promise<{ tx: string }>;
  /** A USDC transfer from the spender. Throws NotSent when nothing left the spender's wallet. */
  refund(to: string, micro: bigint): Promise<{ tx: string }>;
  usdc(addr: string): Promise<bigint>;
  eth(addr: string): Promise<bigint>;
  spender: string;
}

/** A send that certainly moved nothing: it failed before it was broadcast, or it was mined and reverted. */
export class NotSent extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NotSent';
  }
}

/** SpendPermissionManager: the spend is over what the permission has left this period. */
const OVER_LIMIT = '0xfd1ebc88';
/** SpendPermissionManager: the permission is revoked. */
const REVOKED = '0x282b9f97';
const RECEIPT_MS = 120_000;
const MANAGER = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const MANAGER_ABI = parseAbi([
  'struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
  'function isRevoked(SpendPermission spendPermission) view returns (bool)',
]);

/**
 * The permission is in force at `nowSec` (unix seconds): from its start until its end. Outside it the
 * contract's period getter reverts, so `status` reads only the revoke flag and answers `isExpired`.
 */
export function inForce(p: SignedPermission, nowSec: number): boolean {
  return nowSec >= p.permission.start && nowSec < p.permission.end;
}

type Call = { to: Hex; data: Hex; value?: bigint };

export function baseChain(o: { key: `0x${string}`; rpcUrl: string }): Chain {
  const me = privateKeyToAccount(o.key);
  const transport = http(o.rpcUrl);
  const pub = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ account: me, chain: base, transport });
  const opts = { rpcUrl: o.rpcUrl };

  /** The error's own words with the RPC URL and any request detail taken out. */
  const clean = (e: unknown): string => {
    const raw = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);
    return raw
      .split(o.rpcUrl)
      .join('<rpc>')
      .split('\n')
      .filter((l) => !/^\s*(URL|Request body|Details|Raw Call Arguments):/.test(l))
      .join(' ')
      .slice(0, 300);
  };
  const scrub = (e: unknown): Error => (e instanceof NotSent ? new NotSent(clean(e)) : new Error(clean(e)));
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw scrub(e);
    }
  };

  /** Signs before sending, so a failure before the broadcast is known to have sent nothing. */
  const send = async (c: Call): Promise<string> => {
    let raw: Hex;
    try {
      const req = await wallet.prepareTransactionRequest({ account: me, chain: base, to: c.to, data: c.data, value: c.value ?? 0n });
      raw = await wallet.signTransaction(req);
    } catch (e) {
      throw new NotSent(`not sent: ${clean(e)}`);
    }
    const hash = await wallet.sendRawTransaction({ serializedTransaction: raw });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_MS });
    if (r.status !== 'success') throw new NotSent(`transaction ${hash} reverted`);
    return hash;
  };

  /** The revert data of a failed eth_call, or undefined when the call failed for another reason (the RPC). */
  const revertData = (e: unknown): Hex | undefined => {
    if (!(e instanceof BaseError)) return undefined;
    const inner = e.walk() as { data?: unknown };
    const d = typeof inner?.data === 'object' && inner.data !== null ? (inner.data as { data?: unknown }).data : inner?.data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
    if (e.walk((x) => (x as Error).name === 'ExecutionRevertedError')) return '0x';
    return undefined;
  };

  const judge = (data: Hex): CanPull => {
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === OVER_LIMIT) return { ok: false, why: 'over_limit', detail: `the contract refuses a spend over what is left this period (${sel})` };
    if (sel === REVOKED) return { ok: false, why: 'revoked', detail: `the contract says the permission is revoked (${sel})` };
    let text = '';
    try {
      const d = decodeErrorResult({ abi: [], data });
      text = d.errorName === 'Error' ? String(d.args?.[0] ?? '') : d.errorName;
    } catch {
      // not a standard Error(string)
    }
    if (/exceeds balance|insufficient balance|transfer amount/i.test(text)) return { ok: false, why: 'short', detail: `the USDC transfer reverted: ${text.slice(0, 120)}` };
    return { ok: false, why: 'invalid', detail: `the contract refused the pull: ${text ? text.slice(0, 120) : data.slice(0, 74)}` };
  };

  return {
    spender: me.address,

    status: (p) =>
      guard(async () => {
        if (!inForce(p, Math.floor(Date.now() / 1000))) {
          const q = p.permission;
          const sp = { account: getAddress(q.account), spender: getAddress(q.spender), token: getAddress(q.token), allowance: BigInt(q.allowance), period: q.period, start: q.start, end: q.end, salt: BigInt(q.salt), extraData: q.extraData as Hex };
          const isRevoked = await pub.readContract({ address: MANAGER, abi: MANAGER_ABI, functionName: 'isRevoked', args: [sp] });
          return { isRevoked, isExpired: true, remainingMicro: 0n, periodSpentMicro: 0n, periodEndsAt: q.end * 1000 };
        }
        const s = await getPermissionStatus(p, opts);
        return {
          isRevoked: s.isRevoked,
          isExpired: s.isExpired,
          remainingMicro: s.remainingSpend,
          periodSpentMicro: BigInt(s.currentPeriod.spend),
          periodEndsAt: s.nextPeriodStart.getTime(),
        };
      }),

    canPull: (p, micro) =>
      guard(async () => {
        const account = p.permission.account as Hex;
        const held = await pub.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
        if (held < micro) return { ok: false, why: 'short', detail: `the account holds ${held} micro-USDC, short of ${micro}` };
        let calls: Call[];
        try {
          calls = (await prepareSpendCallData(p, micro, undefined, opts)) as Call[];
        } catch (e) {
          const m = clean(e);
          if (/revoked/i.test(m)) return { ok: false, why: 'revoked', detail: m };
          if (/insufficient/i.test(m)) return { ok: false, why: 'over_limit', detail: m };
          if (/cannot be 0/i.test(m)) return { ok: false, why: 'invalid', detail: m };
          throw e;
        }
        // eth_call each prepared call from the spender. A first pull is [approveWithSignature, spend]: the spend
        // cannot be simulated before the approve is on chain, so only the approve is, after the balance and
        // limit checks above.
        const toTry = calls.length > 1 ? calls.slice(0, 1) : calls;
        for (const c of toTry) {
          try {
            await pub.call({ account: me, to: c.to, data: c.data, value: c.value ?? 0n });
          } catch (e) {
            const data = revertData(e);
            if (data === undefined) throw e;
            return judge(data);
          }
        }
        return { ok: true };
      }),

    pull: (p, micro) =>
      guard(async () => {
        // The spend pays the spender itself, so no recipient (a recipient adds a transfer to oneself).
        const calls = (await prepareSpendCallData(p, micro, undefined, opts)) as Call[];
        let tx = '';
        for (const c of calls) tx = await send(c);
        return { tx };
      }),

    revoke: (p) =>
      guard(async () => {
        const c = (await prepareRevokeCallData(p)) as Call;
        return { tx: await send(c) };
      }),

    refund: (to, micro) =>
      guard(async () => {
        const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Hex, micro] });
        return { tx: await send({ to: BASE_USDC, data }) };
      }),

    usdc: (addr) => guard(() => pub.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [addr as Hex] })),
    eth: (addr) => guard(() => pub.getBalance({ address: addr as Hex })),
  };
}
