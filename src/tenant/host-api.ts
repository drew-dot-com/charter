import type { Payer, PacketAnswer, PacketRequest } from '../payer.js';
import type { CloseReason, JobSpec, Lease, LeaseState, Micro, Offer } from '../types.js';

/** The host's app answered with a non-2xx status. The packet was still paid. */
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
  /** Epoch ms. Absent when the job had already finished. */
  paidThrough?: number;
  duplicate: boolean;
}

export interface HostApi {
  open(job: JobSpec): Promise<OpenResult>;
  tick(leaseId: string, index: number): Promise<TickResult>;
  status(leaseId: string): Promise<Lease>;
  /** Every part of result.json, joined. Each part is one paid status call. */
  output(leaseId: string): Promise<Buffer>;
  /** One part of result.json as the host answers it (base64 `data`). One paid status call. */
  outputPart(leaseId: string, part: number): Promise<OutputPart>;
  /** Everything paid so far through this API, from every answer, 4xx and 5xx included. */
  spent(): Micro;
}

export interface OutputPart {
  part: number;
  parts: number;
  data: string;
}

/** The three TOON apps of one offer, as typed calls. Throws HostError on a non-2xx answer. */
export function hostApi(p: Payer, o: Offer): HostApi {
  let spent: Micro = 0n;

  async function call(app: 'open' | 'tick' | 'status', amount: Micro, req: PacketRequest): Promise<unknown> {
    const a: PacketAnswer = await p.send(`${o.ilpBase}.charter-${app}`, req, { sealKey: o.sealKey, amount, ...(app === 'tick' ? { priority: 'high' as const } : {}) });
    spent += a.paid;
    if (a.status < 200 || a.status >= 300) {
      const e = (a.body as { error?: unknown } | null)?.error;
      throw new HostError(a.status, typeof e === 'string' ? e : 'unknown');
    }
    return a.body;
  }

  const status = async (leaseId: string): Promise<Lease> =>
    ((await call('status', o.statusPrice, { method: 'GET', path: `/leases/${leaseId}` })) as { lease: Lease }).lease;

  const part = async (leaseId: string, n: number): Promise<OutputPart> =>
    (await call('status', o.statusPrice, { method: 'GET', path: `/leases/${leaseId}/output/${n}` })) as OutputPart;

  return {
    open: async (job) => (await call('open', o.openPrice, { method: 'POST', path: '/open', body: { job } })) as OpenResult,
    tick: async (leaseId, index) =>
      (await call('tick', o.tickPrice, { method: 'POST', path: '/tick', body: { leaseId, index } })) as TickResult,
    status,
    outputPart: part,
    output: async (leaseId) => {
      const first = await part(leaseId, 0);
      const chunks = [Buffer.from(first.data, 'base64')];
      for (let n = 1; n < first.parts; n++) chunks.push(Buffer.from((await part(leaseId, n)).data, 'base64'));
      return Buffer.concat(chunks);
    },
    spent: () => spent,
  };
}
