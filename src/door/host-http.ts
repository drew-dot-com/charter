import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { ClientEvmSigner } from '@x402/evm';
import { BatchSettlementEvmScheme, readChannelBalanceAndTotalClaimed } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { wrapFetchWithPayment, x402Client, type PaymentRequirements } from '@x402/fetch';
import type { LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signDoorRequest } from '../door-auth.js';
import { DeadlinePassedError, MIN_SEND_MS, SendTimeoutError } from '../errors.js';
import { HostError, type HostApi, type OpenResult, type OutputPart, type TickResult } from '../tenant/host-api.js';
import type { JobSpec, Lease, Micro, Offer } from '../types.js';
import { BASE_USDC } from '../x402/seller.js';
import type { HostQueue } from './host-queue.js';

/** The only network the door pays hosts on. */
export const DOOR_NETWORK = 'eip155:8453' as const;
/** The longest channel `withdrawDelay` the door accepts from a host: its deposit is never locked past a day. */
export const MAX_WITHDRAW_DELAY_SECONDS = 86_400;
/** A host call's default time limit. */
export const HOST_TIMEOUT_MS = 30_000;
/** The most output parts the door reads of one lease (64 parts of 48 KiB: 3 MiB). */
export const MAX_OUTPUT_PARTS = 64;
/** A pending deposit is checked against the chain at most this often per host. */
export const PENDING_CHECK_MS = 15_000;

const HOST_ID = /^[0-9a-f]{64}$/;

/** How much the door may deposit into this host's channel now, in micro-USDC, or `'over_cap'`: none. */
export type DepositFor = (hostId: string) => bigint | 'over_cap';

/** The door's capital cap leaves nothing, or less than the channel needs, to deposit into this host's channel. Nothing was signed. */
export class CapitalCapError extends Error {
  constructor(readonly hostId: string) {
    super(`no capital for host ${hostId}`);
    this.name = 'CapitalCapError';
  }
}

/** A host's 402 asked for something other than the one payment the door makes it. Nothing was signed. */
export class UnexpectedPaymentError extends Error {
  constructor() {
    super('unexpected_payment');
    this.name = 'UnexpectedPaymentError';
  }
}

/**
 * A deposit the door signed for this host is not yet in its channel record (no settle confirmed it). Signing
 * another would deposit twice; nothing was sent. Cleared when the record shows it, or by `clearPendingDeposit`.
 */
export class DepositPendingError extends Error {
  constructor(readonly hostId: string) {
    super(`a deposit for host ${hostId} is unconfirmed`);
    this.name = 'DepositPendingError';
  }
}

export interface DoorPayer {
  address: `0x${string}`;
  /** Signs door requests (`signDoorRequest`) and, as the channel's payer, deposits and vouchers. */
  account: LocalAccount;
  /** fetch that pays one host's 402 for one tick at `tickPrice`, from that host's channel, and nothing else. */
  paidFetch(offer: Offer, tickPrice: Micro): typeof fetch;
  /** What the door's channel records say this host has charged so far, summed over its channels. */
  charged(hostId: string): Promise<bigint>;
  /** Forget an unconfirmed deposit for this host (after the door resyncs its channel from chain). */
  clearPendingDeposit(hostId: string): void;
  /**
   * With a chain reader: brings every channel record of every host up to the chain (balance, claimed, and a
   * charged amount at least what was claimed) and clears the pending deposits the chain shows. The door runs
   * it at boot, so a deposit or a settle whose answer was lost before a restart is not paid twice.
   */
  resyncAll(): Promise<void>;
}

/** Reads a channel's `[balance, totalClaimed]` on chain (x402BatchSettlement `channels(channelId)`). */
export type ReadContract = NonNullable<ClientEvmSigner['readContract']>;

interface PendingDeposit {
  channelId: string;
  /** The record's balance when the deposit was signed, plus the deposit: what a record that reflects it shows. */
  balanceAfter: bigint;
  /** The deposit authorization's validBefore (epoch seconds): past it, a deposit not on chain never lands. */
  validBefore?: number;
  /** Epoch ms the chain was last read for it. */
  checkedAt?: number;
}

