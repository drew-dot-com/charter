/** Parsing for the door's environment. See docs/env.md. */

/**
 * CHARTER_DOOR_TRUST_PROXY: Express `trust proxy` for a door behind a reverse proxy, so the rate limits
 * key on the client's address. `true` trusts every hop; a positive integer trusts that many (`1` for
 * one Caddy in front). Unset: the socket's address is the client's.
 */
export function parseTrustProxy(v: string | undefined): boolean | number | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'true') return true;
  if (/^[1-9]\d{0,2}$/.test(s)) return Number(s);
  throw new Error('CHARTER_DOOR_TRUST_PROXY must be true or a hop count (1 for one proxy in front)');
}

const PUBKEY = /^[0-9a-f]{64}$/;
const ILP_ADDRESS = /^g(\.[A-Za-z0-9_~-]+)+$/;

/**
 * CHARTER_DOOR_HOSTS: the hosts this door pays, as `<host pubkey>=<ilpBase>` pairs separated by commas.
 * An offer is listed and opened only when it is signed by one of these keys and names that key's ilpBase.
 */
export function parseDoorHosts(v: string | undefined): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const entry of (v ?? '').split(',').map((e) => e.trim()).filter(Boolean)) {
    const [pubkey, ilpBase, ...rest] = entry.split('=').map((x) => x.trim());
    if (rest.length > 0 || !pubkey || !PUBKEY.test(pubkey) || !ilpBase || !ILP_ADDRESS.test(ilpBase)) {
      throw new Error('CHARTER_DOOR_HOSTS entries must be <64 lowercase hex pubkey>=<ilp address>, comma separated');
    }
    if (hosts.has(pubkey)) throw new Error('CHARTER_DOOR_HOSTS names a host twice');
    hosts.set(pubkey, ilpBase);
  }
  if (hosts.size === 0) throw new Error('CHARTER_DOOR_HOSTS is required: the hosts this door pays, <pubkey>=<ilpBase>');
  return hosts;
}
