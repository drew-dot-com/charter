import { createHash } from 'node:crypto';
import express from 'express';
import { verifyMessage, type LocalAccount } from 'viem';

export const DOOR_SIG_HEADER = 'x-charter-door-sig';
export const DOOR_TS_HEADER = 'x-charter-door-ts';
export const DOOR_AUTH_WINDOW_MS = 60_000;

function normOrigin(x: string): string {
  try { return new URL(x).origin; } catch { return x; }
}

export function doorAuthMessage(origin: string, method: string, path: string, body: string, ts: number): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return `charter-door-v1\n${normOrigin(origin)}\n${method.toUpperCase()}\n${path}\n${digest}\n${ts}`;
}

export async function signDoorRequest(
  account: LocalAccount, origin: string, method: string, path: string, body: string, now: number,
): Promise<Record<string, string>> {
  const signature = await account.signMessage({ message: doorAuthMessage(origin, method, path, body, now) });
  return { [DOOR_SIG_HEADER]: signature, [DOOR_TS_HEADER]: String(now) };
}

export async function verifyDoorRequest(o: {
  headers: Record<string, string | undefined>; origin: string; method: string; path: string; body: string;
  door: `0x${string}`; now: number;
}): Promise<boolean> {
  const sig = o.headers[DOOR_SIG_HEADER];
  const tsRaw = o.headers[DOOR_TS_HEADER];
  if (!sig || !tsRaw || !/^\d+$/.test(tsRaw)) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts) || Math.abs(o.now - ts) > DOOR_AUTH_WINDOW_MS) return false;
  try {
    return await verifyMessage({
      address: o.door, message: doorAuthMessage(o.origin, o.method, o.path, o.body, ts), signature: sig as `0x${string}`,
    });
  } catch {
    return false;
  }
}

export const rawJson = express.json({
  verify: (req, _res, buf) => { (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8'); },
});

export function requireDoor(
  door: () => `0x${string}` | undefined, origin: () => string, now: () => number = Date.now,
): express.RequestHandler {
  return async (req, res, next) => {
    const d = door();
    const headers: Record<string, string | undefined> = {};
    for (const k of [DOOR_SIG_HEADER, DOOR_TS_HEADER]) {
      const v = req.headers[k];
      headers[k] = Array.isArray(v) ? v[0] : v;
    }
    const ok = d !== undefined && await verifyDoorRequest({
      headers, origin: origin(), method: req.method, path: req.originalUrl,
      body: (req as unknown as { rawBody?: string }).rawBody ?? '', door: d, now: now(),
    });
    if (!ok) { res.status(401).json({ error: 'not_door' }); return; }
    next();
  };
}
