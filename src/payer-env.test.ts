import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { toonClientConfigFromEnv } from './payer-env.js';

const ENV = {
  CHARTER_TOON_CONNECTOR_URL: 'https://connector.example',
  CHARTER_TOON_KEY_FILE: '/run/secrets/key',
  CHARTER_TOON_CHANNEL_STORE: '/data/channels.json',
  CHARTER_TOON_CHAIN: 'solana',
};

test('toonClientConfigFromEnv needs the four variables and reads the RPC URL from a file', () => {
  assert.deepEqual(toonClientConfigFromEnv(ENV), {
    connectorUrl: 'https://connector.example',
    keyFile: '/run/secrets/key',
    channelStore: '/data/channels.json',
    chain: 'solana',
  });
  for (const name of Object.keys(ENV)) {
    assert.throws(() => toonClientConfigFromEnv({ ...ENV, [name]: undefined }), new RegExp(`${name} is required`), name);
  }
  assert.throws(() => toonClientConfigFromEnv({ ...ENV, CHARTER_TOON_CHAIN: 'btc' }), /CHARTER_TOON_CHAIN must be evm or solana/);

  const dir = mkdtempSync(join(tmpdir(), 'charter-payer-env-'));
  const rpc = join(dir, 'rpc');
  writeFileSync(rpc, 'https://rpc.example\n');
  assert.equal(toonClientConfigFromEnv({ ...ENV, CHARTER_TOON_RPC_URL_FILE: rpc }).rpcUrl, 'https://rpc.example');
  writeFileSync(rpc, 'http://rpc.example\n');
  assert.throws(() => toonClientConfigFromEnv({ ...ENV, CHARTER_TOON_RPC_URL_FILE: rpc }), /CHARTER_TOON_RPC_URL_FILE must hold one https:\/\/ URL/);
});

test('payerAddress derives the EVM address from the key file and nothing for solana or a bad file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { payerAddress } = await import('./payer-env.js');
  const dir = mkdtempSync(join(tmpdir(), 'charter-addr-'));
  const key = join(dir, 'k');
  // The well-known Hardhat account 0 key, not a real wallet.
  writeFileSync(key, 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80\n');
  const base = { connectorUrl: 'https://c', keyFile: key, channelStore: join(dir, 's.json') } as const;
  assert.equal(payerAddress({ ...base, chain: 'evm' }), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(payerAddress({ ...base, chain: 'solana' }), undefined);
  writeFileSync(key, 'nope');
  assert.equal(payerAddress({ ...base, chain: 'evm' }), undefined);
});
