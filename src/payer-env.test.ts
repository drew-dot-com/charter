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