const sameAddress = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** One tick, as the door pays it: batch-settlement on Base in USDC to the offer's payTo, for exactly the snapshotted price. */
function isTheTick(r: PaymentRequirements, payTo: string, tickPrice: Micro): boolean {
  const extra = (r.extra ?? {}) as Record<string, unknown>;
  const delay = extra.withdrawDelay;
  const method = extra.assetTransferMethod;
  return (
    r.scheme === 'batch-settlement' &&
    r.network === DOOR_NETWORK &&
    sameAddress(r.asset, BASE_USDC) &&
    sameAddress(r.payTo, payTo) &&
    typeof r.amount === 'string' && /^\d+$/.test(r.amount) && BigInt(r.amount) === tickPrice &&
    // Absent, the client uses the library's floor; present, a host may not lock the door's deposit past a day.
    (delay === undefined || (typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_WITHDRAW_DELAY_SECONDS)) &&
    // The door deposits by EIP-3009 only, as it is paid: no Permit2 approvals.
    (method === undefined || method === 'eip3009')
  );
}

/** The door's x402 payment policy for one host's tick: keeps only the requirements `isTheTick` allows. */
export function paysOnly(offer: { payTo: string }, tickPrice: Micro): (version: number, reqs: PaymentRequirements[]) => PaymentRequirements[] {
  return (_version, reqs) => reqs.filter((r) => isTheTick(r, offer.payTo, tickPrice));
}

/** Whether a request already carries an x402 payment (the client's paid resend). */
function carriesPayment(input: RequestInfo | URL, init?: RequestInit): boolean {
  const h = input instanceof Request ? input.headers : new Headers(init?.headers);
  return h.has('payment-signature') || h.has('x-payment');
}

/**
 * Whether a 402 offers the tick the door pays. One with no readable PAYMENT-REQUIRED header is left to the
 * client, which refuses it without signing.
 */
function asksForTheTick(res: Response, payTo: string, tickPrice: Micro): boolean {
  const h = res.headers.get('payment-required');
  if (!h) return true;
  let accepts: unknown;
  try {
    accepts = (decodePaymentRequiredHeader(h) as { accepts?: unknown }).accepts;
  } catch {
    return true;
  }
  return Array.isArray(accepts) && accepts.some((r) => typeof r === 'object' && r !== null && isTheTick(r as PaymentRequirements, payTo, tickPrice));
}

/** The host ids the door holds channel records for (one dir each under `channelDir`). */
async function hostDirs(channelDir: string): Promise<string[]> {
  try {
    return (await readdir(channelDir)).filter((d) => HOST_ID.test(d));
  } catch {
    return [];
  }
}

/** Where the door keeps one host's channel records. */
function hostChannelDir(channelDir: string, hostId: string): string {
  if (!HOST_ID.test(hostId)) throw new Error('hostId must be 64 lowercase hex');
  return join(channelDir, hostId);
}

