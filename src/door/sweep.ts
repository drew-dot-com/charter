// The daily sweep: the door's wallet keeps a float and sends the rest to the operator's address.
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { BASE_USDC } from '../x402/seller.js';
import { errorReason } from './redact.js';

export interface SweepDeps {
  /** The wallet's free USDC (channel deposits are already out of it). */
  balance: () => Promise<bigint>;
  /** Sends USDC and resolves with the hash once the transaction succeeded. */
  transfer: (to: `0x${string}`, amount: bigint) => Promise<`0x${string}`>;
  keep: bigint;
  to: `0x${string}`;
  log: (s: string) => void;
  alert: (s: string) => Promise<void>;
}

/** Sends `balance - keep` when that is positive. Returns the transaction hash, or null when nothing was sent or the sweep failed (after an alert). */
export async function sweepOnce(d: SweepDeps): Promise<`0x${string}` | null> {
  try {
    const amount = (await d.balance()) - d.keep;
    if (amount <= 0n) return null;
    const hash = await d.transfer(d.to, amount);
    d.log(`sweep: ${amount} micro-USDC to ${d.to}, tx ${hash}`);
    return hash;
  } catch (e) {
    await d.alert(`sweep failed: ${errorReason(e)}`).catch(() => undefined);
    return null;
  }
}

/** Sweeps now and then every `everyMs`. Returns the stop function. */
export function startSweep(d: SweepDeps, everyMs = 86_400_000): () => void {
  void sweepOnce(d);
  const timer = setInterval(() => void sweepOnce(d), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** USDC balance and transfer on Base for the door payer key. Gas is paid in ETH from the same address. */
export function baseUsdcWallet(rpcUrl: string, key: `0x${string}`): Pick<SweepDeps, 'balance' | 'transfer'> {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: base, transport });
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ chain: base, transport, account });
  return {
    balance: () => pub.readContract({ address: BASE_USDC, abi: ERC20, functionName: 'balanceOf', args: [account.address] }),
    async transfer(to, amount) {
      const hash = await wallet.writeContract({ address: BASE_USDC, abi: ERC20, functionName: 'transfer', args: [to, amount] });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
      return hash;
    },
  };
}
