import type { BatchSettlementChannelManager, Channel, ChannelStorage } from '@x402/evm/batch-settlement/server';

/**
 * The door's side of renters' batch-settlement channels: claim the vouchers it holds, settle the claimed
 * funds to payTo, and give idle channels' unspent deposits back. The facilitator submits every transaction.
 */

/** A channel that paid nothing for this long, with money left in it, is refunded: the renter is done. */
export const REFUND_IDLE_MS = 600_000;
/** Claims and settles go out this often; a channel still ticking within REFUND_IDLE_MS is left for the next round. */
export const CLAIM_INTERVAL_SECONDS = 3600;
export const REFUND_INTERVAL_SECONDS = 600;

/** The slice of BatchSettlementChannelManager the command and the timers use. */
export type ClaimManager = Pick<BatchSettlementChannelManager, 'claimAndSettle' | 'refund'>;

const unspent = (c: Channel): bigint => BigInt(c.balance) - BigInt(c.chargedCumulativeAmount);
const pending = (c: Channel, now: number): boolean => c.pendingRequest !== undefined && c.pendingRequest.expiresAt > now;

/** Channels to refund now: idle for `idleMs`, no live request, and a balance above what their vouchers cover. */
export function selectRefundable(channels: Channel[], now: number, idleMs = REFUND_IDLE_MS): Channel[] {
  return channels.filter((c) => unspent(c) > 0n && !pending(c, now) && now - c.lastRequestTimestamp >= idleMs);
}

/** Claim hourly (channels idle 10 min), settle after, refund idle channels every 10 min. Errors are logged, never thrown. */
export function startClaims(m: BatchSettlementChannelManager, log: (m: string) => void): void {
  m.start({
    claimIntervalSecs: CLAIM_INTERVAL_SECONDS,
    settleIntervalSecs: CLAIM_INTERVAL_SECONDS,
    refundIntervalSecs: REFUND_INTERVAL_SECONDS,
    selectClaimChannels: (channels, ctx) => channels.filter((c) => ctx.now - c.lastRequestTimestamp >= REFUND_IDLE_MS),
    selectRefundChannels: (channels, ctx) => selectRefundable(channels, ctx.now),
    onClaim: (r) => log(`x402 claimed ${r.vouchers} vouchers tx ${r.transaction}`),
    onSettle: (r) => log(`x402 settled tx ${r.transaction}`),
    onRefund: (r) => log(`x402 refunded ${r.channel} tx ${r.transaction}`),
    onError: (e) => log(`x402 claims: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`),
  });
}

export const X402_USAGE = 'usage: charter-door x402 status | claim | refund';

/** `charter-door x402 status | claim | refund`: the timers' work, now, for a demo or for ops. Safe beside a running door (file locks). */
export async function x402Command(args: string[], m: ClaimManager, storage: ChannelStorage, now: () => number, out: (m: string) => void): Promise<number> {
  const [cmd, ...rest] = args;
  if (rest.length > 0 || (cmd !== 'status' && cmd !== 'claim' && cmd !== 'refund')) {
    out(X402_USAGE);
    return 2;
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
