// A tenant's HostApi through Charter's door: the door opens, reads and ticks the lease on the host for it.
// Only a tick is paid, through the door client's x402 `exact` payment; opens and reads are free.
import type { Answer, DoorClient } from '../fund/door-client.js';
import { FETCH_IMAGE, PYTHON_IMAGE, isHomeImage } from '../jobs.js';
import type { JobSpec, Lease, Micro } from '../types.js';
import { HostError, type HostApi, type OpenResult, type OutputPart, type TickResult } from './host-api.js';
import type { LeaseOffer } from './run-lease.js';

/** The most output parts the door serves of one lease. */
const MAX_OUTPUT_PARTS = 64;

/** An offer as the door shows it: what `GET /v1/offers` lists and a lease's status carries. `tickPrice` is what the renter pays. */
export interface DoorOffer {
  offerId: string;
  cpu: number;
  memoryMiB: number;
  intervalSeconds: number;
  /** Micro-USDC, as a decimal string. */
  tickPrice: string;
  images: string[];
  hiddenHost: boolean;
  expiresAt: number;
  home?: { diskGiB: number; retentionDays: number; slots: number; free?: number };
  /** The host's record; `funding: 'waiting'` while the door cannot fund it. */
  record?: { funding?: 'waiting' };
}

/** What runLease and continueLease need of an offer the door lists. */
export function leaseOfferOf(o: DoorOffer): LeaseOffer {
  return { id: o.offerId, intervalSeconds: o.intervalSeconds };
}

/**
 * The door opened a home on another offer than the one named: the offer of the host that holds the home's
 * disk. Nothing was paid; the lease waits for its first tick, priced and timed by `offer`.
 */
export class DoorOfferMovedError extends Error {
  constructor(
    readonly leaseId: string,
    readonly offer: DoorOffer,
  ) {
    super(`the door opened lease ${leaseId} on offer ${offer.offerId}, the host that holds this home`);
    this.name = 'DoorOfferMovedError';
  }
}

/** The body POST /v1/leases takes for a job (the inverse of jobFromBody), without the offerId. */
function bodyOf(job: JobSpec): Record<string, unknown> {
  if (isHomeImage(job.image)) return { home: { sshKeys: (job.args.SSH_KEYS ?? '').split('\n'), image: job.image } };
  if (job.image === PYTHON_IMAGE) return { python: { script: job.args.SCRIPT ?? '' } };
  if (job.image === FETCH_IMAGE) return { urls: (job.args.URLS ?? '').split(',') };
  throw new Error(`the door runs no ${job.image} job`);
}

function ok(a: Answer): boolean {
  return a.status >= 200 && a.status < 300;
}

function hostErrorOf(a: Answer): HostError {
  const error = typeof a.body?.error === 'string' ? (a.body.error as string) : `http_${a.status}`;
  return new HostError(a.status, error);
}

const leasePath = (leaseId: string) => `/v1/leases/${encodeURIComponent(leaseId)}`;

/**
 * The door's renter routes as a HostApi: `open` is POST /v1/leases on `offerId` (needed only to open), `tick`
 * the paid POST /v1/leases/:id/ticks, `status` GET /v1/leases/:id, output its parts. A non-2xx answer throws
 * HostError with the door's error. `spent()` sums what 2xx ticks signed (an `exact` payment settles only then).
 */
export function doorHostApi(c: DoorClient, offerId?: string): HostApi {
  let spent: Micro = 0n;

  const read = async (path: string): Promise<any> => {
    const a = await c.get(path);
    if (!ok(a)) throw hostErrorOf(a);
    return a.body;
  };

  const part = async (leaseId: string, n: number): Promise<OutputPart> => {
    if (n >= MAX_OUTPUT_PARTS) throw new HostError(404, 'not_found');
    return (await read(`${leasePath(leaseId)}/output/${n}`)) as OutputPart;
  };

  return {
    open: async (job) => {
      if (offerId === undefined) throw new Error('opening a lease needs an offer id');
      const a = await c.post('/v1/leases', { offerId, ...bodyOf(job) });
      if (!ok(a)) throw hostErrorOf(a);
      const r = a.body as OpenResult;
      // A home opens on the host that holds its disk, whatever offer was named: read which one, before paying.
      if (isHomeImage(job.image) && r.state !== 'closed') {
        const offer = ((await read(leasePath(r.leaseId))) as { offer?: DoorOffer }).offer;
        if (offer && offer.offerId !== offerId) throw new DoorOfferMovedError(r.leaseId, offer);
      }
      return r;
    },
    tick: async (leaseId, index) => {
      const a = await c.pay(`${leasePath(leaseId)}/ticks`, { index });
      if (!ok(a)) throw hostErrorOf(a);
      spent += a.paid ?? 0n;
      return a.body as TickResult;
    },
    status: async (leaseId) => ((await read(leasePath(leaseId))) as { lease: Lease }).lease,
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
