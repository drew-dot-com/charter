// The door's own writes to its host channels on Base: withdrawing a channel it no longer needs.
import { BATCH_SETTLEMENT_ADDRESS, type ChannelConfig } from '@x402/evm';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

/** One of the door's channels to a host: its id, the config that names it on chain, and what the door's record holds. */
export interface DoorChannel {
  channelId: `0x${string}`;
  config: ChannelConfig;
  balance: bigint;
  /** The cumulative amount the door's vouchers owe the host: claimed on chain or not, it is the host's. */
  charged: bigint;
}

/** A channel as the x402BatchSettlement contract holds it. */
export interface ChannelOnChain {
  /** Deposited, less what was refunded or withdrawn. */
  balance: bigint;
  /** Claimed by the host so far. */
  totalClaimed: bigint;
  /** Epoch seconds a withdrawal was asked; 0 when none is pending. */
  withdrawInitiatedAt: number;
}

/** What the channel reaper does on chain, from the door's payer key. A write resolves once its transaction succeeded. */
export interface ChannelChain {
  state(channelId: `0x${string}`): Promise<ChannelOnChain>;
  /** Asks to take `amount` back; it can be finalized `config.withdrawDelay` seconds later. */
  initiateWithdraw(c: Pick<DoorChannel, 'channelId' | 'config'>, amount: bigint): Promise<void>;
  /** Takes back what an earlier ask left unclaimed. */
  finalizeWithdraw(c: Pick<DoorChannel, 'channelId' | 'config'>): Promise<void>;
}

const config = { name: 'config', type: 'tuple', components: [
  { name: 'payer', type: 'address' }, { name: 'payerAuthorizer', type: 'address' }, { name: 'receiver', type: 'address' },
  { name: 'receiverAuthorizer', type: 'address' }, { name: 'token', type: 'address' }, { name: 'withdrawDelay', type: 'uint40' },
  { name: 'salt', type: 'bytes32' },
] } as const;

/** The withdraw part of the x402BatchSettlement ABI, as @x402/evm ships it (not exported there). */
const WITHDRAW_ABI = [
  { type: 'function', name: 'initiateWithdraw', inputs: [config, { name: 'amount', type: 'uint128' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'finalizeWithdraw', inputs: [config], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'channels', inputs: [{ name: 'channelId', type: 'bytes32' }], outputs: [{ name: 'balance', type: 'uint128' }, { name: 'totalClaimed', type: 'uint128' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingWithdrawals', inputs: [{ name: 'channelId', type: 'bytes32' }], outputs: [{ name: 'amount', type: 'uint128' }, { name: 'initiatedAt', type: 'uint40' }], stateMutability: 'view' },
] as const;

/** ChannelChain on Base over `rpcUrl`, writing as `key` (the door payer, which is every channel's payer). Gas is paid in ETH from that address. */
export function baseChannelChain(rpcUrl: string, key: `0x${string}`): ChannelChain {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: base, transport });
  const wallet = createWalletClient({ chain: base, transport, account: privateKeyToAccount(key) });
  const address = BATCH_SETTLEMENT_ADDRESS;
  const send = async (hash: `0x${string}`): Promise<void> => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  };
  return {
    async state(channelId) {
      const [[balance, totalClaimed], [, initiatedAt]] = await Promise.all([
        pub.readContract({ address, abi: WITHDRAW_ABI, functionName: 'channels', args: [channelId] }),
        pub.readContract({ address, abi: WITHDRAW_ABI, functionName: 'pendingWithdrawals', args: [channelId] }),
      ]);
      return { balance, totalClaimed, withdrawInitiatedAt: Number(initiatedAt) };
    },
    initiateWithdraw: async (c, amount) => send(await wallet.writeContract({ address, abi: WITHDRAW_ABI, functionName: 'initiateWithdraw', args: [c.config, amount] })),
    finalizeWithdraw: async (c) => send(await wallet.writeContract({ address, abi: WITHDRAW_ABI, functionName: 'finalizeWithdraw', args: [c.config] })),
  };
}
