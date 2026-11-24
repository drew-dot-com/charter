#!/usr/bin/env node
// Makes the allowance biller's Base wallet key: 0x and 64 hex, written mode 400 to the path given. Prints only the
// public address, which is what Drew allows with USDC on Base. Refuses to overwrite.
//   node deploy/allow/new-allow-key.mjs /root/charter-allow/secrets/allow-key
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const out = process.argv[2];
if (!out) {
  console.error('usage: new-allow-key.mjs <out file>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} exists; not overwriting a key that may hold allows`);
  process.exit(1);
}
const key = `0x${randomBytes(32).toString('hex')}`;
writeFileSync(out, key, { mode: 0o400, flag: 'wx' });
console.log(privateKeyToAccount(key).address);