/** The channel ids the door holds records for under this host's dir (FileClientChannelStorage keeps `client/<channelId>.json`). */
async function channelKeys(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'client'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

const amountOf = (v: string | undefined): bigint => (v !== undefined && /^\d+$/.test(v) ? BigInt(v) : 0n);

/**
 * The door as an x402 payer of hosts: one Base key, one batch-settlement channel per host, its records on
 * disk under `channelDir/<hostId>` so a restarted door continues each channel's cumulative amount.
 */
export function doorPayer(o: {
  key: `0x${string}`;
  channelDir: string;
  depositFor: DepositFor;
  fetch?: typeof fetch;
  /** Called once for each deposit the door signs, with its amount in micro-USDC. */
  onDeposit?: (hostId: string, channelId: string, amount: bigint) => void;
  /**
   * Base reads (viem `readContract` on BASE_RPC_URL). With it the batch client rebuilds a lost record and
   * resyncs one a host reports behind from chain and the door's own voucher signature, and a pending deposit
   * is cleared once the chain shows it (or once its authorization has lapsed without it). Without: records
   * only move by the hosts' answers.
   */
  readContract?: ReadContract;
  /** Epoch ms. */
  now?: () => number;
}): DoorPayer {
  const account = privateKeyToAccount(o.key);
  const now = o.now ?? Date.now;
  const signer: ClientEvmSigner = {
    address: account.address,
    signTypedData: (m) => account.signTypedData(m as unknown as Parameters<typeof account.signTypedData>[0]),
    ...(o.readContract ? { readContract: o.readContract } : {}),
  };
  const base = o.fetch ?? fetch;
  const storageOf = (hostId: string) => new FileClientChannelStorage({ directory: hostChannelDir(o.channelDir, hostId) });
  const pending = new Map<string, PendingDeposit>();

  /**
   * One record brought up to the chain (made from it when there is none yet, as after a first deposit whose
   * answer was lost): its balance and claimed amount as the contract has them, its charged amount at least the
   * claimed one. A resync may move charged by several ticks at once: every voucher behind it is one the door signed.
   */
  const resyncChannel = async (hostId: string, channelId: string): Promise<void> => {
    const storage = storageOf(hostId);
    const rec = (await storage.get(channelId)) ?? {};
    const [balance, claimed] = await readChannelBalanceAndTotalClaimed(signer, channelId as `0x${string}`);
    const charged = amountOf(rec.chargedCumulativeAmount);
    await storage.set(channelId, {
      ...rec,
      balance: balance.toString(),
      totalClaimed: claimed.toString(),
      chargedCumulativeAmount: (claimed > charged ? claimed : charged).toString(),
    });
  };

  /**
   * Whether a deposit signed for this host is still unconfirmed. A record that shows it clears it; with a chain
   * reader, so does the chain (read at most every PENDING_CHECK_MS), or the lapse of its authorization.
   */
  const depositPending = async (hostId: string): Promise<boolean> => {
    const p = pending.get(hostId);
    if (!p) return false;
    const shows = async () => amountOf((await storageOf(hostId).get(p.channelId))?.balance) >= p.balanceAfter;
    if (await shows()) {
      pending.delete(hostId);
      return false;
    }
    if (!o.readContract || (p.checkedAt !== undefined && now() - p.checkedAt < PENDING_CHECK_MS)) return true;
    p.checkedAt = now();
    try {
      await resyncChannel(hostId, p.channelId);
    } catch {
      return true;
    }
    // Read after the chain: a deposit past its validBefore that the chain does not show can never land.
    if ((await shows()) || (p.validBefore !== undefined && now() / 1000 > p.validBefore)) {
      pending.delete(hostId);
      return false;
    }
    return true;
  };

  return {
    address: account.address,
    account,
    clearPendingDeposit: (hostId) => void pending.delete(hostId),
    async resyncAll() {
      if (!o.readContract) return;
      for (const hostId of await hostDirs(o.channelDir)) {
        for (const key of await channelKeys(hostChannelDir(o.channelDir, hostId))) await resyncChannel(hostId, key);
        const p = pending.get(hostId);
        if (p && amountOf((await storageOf(hostId).get(p.channelId))?.balance) >= p.balanceAfter) pending.delete(hostId);
      }
    },
    async charged(hostId) {
      const storage = storageOf(hostId);
      let sum = 0n;
      for (const key of await channelKeys(hostChannelDir(o.channelDir, hostId))) sum += amountOf((await storage.get(key))?.chargedCumulativeAmount);
      return sum;
    },
    paidFetch(offer, tickPrice) {
      const dir = hostChannelDir(o.channelDir, offer.hostId);
      const storage = storageOf(offer.hostId);
      const keep = paysOnly(offer, tickPrice);
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        // A deposit already signed and not yet in the record: the chain may hold it. Nothing more is sent.
        if (await depositPending(offer.hostId)) throw new DepositPendingError(offer.hostId);
        // With no channel record a first payment is a deposit: refused here, before anything is sent.
        if ((await channelKeys(dir)).length === 0 && o.depositFor(offer.hostId) === 'over_cap') throw new CapitalCapError(offer.hostId);
        // The x402 fetch wraps every error in a plain one, so the reason is noted here and rethrown typed.
        const refused = { capped: false, unexpected: false, pending: false };
        const scheme = new BatchSettlementEvmScheme(signer, {
          storage,
          depositStrategy: async ({ minimumDepositAmount }) => {
            if (await depositPending(offer.hostId)) {
              refused.pending = true;
              throw new DepositPendingError(offer.hostId);
            }
            const d = o.depositFor(offer.hostId);
            // Never raised to the minimum: the door deposits no more than depositFor allows.
            if (d === 'over_cap' || d < BigInt(minimumDepositAmount)) {
              refused.capped = true;
              throw new CapitalCapError(offer.hostId);
            }
            return d;
          },
        });
        // No spend controls: `isTheTick` fixes the amount, and `depositFor` alone sizes a deposit (the default
        // controls would cap it at five times $1 without a word).
        const client = new x402Client().register(DOOR_NETWORK, scheme).setSpendControls(false);
        client
          .registerPolicy((version, reqs) => {
            const kept = keep(version, reqs);
            if (kept.length === 0) refused.unexpected = true;
            return kept;
          })
          // And once one is chosen, check it again before anything is signed.
          .onBeforePaymentCreation(async ({ selectedRequirements }) => {
            if (isTheTick(selectedRequirements, offer.payTo, tickPrice)) return undefined;
            refused.unexpected = true;
            return { abort: true, reason: 'unexpected_payment' };
          })
          // A signed deposit is pending until the channel record shows it (a successful settle adds it).
          .onAfterPaymentCreation(async ({ paymentPayload }) => {
            const p = paymentPayload.payload as {
              type?: unknown;
              deposit?: { amount?: unknown; authorization?: { erc3009Authorization?: { validBefore?: unknown } } };
              voucher?: { channelId?: unknown };
            };
            if (p.type !== 'deposit' || typeof p.deposit?.amount !== 'string' || typeof p.voucher?.channelId !== 'string') return;
            const channelId = p.voucher.channelId.toLowerCase();
            const amount = amountOf(p.deposit.amount);
            const before = amountOf((await storage.get(channelId))?.balance);
            const vb = p.deposit.authorization?.erc3009Authorization?.validBefore;
            const validBefore = typeof vb === 'string' && /^\d{1,15}$/.test(vb) ? Number(vb) : undefined;
            pending.set(offer.hostId, { channelId, balanceAfter: before + amount, ...(validBefore === undefined ? {} : { validBefore }) });
            o.onDeposit?.(offer.hostId, channelId, amount);
          });
        // The 402 itself is read first: when it asks for nothing the door pays, the client never sees it.
        const asked: typeof fetch = async (req, reqInit) => {
          const res = await base(req, reqInit);
          if (res.status === 402 && !carriesPayment(req, reqInit) && !asksForTheTick(res, offer.payTo, tickPrice)) {
            await res.body?.cancel().catch(() => undefined);
            throw new UnexpectedPaymentError();
          }
          return res;
        };
        try {
          return await wrapFetchWithPayment(asked, client)(input, init);
        } catch (e) {
          if (refused.pending) throw new DepositPendingError(offer.hostId);
          if (refused.capped) throw new CapitalCapError(offer.hostId);
          if (refused.unexpected) throw new UnexpectedPaymentError();
          throw e;
        }
      }) as typeof fetch;
    },
  };
}

