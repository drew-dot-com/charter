#!/usr/bin/env node
// Makes the door's Solana TOON payer key: a JSON array of the 64 secret key
// bytes, written mode 400 to the path given. Prints only the public address,
// which is what Drew funds. Refuses to overwrite.
//   node deploy/door/new-payer-key.mjs /root/charter-door/secrets/toon-payer.json
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: new-payer-key.mjs <out file>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} exists; not overwriting a key that may hold funds`);
  process.exit(1);
}
const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
const seed = Buffer.from(jwk.d, 'base64url');
const pub = Buffer.from(jwk.x, 'base64url');
writeFileSync(out, JSON.stringify([...seed, ...pub]), { mode: 0o400, flag: 'wx' });

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
console.log(base58(pub));
