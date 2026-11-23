import type { CloseReason, JobSpec, Lease, LeaseState, Micro } from '../types.js';

/** The host answered with a non-2xx status. */
export class HostError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {
    super(`host answered ${status} ${error}`);
    this.name = 'HostError';
  }
}

export interface OpenResult {
  leaseId: string;
  state: LeaseState;
  closedReason?: CloseReason;
  error?: string;
}

export interface TickResult {
  paidIntervals: number;
  /** Epoch ms. A host always sends it on an accepted tick; a tenant that gets none pays no further tick. */
  paidThrough?: number;
  duplicate: boolean;
}

export interface HostApi {
  open(job: JobSpec): Promise<OpenResult>;
  /** `deadline` (epoch ms): the call must not be in flight after it. */
  tick(leaseId: string, index: number, opts?: { deadline?: number }): Promise<TickResult>;
  /** `priority` and `deadline` as for a tick: the door's read just before a tick uses both. */
  status(leaseId: string, opts?: { priority?: 'high'; deadline?: number }): Promise<Lease>;
  /** Every part of result.json, joined. */
  output(leaseId: string): Promise<Buffer>;
  /** One part of result.json as the host answers it (base64 `data`). */
  outputPart(leaseId: string, part: number): Promise<OutputPart>;
  /** Everything paid so far through this API. */
  spent(): Micro;
}

export interface OutputPart {
  part: number;
  parts: number;
  data: string;
}
