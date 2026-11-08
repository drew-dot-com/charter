import { appendFileSync, renameSync, statSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

/**
 * One line per request, so the operator can see whether an index or an agent ever reaches the door.
 * Deliberately not here: the client IP, the query string, the body, and every header but the user agent
 * and the referrer's host.
 */
export interface RequestEntry {
  /** ISO time the response finished. */
  t: string;
  m: string;
  /** Path only, cut to MAX_PATH. */
  p: string;
  s: number;
  ms: number;
  /** The User-Agent, cut to MAX_UA. Absent when the client sent none. */
  ua?: string;
  /** The Referer's host, never its path. Absent when there is none or it does not parse. */
  ref?: string;
  /** The request carried an x402 payment header (valid or not). */
  paid: boolean;
}

export type RequestSink = (e: RequestEntry) => void;

export const MAX_PATH = 200;
export const MAX_UA = 200;
/** Where the file rolls to `<file>.1`, so the log holds at most twice this. */
export const REQUEST_LOG_MAX_BYTES = 5 * 1024 * 1024;

function refererHost(h: string | undefined): string | undefined {
  if (!h) return undefined;
  try {
    return new URL(h).host || undefined;
  } catch {
    return undefined;
  }
}

/** Express middleware: hands `sink` one entry when each response finishes. A failing sink never touches the request. */
export function logRequests(sink: RequestSink, now: () => number = Date.now) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = now();
    // `req.path` is rewritten inside a mounted router, so it is read here, before any route runs.
    const p = req.path.slice(0, MAX_PATH);
    res.once('finish', () => {
      const end = now();
      const ua = req.get('user-agent')?.slice(0, MAX_UA);
      const ref = refererHost(req.get('referer'));
      const paid = req.headers['payment-signature'] !== undefined || req.headers['x-payment'] !== undefined;
      try {
        sink({ t: new Date(end).toISOString(), m: req.method, p, s: res.statusCode, ms: end - start, ...(ua ? { ua } : {}), ...(ref ? { ref } : {}), paid });
      } catch {
        // The log is for the operator's curiosity; a request never pays for it.
      }
    });
    next();
  };
}

/** A sink appending JSON lines to `file`, rolling it to `<file>.1` past `maxBytes`. */
export function fileRequestSink(file: string, maxBytes: number = REQUEST_LOG_MAX_BYTES): RequestSink {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // No log yet.
  }
  return (e) => {
    const line = `${JSON.stringify(e)}\n`;
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      renameSync(file, `${file}.1`);
      size = 0;
    }
    appendFileSync(file, line, { mode: 0o600 });
    size += bytes;
  };
}
