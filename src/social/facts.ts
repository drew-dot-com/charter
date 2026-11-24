import type { Sources } from './sources.js';
import type { SocialEvent } from './events.js';
import type { Optins } from './files.js';
import { JOB_IMAGES } from '../images.js';

export interface Fact { id: string; text: string }
export interface OfferLite { offerId: string; tickPrice: string; intervalSeconds: number; images: string[]; home?: { diskGiB: number; slots: number; free: number; root: boolean } }
/** txLinks: full basescan URLs the writer may use. mentionable: X handles without '@'. */
export interface FactSheet { facts: Fact[]; txLinks: string[]; mentionable: string[] }
/** `name` is "a renter", "a grantee" or "a host" when the subject has not opted in. */
export interface Subject { named: boolean; name: string; handle?: string }

/** Micro-USDC (6 decimals) as a plain decimal string: "7000" -> "0.007". */
export function microToUsdcText(micro: string): string {
  const n = BigInt(micro);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Who an event is about. Only an id in optins.json is named; the grant's own typed name is never read. */
export function subjectOf(e: SocialEvent, _src: Sources, optins: Optins): Subject {
  let fallback: string;
  let hit: { name: string; handle?: string } | undefined;
  switch (e.kind) {
    case 'renter_returned':
      fallback = 'a renter';
      hit = optins.renters[e.payer.toLowerCase()];
      break;
    case 'milestone':
      if (e.grantId !== undefined) {
        fallback = 'a grantee';
        hit = optins.grants[e.grantId.toLowerCase()];
      } else {
        fallback = 'a renter';
        hit = e.payer ? optins.renters[e.payer.toLowerCase()] : undefined;
      }
      break;
    case 'grant_approved':
      fallback = 'a grantee';
      hit = optins.grants[e.grantId.toLowerCase()];
      break;
    case 'host_listed':
      fallback = 'a host';
      hit = optins.hosts[e.hostId.toLowerCase()];
      break;
  }
  if (!hit) return { named: false, name: fallback };
  return hit.handle ? { named: true, name: hit.name, handle: hit.handle } : { named: true, name: hit.name };
}

/** Price per hour when the interval divides an hour's cost evenly, else per interval. */
function priceText(noun: string, o: OfferLite): string {
  const total = BigInt(o.tickPrice) * 3600n;
  const iv = BigInt(o.intervalSeconds);
  if (iv > 0n && total % iv === 0n) return `${noun} costs ${microToUsdcText((total / iv).toString())} USDC per hour.`;
  return `${noun} costs ${microToUsdcText(o.tickPrice)} USDC per ${o.intervalSeconds} seconds.`;
}

const hoursText = (h: number): string => `${h} ${h === 1 ? 'hour' : 'hours'}`;

/**
 * Everything the writer may state. No wallet address, unopted name, pitch name or host url is ever put in a fact.
 * `excludePayers` is required (lowercased wallets; Task 10 passes firstParty union probes). Those payers are left out of
 * every outside-facing total: leases running and hours paid. Grant leases count as outside tenants for leases running
 * (even when the fund pays) but never for hours paid by outside renters.
 */
export function buildFactSheet(input: { event?: SocialEvent; src: Sources; offers: OfferLite[]; factsMd: string; optins: Optins; siteUrl: string; now: number; excludePayers: ReadonlySet<string> }): FactSheet {
  const { event, src, offers, factsMd, optins, siteUrl, now } = input;
  const facts: Fact[] = [];
  const txLinks: string[] = [];
  const mentionable: string[] = [];

  // Offers come from self-registered hosts: only their numbers and known image names are published, and the
  // fact id uses the position, never the host-chosen offerId.
  offers.forEach((o, n) => {
    const noun = o.home ? 'A home' : 'A job';
    facts.push({ id: `offer:${n}:price`, text: priceText(noun, o) });
    const images = o.images.filter((i) => JOB_IMAGES.includes(i));
    if (images.length) facts.push({ id: `offer:${n}:images`, text: `Images offered: ${images.join(', ')}.` });
    if (o.home) facts.push({ id: `offer:${n}:home`, text: `A home has ${o.home.diskGiB} GiB of disk, with ${o.home.slots} ${o.home.slots === 1 ? 'slot' : 'slots'}.` });
  });

  const excluded = input.excludePayers;
  const grantLeases = new Set(src.grants.map((g) => g.leaseId).filter((x): x is string => !!x));
  const running = src.leases.filter((l) => (grantLeases.has(l.leaseId) || !l.payer || !excluded.has(l.payer.toLowerCase())) && !l.stopped && l.lastTickAt !== undefined && now - l.lastTickAt <= 2 * l.offer.intervalSeconds * 1000).length;
  const outsideHours = src.leases
    .filter((l) => l.payer && !excluded.has(l.payer.toLowerCase()) && !grantLeases.has(l.leaseId))
    .reduce((n, l) => n + l.ticksPaidByRenter, 0);
  const hostsListed = src.hosts.filter((h) => h.state === 'listed').length;
  const grantsApproved = src.grants.filter((g) => g.state !== 'queued' && g.state !== 'declined').length;
  facts.push({ id: 'totals:running', text: `Leases running now: ${running}.` });
  facts.push({ id: 'totals:hours', text: `Hours paid by outside renters so far: ${outsideHours}.` });
  facts.push({ id: 'totals:hosts', text: `Hosts listed: ${hostsListed}.` });
  facts.push({ id: 'totals:grants', text: `Grants approved: ${grantsApproved}.` });
  facts.push({ id: 'site', text: `Site: ${siteUrl}` });

  factsMd.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t) facts.push({ id: `facts.md:${i + 1}`, text: t });
  });

  if (event) {
    const s = subjectOf(event, src, optins);
    facts.push({ id: 'event:subject', text: `Subject: ${s.name}.` });
    if (s.handle) mentionable.push(s.handle);
    if (event.kind === 'renter_returned') {
      facts.push({ id: 'event:hours', text: `${s.name} has paid for ${hoursText(event.hoursPaid)} in total, and came back for more.` });
    } else if (event.kind === 'milestone') {
      facts.push({ id: 'event:hours', text: `${s.name} has reached ${hoursText(event.hours)} paid.` });
    } else if (event.kind === 'grant_approved') {
      facts.push({ id: 'event:kind', text: `${s.name} was approved for a free home.` });
    } else {
      facts.push({ id: 'event:kind', text: `${s.name} was listed on the network.` });
    }
    // A per-wallet tx link only for a named renter.
    const renterNamed = s.named && (event.kind === 'renter_returned' || (event.kind === 'milestone' && event.grantId === undefined));
    if (renterNamed && 'leaseId' in event) {
      const newest = src.tickTxs.filter((t) => t.leaseId === event.leaseId).sort((a, b) => b.at - a.at)[0];
      if (newest) {
        const link = `https://basescan.org/tx/${newest.tx}`;
        txLinks.push(link);
        facts.push({ id: 'event:tx', text: `Latest payment on chain: ${link}` });
      }
    }
  }

  return { facts, txLinks, mentionable };
}

/** The offers the door lists, from the free GET route only. */
export async function fetchOffers(doorUrl: string, fetchFn: typeof fetch = fetch): Promise<OfferLite[]> {
  const res = await fetchFn(`${doorUrl.replace(/\/+$/, '')}/v1/offers`);
  if (!res.ok) throw new Error(`GET /v1/offers answered ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new Error('/v1/offers is not a list');
  const out: OfferLite[] = [];
  for (const o of body as Record<string, unknown>[]) {
    if (!o || typeof o.offerId !== 'string' || typeof o.tickPrice !== 'string' || typeof o.intervalSeconds !== 'number') continue;
    const lite: OfferLite = { offerId: o.offerId, tickPrice: o.tickPrice, intervalSeconds: o.intervalSeconds, images: Array.isArray(o.images) ? o.images.filter((i): i is string => typeof i === 'string') : [] };
    const h = o.home as Record<string, unknown> | undefined;
    if (h && typeof h.diskGiB === 'number' && typeof h.slots === 'number') {
      lite.home = { diskGiB: h.diskGiB, slots: h.slots, free: typeof h.free === 'number' ? h.free : 0, root: h.root === true };
    }
    out.push(lite);
  }
  return out;
}
