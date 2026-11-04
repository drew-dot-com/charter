import { createHash } from 'node:crypto';
import type { JobSpec } from './types.js';

/** Fetches up to five pages through the host's proxy and returns a screenshot and the text of each. */
export const FETCH_IMAGE = 'charter-job-fetch';
/** Runs the renter's own Python script with no network and returns its stdout, stderr and exit code. */
export const PYTHON_IMAGE = 'charter-job-python';
/** A box the renter logs into over SSH; its only argument is the set of public keys that may. */
export const HOME_IMAGE = 'charter-home';
/** Every job a renter can ask for. */
export const JOB_IMAGES = [FETCH_IMAGE, PYTHON_IMAGE, HOME_IMAGE];

export const MAX_URLS = 5;
/** Largest script the python job takes. Keeps the open packet well under ILP's 32 KiB data limit once sealed. */
export const MAX_SCRIPT_BYTES = 8 * 1024;

export const MAX_SSH_KEYS = 8;
/** Longest single key line. Fits a 4096-bit RSA key and keeps the sealed packet small. */
export const MAX_SSH_KEY_BYTES = 1024;

// The key types a home takes; ssh-dss is long dead and security-key types are not supported.
const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [\x20-\x7e]*)?$/;

/**
 * The key set a home is for: `v` must be an array of 1 to MAX_SSH_KEYS authorized_keys lines. Each is cut to
 * `<type> <base64>` (the comment is dropped), then sorted and de-duplicated, so the same keys always give the
 * same set. Null when any line is not a key, or the count is out of range.
 */
export function normalizeSshKeys(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SSH_KEYS) return null;
  const keys = new Set<string>();
  for (const line of v) {
    if (typeof line !== 'string') return null;
    const t = line.trim();
    if (Buffer.byteLength(t, 'utf8') > MAX_SSH_KEY_BYTES) return null;
    const m = SSH_KEY.exec(t);
    if (!m) return null;
    keys.add(`${m[1]} ${m[2]}`);
  }
  return [...keys].sort();
}

/** A home's identity: the first 16 hex of the SHA-256 of its normalized key set. */
export function homeIdOf(normalized: string[]): string {
  return createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 16);
}

function isUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2000 || v.includes(',')) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A script the python job will take: non-blank, no NUL, at most MAX_SCRIPT_BYTES of UTF-8. */
export function isScript(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && !v.includes('\0') && Buffer.byteLength(v, 'utf8') <= MAX_SCRIPT_BYTES;
}

export function fetchJob(urls: string[]): JobSpec {
  return { image: FETCH_IMAGE, args: { URLS: urls.join(',') } };
}

export function pythonJob(script: string): JobSpec {
  return { image: PYTHON_IMAGE, args: { SCRIPT: script } };
}

export function homeJob(normalized: string[]): JobSpec {
  return { image: HOME_IMAGE, args: { SSH_KEYS: normalized.join('\n') } };
}

/**
 * The job a renter's request body asks for: `{ urls: string[] }` for a fetch, `{ python: { script } }` for a
 * script, `{ home: { sshKeys: string[] } }` for a home. Exactly one of the three. Null when none is well formed.
 */
export function jobFromBody(body: { urls?: unknown; python?: unknown; home?: unknown }): JobSpec | null {
  const { urls, python, home } = body;
  if ([urls, python, home].filter((x) => x !== undefined).length > 1) return null;
  if (home !== undefined) {
    if (typeof home !== 'object' || home === null || Array.isArray(home)) return null;
    const keys = normalizeSshKeys((home as { sshKeys?: unknown }).sshKeys);
    return keys ? homeJob(keys) : null;
  }
  if (urls !== undefined) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS || !urls.every(isUrl)) return null;
    return fetchJob(urls);
  }
  if (typeof python !== 'object' || python === null || Array.isArray(python)) return null;
  const { script } = python as { script?: unknown };
  return isScript(script) ? pythonJob(script) : null;
}
