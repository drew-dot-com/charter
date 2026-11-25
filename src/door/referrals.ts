import { isAddress } from 'viem';

/**
 * Reads the `referral` a renter named. undefined: none named. 'bad_referral': malformed, a mixed-case address
 * failing its checksum, the zero address, or one of `refuse` (lower case). Else the address in lower case.
 */
export function parseReferral(v: unknown, refuse: ReadonlyArray<string | undefined>): string | undefined | 'bad_referral' {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !isAddress(v)) return 'bad_referral';
  const a = v.toLowerCase();
  if (a === '0x' + '0'.repeat(40)) return 'bad_referral';
  if (refuse.includes(a)) return 'bad_referral';
  return a;
}

/** floor(paid * bps / 10000); on a host that is not listed, at most `fee`. */
export function shareOf(a: { paid: bigint; fee: bigint; bps: number; hostListed: boolean }): bigint {
  const share = (a.paid * BigInt(a.bps)) / 10_000n;
  return a.hostListed || share <= a.fee ? share : a.fee;
}
