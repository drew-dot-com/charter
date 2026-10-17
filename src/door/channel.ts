import type { ChannelExit, ChannelSummary } from '../payer.js';
import type { Micro } from '../types.js';

/** The slice of ToonClientPayer the channel command uses. */
export interface ChannelPayer {
  channels(): ChannelSummary[];
  headroom(): Promise<Micro | undefined>;
  warm(): Promise<void>;
  closeChannels(): Promise<ChannelExit[]>;
  settleChannels(): Promise<ChannelExit[]>;
}

export const CHANNEL_USAGE = 'usage: charter-door channel status | rotate | settle (stop the door first: one client per channel store)';

function line(c: ChannelSummary): string {
  const state = c.settledAt !== undefined ? 'settled' : c.closedAt !== undefined ? `closing, settleable at ${c.settleableAt ?? '?'}` : 'open';
  return `${c.channel.channelId} deposit ${c.depositTotal} signed ${c.signed} ${state}`;
}

function exits(rs: ChannelExit[], out: (m: string) => void): boolean {
  for (const r of rs) out(`${r.channelId}${r.transaction ? ` tx ${r.transaction}` : ''}${r.settleableAt !== undefined ? ` settleable at ${r.settleableAt}` : ''}${r.error ? ` error ${r.error.slice(0, 200)}` : ''}`);
  return rs.every((r) => !r.error);
}

/**
 * `charter-door channel status | rotate | settle`. `rotate` starts closing the door's open channel and opens a
 * fresh one (re-runnable: with none open it only opens), for when the headroom gate refuses opens and ticks: a Solana channel cannot be topped up.
 * `settle` later takes back the old deposits once their exit window has passed. Run with the door stopped,
 * since two clients on one channel store would race the voucher total.
 */
export async function channelCommand(args: string[], payer: ChannelPayer, out: (m: string) => void): Promise<number> {
  const [cmd, ...rest] = args;
  if (rest.length > 0 || (cmd !== 'status' && cmd !== 'rotate' && cmd !== 'settle')) {
    out(CHANNEL_USAGE);
    return 2;
  }
  if (cmd === 'status') {
    const all = payer.channels();
    if (all.length === 0) out('no channels');
    for (const c of all) out(line(c));
    const left = await payer.headroom();
    out(`headroom ${left === undefined ? 'none (no open channel)' : left.toString()}`);
    return 0;
  }
  if (cmd === 'settle') return exits(await payer.settleChannels(), out) ? 0 : 1;
  // With no open channel (a rotate whose close went through and whose open did not), only open.
  if (payer.channels().some((c) => c.closedAt === undefined && c.settledAt === undefined)) {
    if (!exits(await payer.closeChannels(), out)) {
      out('a close failed; not opening a fresh channel');
      return 1;
    }
  } else {
    out('no open channel to close');
  }
  await payer.warm();
  const left = await payer.headroom();
  out(`fresh channel open, headroom ${left === undefined ? 'none' : left.toString()}`);
  return left === undefined ? 1 : 0;
}
