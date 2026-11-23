// Anyone may register a host: `POST /v1/hosts`, and see every host the door knows: `GET /v1/hosts`. Both free.
import express from 'express';
import type { Micro } from '../types.js';
import { checkHostOffer } from './host-offers.js';
import { normalizeHostUrl, publicRecord, type HostRegistry } from './hosts.js';
import { slidingLimit } from './limit.js';
import { SafeFetchError } from './safe-fetch.js';

const HOUR_MS = 3_600_000;
/** Registrations one IP may try in an hour. */
export const REGISTERS_PER_IP_HOUR = 10;
/** Registrations of one host URL in an hour: each rewrites the registry file. */
export const REGISTERS_PER_URL_HOUR = 1;

/**
 * `POST /v1/hosts { url }`: the door fetches `GET {url}/v1/offer` through `fetch` (safeFetch in production) and
 * registers the host for a probe when the offer is one it would list. Answers `202 { hostId, state }`; `400
 * bad_url` for a URL the door will not take or fetch; `400 { error: 'bad_offer', reason }`; `429 rate_limited`.
 * `GET /v1/hosts`: every host not dropped, with its record.
 */
export function hostRoutes(d: {
  registry: HostRegistry;
  fetch: typeof fetch;
  now: () => number;
  /** The most a host's tick may cost, in micro-USDC. */
  maxTickPrice: Micro;
  waiting: (hostId: string) => boolean;
}): express.Router {
  const router = express.Router();
  const allowIp = slidingLimit(d.now, REGISTERS_PER_IP_HOUR, HOUR_MS);
  const allowUrl = slidingLimit(d.now, REGISTERS_PER_URL_HOUR, HOUR_MS);

  router.post('/v1/hosts', async (req, res) => {
    if (!allowIp(req.ip ?? 'unknown')) return void res.status(429).json({ error: 'rate_limited' });
    const raw = (req.body as { url?: unknown } | undefined)?.url;
    const url = typeof raw === 'string' ? normalizeHostUrl(raw) : null;
    if (url === null) return void res.status(400).json({ error: 'bad_url' });
    if (!allowUrl(url)) return void res.status(429).json({ error: 'rate_limited' });
    let checked: Awaited<ReturnType<typeof checkHostOffer>>;
    try {
      checked = await checkHostOffer(url, d.fetch);
    } catch (e) {
      // Resolving inward (or redirecting) is the URL's fault; anything else is a host that did not answer.
      if (e instanceof SafeFetchError && (e.code === 'bad_url' || e.code === 'redirect')) return void res.status(400).json({ error: 'bad_url' });
      return void res.status(400).json({ error: 'bad_offer', reason: 'unreachable' });
    }
    if ('refused' in checked) return void res.status(400).json({ error: 'bad_offer', reason: checked.refused });
    if (checked.tickPrice > d.maxTickPrice) return void res.status(400).json({ error: 'bad_offer', reason: 'tick_price' });
    const r = d.registry.register(url, d.now());
    if (r === 'bad_url') return void res.status(400).json({ error: 'bad_url' });
    d.registry.setOffer(r.hostId, checked, d.now());
    res.status(202).json(r);
  });

  router.get('/v1/hosts', (_req, res) => {
    res.json(
      d.registry
        .all()
        .filter((r) => r.state !== 'dropped')
        .sort((a, b) => a.registeredAt - b.registeredAt || (a.hostId < b.hostId ? -1 : 1))
        .map((r) => ({ hostId: r.hostId, url: r.url, state: r.state, record: publicRecord(r, d.waiting(r.hostId)) })),
    );
  });

  return router;
}
