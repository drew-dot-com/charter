import express from 'express';
import { rawJson, requireDoor } from '../door-auth.js';
import type { Gate } from '../x402/seller.js';
import { finish, leaseOf, openHandler, outputHandler, statusHandler, tickHandler, type HostDeps } from './server.js';

export interface HostHttpDeps extends HostDeps {
  /** The door's address: the only caller a host answers on its lease routes. */
  door: () => `0x${string}` | undefined;
  /** This host's own URL origin, as the door signs it. */
  origin: () => string;
  /** The paid tick's x402 gate (hostTickGate, or a stub in tests). */
  tickGate: Gate;
  /** What `GET /v1/offer` answers. */
  offerJson: () => unknown;
}

/**
 * The host over HTTPS. The offer and health are free and open; every lease route needs the door's signature,
 * and a tick is paid through `tickGate`. Answer bodies are those of the TOON apps (`hostApps`).
 */
export function hostHttpApp(deps: HostHttpDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // rawJson is the only body parser: the door signature covers the raw body, which it records.
  const door = [rawJson, requireDoor(deps.door, deps.origin, deps.now)];

  app.get('/v1/offer', (_req, res) => void res.json(deps.offerJson()));
  app.get('/v1/health', (_req, res) => void res.json({ ok: true }));

  app.post('/v1/leases', ...door, openHandler(deps));
  app.get('/v1/leases/:id', ...door, statusHandler(deps));
  app.get('/v1/leases/:id/output/:part', ...door, outputHandler(deps));
  // An unknown lease is refused before the gate, so it never asks for payment.
  const known: express.RequestHandler = (req, res, next) => {
    if (!leaseOf(deps, req)) return void res.status(404).json({ error: 'not_found' });
    next();
  };
  app.post('/v1/leases/:id/ticks', ...door, known, deps.tickGate, tickHandler(deps));

  return finish(app);
}
