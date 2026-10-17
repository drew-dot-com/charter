import type { JobSpec } from './types.js';

/** Fetches up to five pages through the host's proxy and returns a screenshot and the text of each. */
export const FETCH_IMAGE = 'charter-job-fetch';
/** Runs the renter's own Python script with no network and returns its stdout, stderr and exit code. */
export const PYTHON_IMAGE = 'charter-job-python';
/** Every job a renter can ask for. */
export const JOB_IMAGES = [FETCH_IMAGE, PYTHON_IMAGE];

export const MAX_URLS = 5;
/** Largest script the python job takes. Keeps the open packet well under ILP's 32 KiB data limit once sealed. */
export const MAX_SCRIPT_BYTES = 8 * 1024;

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

/**
 * The job a renter's request body asks for: `{ urls: string[] }` for a fetch, `{ python: { script } }` for a
 * script. Exactly one of the two. Null when neither is well formed.
 */
export function jobFromBody(body: { urls?: unknown; python?: unknown }): JobSpec | null {
  const { urls, python } = body;
  if (urls !== undefined && python !== undefined) return null;
  if (urls !== undefined) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > MAX_URLS || !urls.every(isUrl)) return null;
    return fetchJob(urls);
  }
  if (typeof python !== 'object' || python === null || Array.isArray(python)) return null;
  const { script } = python as { script?: unknown };
  return isScript(script) ? pythonJob(script) : null;
}
