import type { Lease } from '../src/types.js';
import { isPriceUnconfirmed, isUnexpectedPayment, PRICE_UNCONFIRMED, tickOutcome, UNEXPECTED_PAYMENT } from './format.js';
import { nextTickAt } from './schedule.js';

/** The tick state machine of a lease page. No DOM, no wallet, no clock of its own: `runTick` takes its effects as deps. */

export const RETRY_LATER_MAX = 3;
export const RETRY_LATER_DELAY_MS = 2_000;
export const MAX_RESYNCS = 3;

export interface Halt {
  message: string;
  retry: boolean;
}

export interface TickState {
  /** What this page knows of the lease: the last status, kept ahead of it by what ticks have answered. */
  lease: Lease | undefined;
  /** The index of the next tick to send. */
  nextIndex: number;
  /** Out-of-sync answers in a row. */
  resyncs: number;
  /** After any refused or unsettled tick, no further tick until a fresh status has been read. */
  holdTicks: boolean;
  halt: Halt | undefined;
  ticking: boolean;
}

export interface Answer {
  status: number;
  body: unknown;
}

export interface TickDeps {
  /** Sends one tick (paying it when the door asks). Rejects when nothing could be sent. */
  post(index: number): Promise<Answer>;
  /** Reads the status now, unless one was read within the poll interval; the read lands in `applyStatus`. */
  refresh(): Promise<void>;
  /** Ask for a status read at the next opportunity. */
  requestPoll(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** False once the page has been left: nothing more is sent or changed. */
  alive(): boolean;
}

export const newTickState = (): TickState => ({ lease: undefined, nextIndex: 0, resyncs: 0, holdTicks: false, halt: undefined, ticking: false });

const isFinal = (l: Lease | undefined): boolean => l?.state === 'done' || l?.state === 'closed';

/** A stale status (the door caches it for a few seconds) never takes back what this page has already seen. */
function merge(local: Lease | undefined, polled: Lease): Lease {
  if (!local || isFinal(polled) || polled.paidIntervals >= local.paidIntervals) return polled;
  return { ...polled, state: local.state, paidIntervals: local.paidIntervals, paidThrough: local.paidThrough };
}

/** A status read arrived. It lifts the hold on ticks; it does not clear a halt. */
export function applyStatus(s: TickState, polled: Lease): void {
  s.lease = merge(s.lease, polled);
  s.nextIndex = Math.max(s.nextIndex, s.lease.paidIntervals);
  s.holdTicks = false;
}

/** The renter pressed "Try again". A fresh status is still needed before the next tick. */
export function clearHalt(s: TickState): void {
  s.halt = undefined;
  s.resyncs = 0;
  s.holdTicks = true;
}

/** The next tick is due and nothing holds it back. */
function ready(s: TickState, now: number): boolean {
  if (!s.lease || s.halt || s.holdTicks) return false;
  const due = nextTickAt(s.lease, now);
  return due !== null && now >= due;
}

/** Whether the next tick should be sent now. */
export function shouldTick(s: TickState, now: number): boolean {
  return !s.ticking && ready(s, now);
}

function stop(s: TickState, deps: TickDeps, halt: Halt): void {
  s.halt = halt;
  s.holdTicks = true;
  deps.requestPoll();
}

/** Pays the next tick: one send, with the allowed retries, and what the answer means for the state. */
export async function runTick(s: TickState, deps: TickDeps): Promise<void> {
  s.ticking = true;
  try {
    // A tick sent to a lease that finished since the last look is paid by the door for nothing: look first.
    await deps.refresh();
    if (!deps.alive() || !ready(s, deps.now())) return;
    let retries = 0;
    for (;;) {
      const index = s.nextIndex;
      let a: Answer;
      try {
        a = await deps.post(index);
      } catch (e) {
        if (!deps.alive()) return;
        stop(s, deps, isPriceUnconfirmed(e)
          ? { message: `${PRICE_UNCONFIRMED}. Nothing was signed. Try again.`, retry: true }
          : isUnexpectedPayment(e)
            ? { message: `${UNEXPECTED_PAYMENT}. Nothing was signed.`, retry: false }
            : { message: `The payment was not sent: ${short(e)}`, retry: true });
        return;
      }
      if (!deps.alive()) return;
      const out = tickOutcome(a.status, a.body);
      switch (out.kind) {
        case 'paid': {
          s.resyncs = 0;
          s.nextIndex = index + 1;
          const l = s.lease!;
          // An accepted tick names the new paid time. A running lease with no paid time is never scheduled,
          // so an answer without one stops the ticks until the next status.
          s.lease = {
            ...l,
            paidIntervals: Math.max(l.paidIntervals, out.paidIntervals),
            paidThrough: out.paidThrough,
            state: l.state === 'awaiting_first_tick' ? 'running' : l.state,
          };
          deps.requestPoll();
          return;
        }
        case 'retry_later':
          // Nothing settled. Wait a moment, then send the same index again (the wallet signs a new authorization).
          if (++retries > RETRY_LATER_MAX) {
            stop(s, deps, { message: 'The door is busy. Try again in a moment.', retry: true });
            return;
          }
          await deps.sleep(RETRY_LATER_DELAY_MS);
          if (!deps.alive()) return;
          continue;
        case 'resync':
          if (++s.resyncs > MAX_RESYNCS) {
            stop(s, deps, { message: 'This page and the door disagree about the next payment. Reload the page.', retry: false });
            return;
          }
          s.nextIndex = out.expected;
          s.holdTicks = true;
          deps.requestPoll();
          return;
        case 'halt':
          stop(s, deps, { message: out.message, retry: out.retry });
          return;
      }
    }
  } finally {
    s.ticking = false;
  }
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 140 ? `${m.slice(0, 140)}...` : m;
}
