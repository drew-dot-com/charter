import { DeadlinePassedError, MIN_SEND_MS } from '../errors.js';

interface Waiting {
  deadline: number | undefined;
  seq: number;
  now: () => number;
  start: () => void;
  refuse: (e: Error) => void;
}

/** Earliest deadline first, calls with no deadline last; first in, first out within one deadline. */
function before(a: Waiting, b: Waiting): boolean {
  const da = a.deadline ?? Number.POSITIVE_INFINITY;
  const db = b.deadline ?? Number.POSITIVE_INFINITY;
  return da !== db ? da < db : a.seq < b.seq;
}

/**
 * The door's paid calls, one in flight per host. A host's channel takes one voucher at a time (the x402
 * batch server answers "Channel is already processing a request" to a second), and each voucher names the
 * running total, so two at once would race it. A call whose deadline came within MIN_SEND_MS while it waited
 * is refused with DeadlinePassedError when its turn comes, without running.
 */
export class HostQueue {
  private readonly busy = new Set<string>();
  private readonly waiting = new Map<string, Waiting[]>();
  private seq = 0;

  run<T>(hostId: string, deadline: number | undefined, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const w: Waiting = {
        deadline,
        seq: this.seq++,
        now,
        start: () => {
          let p: Promise<T>;
          try {
            p = fn();
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then(resolve, reject).finally(() => {
            this.busy.delete(hostId);
            this.pump(hostId);
          });
        },
        refuse: reject,
      };
      const list = this.waiting.get(hostId) ?? [];
      const at = list.findIndex((x) => before(w, x));
      list.splice(at < 0 ? list.length : at, 0, w);
      this.waiting.set(hostId, list);
      this.pump(hostId);
    });
  }

  private pump(hostId: string): void {
    const list = this.waiting.get(hostId);
    while (!this.busy.has(hostId) && list && list.length > 0) {
      const w = list.shift()!;
      if (w.deadline !== undefined && w.deadline - w.now() < MIN_SEND_MS) {
        w.refuse(new DeadlinePassedError());
        continue;
      }
      this.busy.add(hostId);
      w.start();
    }
    if (list && list.length === 0) this.waiting.delete(hostId);
  }
}
