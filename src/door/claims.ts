import type { BatchSettlementChannelManager, Channel, ChannelStorage } from '@x402/evm/batch-settlement/server';

/**
 * The door's side of renters' batch-settlement channels: claim the vouchers it holds, settle the claimed
 * funds to payTo, and give idle channels' unspent deposits back. The facilitator submits every transaction.
 */

/** A channel that paid nothing for this long, with money left in it, is refunded: the renter is done. */
export const REFUND_IDLE_MS = 600_000;
/** Claims, settles and refunds go out this often; a channel still ticking within REFUND_IDLE_MS waits for the next round unless withdrawing. */
export const CLAIM_INTERVAL_SECONDS = 600;
export const REFUND_INTERVAL_SECONDS = 600;

/** The slice of BatchSettlementChannelManager the command and the timers use. */
export type ClaimManager = Pick<BatchSettlementChannelManager, 'claimAndSettle' | 'refund' | 'settle' | 'start'>;

const unspent = (c: Channel): bigint => BigInt(c.balance) - BigInt(c.chargedCumulativeAmount);
const unclaimed = (c: Channel): bigint => BigInt(c.chargedCumulativeAmount) - BigInt(c.totalClaimed);
const pending = (c: Channel, now: number): boolean => c.pendingRequest !== undefined && c.pendingRequest.expiresAt > now;
const idle = (c: Channel, now: number, idleMs: number): boolean => now - c.lastRequestTimestamp >= idleMs;

/** Channels to refund now: idle for `idleMs`, no live request, and a balance above what their vouchers cover. */
export function selectRefundable(channels: Channel[], now: number, idleMs = REFUND_IDLE_MS): Channel[] {
  return channels.filter((c) => unspent(c) > 0n && !pending(c, now) && idle(c, now, idleMs));
}

/**
 * Channels to claim now: vouchers past what is claimed on chain, and either idle (the lease is over or
 * paused) or withdrawing. A payer who asked to withdraw gets the balance back after the withdraw delay,
 * so the door claims at once, well inside it; the tick route refuses that channel's vouchers meanwhile.
 */
export function selectClaimable(channels: Channel[], now: number, idleMs = REFUND_IDLE_MS): Channel[] {
  return channels.filter((c) => unclaimed(c) > 0n && (c.withdrawRequestedAt > 0 || idle(c, now, idleMs)));
}

/** Milliseconds after a refund round before the settle that moves what the refund claimed to payTo. */
const SETTLE_AFTER_REFUND_MS = 5_000;

/**
 * Every 10 min: claim what selectClaimable picks and settle it, and refund idle channels. A refund claims
 * the channel's vouchers in the same transaction but settles nothing, so a settle follows each refund round.
 * Errors are logged, never thrown.
 */
export function startClaims(m: ClaimManager, log: (m: string) => void, schedule: (fn: () => void, ms: number) => unknown = setTimeout): void {
  let settleDue = false;
  m.start({
    claimIntervalSecs: CLAIM_INTERVAL_SECONDS,
    settleIntervalSecs: CLAIM_INTERVAL_SECONDS,
    refundIntervalSecs: REFUND_INTERVAL_SECONDS,
    selectClaimChannels: (channels, ctx) => selectClaimable(channels, ctx.now),
    selectRefundChannels: (channels, ctx) => selectRefundable(channels, ctx.now),
    onClaim: (r) => log(`x402 claimed ${r.vouchers} vouchers tx ${r.transaction}`),
    onSettle: (r) => log(`x402 settled tx ${r.transaction}`),
    onRefund: (r) => {
      log(`x402 refunded ${r.channel} tx ${r.transaction}`);
      if (settleDue) return;
      settleDue = true;
      schedule(() => {
        settleDue = false;
        m.settle().then(
          (s) => log(`x402 settled tx ${s.transaction}`),
          (e: unknown) => log(`x402 settle after refund: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`),
        );
      }, SETTLE_AFTER_REFUND_MS);
    },
    onError: (e) => log(`x402 claims: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`),
  });
}

export const X402_USAGE = 'usage: charter-door x402 status | claim | settle | refund';

/** `charter-door x402 status | claim | settle | refund`: the timers' work, now, for a demo or for ops. Safe beside a running door (file locks). */
export async function x402Command(args: string[], m: ClaimManager, storage: ChannelStorage, now: () => number, out: (m: string) => void): Promise<number> {
  const [cmd, ...rest] = args;
  if (rest.length > 0 || (cmd !== 'status' && cmd !== 'claim' && cmd !== 'settle' && cmd !== 'refund')) {
    out(X402_USAGE);
    return 2;
  }
  if (cmd === 'settle') {
    out(`settled tx ${(await m.settle()).transaction}`);
    return 0;
  }
  if (cmd === 'status') {
    const all = await storage.list();
    if (all.length === 0) out('no channels');
    for (const c of all) out(`${c.channelId} balance ${c.balance} charged ${c.chargedCumulativeAmount} claimed ${c.totalClaimed} idle ${Math.floor((now() - c.lastRequestTimestamp) / 1000)} s`);
    return 0;
  }
  if (cmd === 'claim') {
    const r = await m.claimAndSettle({ idleSecs: 0 });
    for (const c of r.claims) out(`claimed ${c.vouchers} vouchers tx ${c.transaction}`);
    if (r.claims.length === 0) out('nothing to claim');
    if (r.settle) out(`settled tx ${r.settle.transaction}`);
    return 0;
  }
  const targets = selectRefundable(await storage.list(), now());
  if (targets.length === 0) out('nothing to refund');
  for (const r of await m.refund(targets.map((c) => c.channelId))) out(`refunded ${r.channel} tx ${r.transaction}`);
  return 0;
}
