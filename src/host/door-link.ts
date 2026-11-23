// The host's link to its door: who the door is (its payer address), and registering with it.

/** How often the host reads the door's address again. */
export const DOOR_READ_EVERY_MS = 10 * 60_000;
/** A registration the door did not accept is tried again after this long. */
export const REGISTER_RETRY_MS = 60_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The door's payer address, from `GET {doorUrl}/v1/door` field `payer`: the only caller the host answers.
 * Read by `refresh` and every DOOR_READ_EVERY_MS once started; a failed or malformed read keeps the last one.
 */
export function doorWatch(o: { doorUrl: string; fetch?: typeof fetch; log: (m: string) => void }): {
  door: () => `0x${string}` | undefined;
  refresh: () => Promise<void>;
  start: () => void;
  stop: () => void;
} {
  const f = o.fetch ?? fetch;
  let door: `0x${string}` | undefined;
  let timer: NodeJS.Timeout | undefined;
  const refresh = async (): Promise<void> => {
    try {
      const res = await f(`${o.doorUrl}/v1/door`, { headers: { accept: 'application/json' } });
      const body = (await res.json().catch(() => null)) as { payer?: unknown } | null;
      if (!res.ok || typeof body?.payer !== 'string' || !ADDRESS.test(body.payer)) {
        o.log(`door ${o.doorUrl} gave no payer address (status ${res.status}); keeping ${door ?? 'none'}`);
        return;
      }
      if (body.payer.toLowerCase() !== door?.toLowerCase()) o.log(`door payer is ${body.payer}`);
      door = body.payer as `0x${string}`;
    } catch (e) {
      o.log(`door ${o.doorUrl} unreachable: ${String(e instanceof Error ? e.message : e).slice(0, 160)}; keeping ${door ?? 'none'}`);
    }
  };
  return {
    door: () => door,
    refresh,
    start: () => {
      timer ??= setInterval(() => void refresh(), DOOR_READ_EVERY_MS);
      timer.unref();
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Registers the host with its door: `POST {doorUrl}/v1/hosts {url}`, tried again every REGISTER_RETRY_MS
 * until the door answers 202. `register()` tries at once (on boot, and when the offer changes), replacing a
 * retry that was waiting; it resolves true on a 202.
 */
export function hostRegistrar(o: {
  doorUrl: string;
  hostUrl: string;
  fetch?: typeof fetch;
  log: (m: string) => void;
  /** Runs `fn` after `ms`; returns a cancel. Default setTimeout (unref'd). */
  schedule?: (fn: () => void, ms: number) => () => void;
}): { register: () => Promise<boolean>; stop: () => void } {
  const f = o.fetch ?? fetch;
  const schedule =
    o.schedule ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return () => clearTimeout(t);
    });
  let cancel: (() => void) | undefined;
  let stopped = false;
  const register = async (): Promise<boolean> => {
    cancel?.();
    cancel = undefined;
    let status = 0;
    try {
      const res = await f(`${o.doorUrl}/v1/hosts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: o.hostUrl }),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      o.log(`register with ${o.doorUrl} failed: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
    if (status === 202) return true;
    if (status !== 0) o.log(`register with ${o.doorUrl} answered ${status}; trying again in ${REGISTER_RETRY_MS / 1000} s`);
    if (!stopped) cancel = schedule(() => void register(), REGISTER_RETRY_MS);
    return false;
  };
  return {
    register,
    stop: () => {
      stopped = true;
      cancel?.();
    },
  };
}
