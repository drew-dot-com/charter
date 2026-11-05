import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { ToonClientPayerConfig } from './payer.js';

/** The trimmed value of `name`, which must be set and not blank. */
export function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** A library TOON payer's config from CHARTER_TOON_* variables: the door's wallet, or a tenant's inside a box. */
export function toonClientConfigFromEnv(env: Record<string, string | undefined>): ToonClientPayerConfig {
  const chain = need(env, 'CHARTER_TOON_CHAIN');
  if (chain !== 'evm' && chain !== 'solana') throw new Error('CHARTER_TOON_CHAIN must be evm or solana');
  // The key stays in the file the env names. A bad key file fails with KeyFileError's fixed message;
  // other startup errors carry no key material and print as they are.
  const cfg: ToonClientPayerConfig = {
    connectorUrl: need(env, 'CHARTER_TOON_CONNECTOR_URL'),
    keyFile: need(env, 'CHARTER_TOON_KEY_FILE'),
    channelStore: need(env, 'CHARTER_TOON_CHANNEL_STORE'),
    chain,
  };
  // The RPC URL may carry an API key, so it comes from a file like the other secrets.
  const rpcFile = env.CHARTER_TOON_RPC_URL_FILE?.trim();
  if (rpcFile) {
    const rpcUrl = readFileSync(rpcFile, 'utf8').trim();
    if (!/^https:\/\/\S+$/.test(rpcUrl)) throw new Error('CHARTER_TOON_RPC_URL_FILE must hold one https:// URL');
    cfg.rpcUrl = rpcUrl;
  }
  return cfg;
}

/**
 * The payer's own address, for `/health` and balance reads: derived from the key file for an EVM payer, undefined
 * for Solana (the client derives that one itself and this module does not need to). Never returns the key.
 */
export function payerAddress(cfg: ToonClientPayerConfig): string | undefined {
  if (cfg.chain !== 'evm') return undefined;
  const raw = readFileSync(cfg.keyFile, 'utf8').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return undefined;
  return privateKeyToAccount((raw.startsWith('0x') ? raw : '0x' + raw) as `0x${string}`).address;
}
