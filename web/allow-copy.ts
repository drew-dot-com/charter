/** Pure helpers and plain-words copy for the /allow page. No DOM, no wallet. */

/** Micro-USDC (6 decimals) as an exact decimal string, no dollar sign, no trailing zeros. */
export function formatUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? `${whole}` : `${whole}.${frac}`;
}

/** Whole hours (ticks) an allowance buys at the home's tick price. */
export function hoursFor(allowanceMicro: bigint, tickMicro: bigint): number {
  return tickMicro <= 0n ? 0 : Number(allowanceMicro / tickMicro);
}

/** The typed amount as micro-USDC, or a string saying what is wrong. */
export function clampAllowance(input: string, minMicro: bigint, maxMicro: bigint): bigint | string {
  const s = input.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return 'Type an amount in USDC, for example 5.';
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
  if (micro < minMicro) return `The smallest amount is ${formatUsdc(minMicro)} USDC (30 days of the home).`;
  if (micro > maxMicro) return `The largest amount is ${formatUsdc(maxMicro)} USDC (31 days of the home).`;
  return micro;
}

export const BEFORE_YOU_START =
  'What you will meet: a Coinbase window will open in a pop-up, so allow pop-ups for this page if your browser asks. '
  + 'If you have no Base Account yet, Coinbase will ask you to make one with your email address and a passkey, which takes about a minute. '
  + 'Then you give one signature. Nothing is charged by signing.';

/**
 * How the person stops the allowance. The Base Account cancel is named only once it is proven on mainnet
 * (CANCEL_TESTED in allow.ts); until then the agent's stop and the operator are the ways that work.
 */
export function stopWords(cancelTested: boolean): string {
  return cancelTested
    ? 'You can cancel at any time in your Base Account (account.base.app), under spend permissions. The agent can also ask Charter to stop.'
    : 'To stop it, ask the agent to stop it, or contact the operator.';
}

const STATES: Record<string, string> = {
  waiting: 'Waiting for your approval.',
  approved: 'Approved. Charter is checking your permission on the chain, this takes a minute or two.',
  active: 'On. Charter pays for the home hour by hour from your allowance.',
  short: 'Paused. Your account did not have enough USDC for the last payment. Add USDC on Base and it resumes by itself.',
  spent_for_period: 'This month\'s allowance is used up. Payments resume when the next 30 days begin.',
  stopping: 'Stopping. Charter is cancelling the permission.',
  refused: 'Charter could not use this permission, so nothing was started.',
  ended: 'Ended. Charter will not take any more payments.',
  expired: 'This link expired before it was approved. Ask the agent for a new one.',
};

export function stateWords(state: string): string {
  return STATES[state] ?? 'Charter reported a state this page does not know.';
}

const ERRORS: Record<string, string> = {
  not_waiting: 'This link was already used or has ended. Ask the agent for a new one if you still want to approve.',
  permission_in_use: 'That permission was already used for another home. Please start again and sign a fresh one.',
  not_found: 'This link is not valid. Ask the agent for a new one.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
};

/** A door error code or message as a sentence a person can act on. */
export function errorWords(error: string): string {
  return ERRORS[error] ?? `Charter did not accept the approval (${error}). Nothing was charged. Try again, or ask the agent for a new link.`;
}
