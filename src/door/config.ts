/** Parsing for the door's environment. See docs/env.md. */
import { privateKeyToAccount } from 'viem/accounts';
import type { AuthorizerSigner } from '@x402/evm/batch-settlement/server';

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

const CLAIM_KEY = /^0x[0-9a-f]{64}$/i;

/**
 * CHARTER_CLAIM_KEY_FILE: one 0x-prefixed 64-hex secp256k1 private key, the door's x402 claim authorizer.
 * It signs claim batches and refunds for the payee and holds no funds. The message never carries key bytes.
 */
export function parseClaimKey(fileText: string): `0x${string}` {
  const s = fileText.trim();
  if (!CLAIM_KEY.test(s) || s.includes('\n')) throw new Error('CHARTER_CLAIM_KEY_FILE must hold one 0x-prefixed 64-hex private key');
  return s as `0x${string}`;
}

/** The claim key as the x402 batch-settlement server's receiver authorizer: an address and a typed-data signer. */
export function claimSigner(key: `0x${string}`): AuthorizerSigner {
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    signTypedData: (params) => account.signTypedData(params as unknown as Parameters<typeof account.signTypedData>[0]),
  };
}
