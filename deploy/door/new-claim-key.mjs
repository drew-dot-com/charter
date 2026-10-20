#!/usr/bin/env node
// Makes the door's x402 claim key: a secp256k1 private key as 0x + 64 hex, written
// mode 400 to the path given. It signs claim batches and refunds for CHARTER_PAY_TO
// and never holds funds. Prints only the address. Refuses to overwrite.
//   node deploy/door/new-claim-key.mjs /root/charter-door/secrets/claim-key
import { existsSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const out = process.argv[2];
if (!out) {
  console.error('usage: new-claim-key.mjs <out file>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} exists; not overwriting`);
  process.exit(1);
}
const key = generatePrivateKey();
writeFileSync(out, `${key}\n`, { mode: 0o400, flag: 'wx' });
console.log(privateKeyToAccount(key).address);
