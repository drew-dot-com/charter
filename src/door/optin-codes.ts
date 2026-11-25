// Opt-in codes: how a renter or grantee agrees to be named by Charter's X account. The door shows a subject its
// code only where it already reads its own record; charter-social sees only a hash of each code the door served.
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The hashes of every code the door has served, one JSON line each. Lives beside the ledger file. */
export const OPTIN_CODES_FILE = 'optin-codes.jsonl';
export const OPTIN_PREFIX = 'charter-optin-';
/** The word a host posts before its host id. */
export const HOST_PREFIX = 'charter-host-';

export type OptinKind = 'lease' | 'grant';

/** An X handle without its '@': 1 to 15 letters, digits or underscores. */
export const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** A handle setting as typed (a leading '@' is dropped), or undefined when unset. Throws for anything else. */
export function parseXHandle(v: string | undefined, name: string): string | undefined {
  const s = v?.trim().replace(/^@+/, '');
  if (!s) return undefined;
  if (!X_HANDLE.test(s)) throw new Error(`${name} must be an X handle: 1 to 15 letters, digits or underscores`);
  return s;
}

/** The key codes are derived from: an HMAC of the door's payer key, so there is no second secret to keep. */
export function optinKey(payerKey: string): Buffer {
  return createHmac('sha256', Buffer.from(payerKey.replace(/^0x/, ''), 'hex')).update('charter social opt-in v1').digest();
}

/** The subject's code: the prefix and 32 hex characters (128 bits). The same on every call. */
export function optinCodeOf(key: Buffer, kind: OptinKind, id: string): string {
  return OPTIN_PREFIX + createHmac('sha256', key).update(`${kind}:${id}`).digest().subarray(0, 16).toString('hex');
}

/** sha256 hex of a code, lower case first: what charter-social compares a posted code with. */
export function optinHash(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase(), 'utf8').digest('hex');
}

/** Serves codes and keeps the hash file. One per door process. */
export class OptinCodes {
  private readonly served = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly key: Buffer,
  ) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`charter-door opt-in codes: ${file} does not read: ${(e as Error).message}`);
    }
    for (const line of text.split('\n')) {
      try {
        const r = JSON.parse(line) as { kind?: unknown; id?: unknown };
        if (typeof r.kind === 'string' && typeof r.id === 'string') this.served.add(`${r.kind}:${r.id}`);
      } catch {
        // a blank or torn line
      }
    }
  }

  /** The code, and its hash appended to the file the first time. A failed append is logged, never thrown. */
  codeFor(kind: OptinKind, id: string): string {
    const code = optinCodeOf(this.key, kind, id);
    const k = `${kind}:${id}`;
    if (!this.served.has(k)) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, JSON.stringify({ kind, id, hash: optinHash(code) }) + '\n');
        this.served.add(k);
      } catch (e) {
        console.error(`charter-door opt-in codes: append failed: ${(e as Error).message}`);
      }
    }
    return code;
  }
}

export interface SocialOptin {
  /** Charter's X handle, no '@'. */
  handle: string;
  codes: OptinCodes;
}

/** What an owner's read of a lease or grant carries under `social`. */
export function socialView(s: SocialOptin, kind: OptinKind, id: string): { optinCode: string; post: string; how: string } {
  const optinCode = s.codes.codeFor(kind, id);
  const post = `@${s.handle} ${optinCode}`;
  return {
    optinCode,
    post,
    how: `Optional. Charter's X account @${s.handle} names nobody who has not asked. To be named by your X handle in its posts, post the text in "post" from your X account. To undo it, post the same text with the word stop. The code is secret until you post it, and it locks to the first account that posts it.`,
  };
}