/** `fn` with `ms` to answer, else SendTimeoutError; its signal is aborted then, so nothing more is sent. */
async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SendTimeoutError());
      ac.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Answer {
  status: number;
  body: unknown;
}

function hostErrorOf(a: Answer): HostError {
  const e = (a.body as { error?: unknown } | null)?.error;
  return new HostError(a.status, typeof e === 'string' ? e : 'unknown');
}

const ok = (a: Answer): boolean => a.status >= 200 && a.status < 300;

/**
 * A host's lease API over HTTPS. Every call is signed as the door's (`signDoorRequest`) over exactly the
 * path and body it sends. Opens, status and output reads are free and go straight out; a tick is paid
 * through `payer.paidFetch` at `tickPrice` (default the offer's), one per host at a time through `queue`.
 *
 * `spent()` is measured from the door's channel record, not the status: a tick costs what the record's
 * charged amount moved during it (a host may settle and answer non-2xx), or its full price when it times out
 * (it may have been paid). A tick index that cost anything is never sent again. Non-2xx throws HostError; a 402 the door will not pay throws
 * HostError(402, 'unexpected_payment').
 */
export function httpHostApi(
  o: Offer,
  d: { payer: DoorPayer; queue: HostQueue; tickPrice?: Micro; timeoutMs?: number; now?: () => number; fetch?: typeof fetch },
): HostApi {
  const now = d.now ?? Date.now;
  const timeoutMs = d.timeoutMs ?? HOST_TIMEOUT_MS;
  const price = d.tickPrice ?? o.tickPrice;
  const base = o.url.replace(/\/+$/, '');
  const free = d.fetch ?? fetch;
  const paid = d.payer.paidFetch(o, price);
  let spent: Micro = 0n;
  const counted = new Set<string>();

  /** How long a call may take: the default, capped by its deadline. Too close to the deadline, it is not sent. */
  const budget = (deadline: number | undefined): number => {
    if (deadline === undefined) return timeoutMs;
    const left = deadline - now();
    if (left < MIN_SEND_MS) throw new DeadlinePassedError();
    return Math.min(timeoutMs, left);
  };

  async function send(method: 'GET' | 'POST', path: string, body: unknown, f: typeof fetch, deadline?: number): Promise<Answer> {
    const ms = budget(deadline);
    const url = new URL(base + path);
    const text = body === undefined ? '' : JSON.stringify(body);
    const auth = await signDoorRequest(d.payer.account, url.origin, method, url.pathname + url.search, text, now());
    const headers = { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    return withTimeout(ms, async (signal) => {
      const res = await f(url, { method, headers, signal, ...(body === undefined ? {} : { body: text }) });
      const raw = await res.text();
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not JSON: kept as text.
      }
      return { status: res.status, body: parsed };
    });
  }

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, deadline?: number): Promise<unknown> => {
    const a = await send(method, path, body, free, deadline);
    if (!ok(a)) throw hostErrorOf(a);
    return a.body;
  };

  const part = async (leaseId: string, n: number): Promise<OutputPart> => {
    // Past MAX_OUTPUT_PARTS a lease's output is not read: no host makes the door fetch without end.
    if (n >= MAX_OUTPUT_PARTS) throw new HostError(404, 'not_found');
    return (await call('GET', `/v1/leases/${leaseId}/output/${n}`)) as OutputPart;
  };

  return {
    open: async (job: JobSpec) => (await call('POST', '/v1/leases', { job })) as OpenResult,
    tick: async (leaseId, index, opts) => {
      const key = `${leaseId}:${index}`;
      const deadline = opts?.deadline;
      return d.queue.run(o.hostId, deadline, async (): Promise<TickResult> => {
        if (counted.has(key)) throw new HostError(409, 'duplicate');
        // The cost is what the channel record moved, whatever the status: a host may settle and still answer 500.
        const before = await d.payer.charged(o.hostId);
        const settle = async (): Promise<void> => {
          const moved = (await d.payer.charged(o.hostId)) - before;
          if (moved > 0n) {
            spent += moved;
            counted.add(key);
          }
        };
        let a: Answer;
        try {
          a = await send('POST', `/v1/leases/${leaseId}/ticks`, { index }, paid, deadline);
        } catch (e) {
          if (e instanceof SendTimeoutError) {
            // No answer, so no record of a charge: it may have been paid.
            spent += price;
            counted.add(key);
          } else {
            await settle();
          }
          if (e instanceof UnexpectedPaymentError) throw new HostError(402, 'unexpected_payment');
          throw e;
        }
        await settle();
        if (!ok(a)) throw hostErrorOf(a);
        return a.body as TickResult;
      }, now);
    },
    // Free and unqueued: `priority` has nothing to jump. A deadline still bounds the read.
    status: async (leaseId, opts) => ((await call('GET', `/v1/leases/${leaseId}`, undefined, opts?.deadline)) as { lease: Lease }).lease,
    outputPart: part,
    output: async (leaseId) => {
      const first = await part(leaseId, 0);
      if (!Number.isSafeInteger(first.parts) || first.parts > MAX_OUTPUT_PARTS) throw new HostError(502, 'too_many_parts');
      const chunks = [Buffer.from(first.data, 'base64')];
      for (let n = 1; n < first.parts; n++) chunks.push(Buffer.from((await part(leaseId, n)).data, 'base64'));
      return Buffer.concat(chunks);
    },
    spent: () => spent,
  };
}
