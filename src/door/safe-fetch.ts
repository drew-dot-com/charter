// Fetching a URL a stranger registered, from a box that also reaches private networks.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const SAFE_FETCH_MAX_BYTES = 65_536;
export const SAFE_FETCH_TIMEOUT_MS = 10_000;

/**
 * bad_url: not https, carries userinfo, does not resolve, or resolves to an address that is not public.
 * redirect: the answer was a redirect; none is followed. too_large: the body passed `maxBytes`.
 * timeout: no full answer within `timeoutMs`.
 */
export type SafeFetchCode = 'bad_url' | 'redirect' | 'too_large' | 'timeout';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SafeFetchError';
  }
}

/** Addresses no registered host may resolve to: loopback, private, link-local, CGNAT, reserved, multicast. */
const INWARD = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) INWARD.addSubnet(net, bits, 'ipv4');
// BlockList also matches an IPv4 rule against its IPv4-mapped IPv6 form (::ffff:a.b.c.d). The IPv6 forms
// that carry an IPv4 address some other way (compatible, translated, NAT64, 6to4, Teredo) are refused whole.
for (const [net, bits] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) INWARD.addSubnet(net, bits, 'ipv6');

/** True for an address the door must not connect to, and for anything that is not an IP address. */
export function blockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  try {
    return INWARD.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  } catch {
    return true;
  }
}

export interface SafeFetchInit extends RequestInit {
  /** Body bytes read before the answer is refused as too_large. Default SAFE_FETCH_MAX_BYTES. */
  maxBytes?: number;
  /** The whole call, body included. Default SAFE_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface SafeFetchDeps {
  /** Every address of a hostname. Default: the system resolver, all families. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Tests only: which resolved addresses are refused. Default blockedAddress. */
  blocked?: (ip: string) => boolean;
  /** Tests only: let `http:` through. */
  allowHttp?: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

async function systemResolve(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
}

function parse(href: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new SafeFetchError('bad_url', 'not a url');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new SafeFetchError('bad_url', 'not https');
  if (url.username || url.password) throw new SafeFetchError('bad_url', 'userinfo');
  return url;
}

/**
 * `fetch` for URLs strangers control. The hostname is resolved once and every address checked
 * (blockedAddress); the connection then goes to those checked addresses only, with the hostname kept for
 * the Host header and TLS, so a second DNS answer can never point it inward. A redirect is refused, not
 * followed. The body is cut off once it passes `maxBytes`, as it streams. Takes a Request too, as the
 * x402 fetch wrapper sends one.
 */
export async function safeFetch(input: string | URL | Request, init: SafeFetchInit = {}, deps: SafeFetchDeps = {}): Promise<Response> {
  const { maxBytes = SAFE_FETCH_MAX_BYTES, timeoutMs = SAFE_FETCH_TIMEOUT_MS, ...rest } = init;
  const url = parse(input instanceof Request ? input.url : String(input), deps.allowHttp ?? false);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const blocked = deps.blocked ?? blockedAddress;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await (deps.resolve ?? systemResolve)(host);
    } catch {
      throw new SafeFetchError('bad_url', 'does not resolve');
    }
  }
  if (addrs.length === 0 || addrs.some((a) => blocked(a))) throw new SafeFetchError('bad_url', 'resolves inward');

  const req = new Request(input, rest);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
  const timer = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([req.signal, timer]);
  const why = (): unknown => (req.signal.aborted ? req.signal.reason : new SafeFetchError('timeout'));
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => void (headers[k] = v));
  delete headers.host;
  if (body) headers['content-length'] = String(body.length);
  // Hands the connection only the addresses checked above, whatever it asks for.
  const lookup = ((_name: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    const all = addrs.map((address) => ({ address, family: isIP(address) }));
    if (opts.all) cb(null, all);
    else cb(null, all[0]!.address, all[0]!.family);
  }) as unknown as LookupFunction;

  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) return reject(why());
    let res: IncomingMessage | undefined;
    const r = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: req.method,
      headers,
      lookup,
      agent: false,
      ...(url.protocol === 'https:' && !isIP(host) ? { servername: host } : {}),
    });
    const onAbort = (): void => {
      const e = why();
      if (res) res.destroy(e as Error);
      else r.destroy(e as Error);
      reject(e);
    };
    const done = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    r.on('error', (e) => {
      done();
      reject(signal.aborted ? why() : e);
    });
    r.on('response', (m) => {
      res = m;
      const status = m.statusCode ?? 0;
      const refuse = (e: Error): void => {
        done();
        m.destroy();
        reject(e);
      };
      if (REDIRECTS.has(status)) return refuse(new SafeFetchError('redirect', `${status} to ${m.headers.location ?? '(none)'}`));
      const declared = Number(m.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) return refuse(new SafeFetchError('too_large', `${declared} bytes declared`));
      try {
        const h = new Headers();
        for (let i = 0; i + 1 < m.rawHeaders.length; i += 2) h.append(m.rawHeaders[i]!, m.rawHeaders[i + 1]!);
        if (NULL_BODY.has(status)) {
          m.resume();
          m.on('end', done);
          return resolve(new Response(null, { status, statusText: m.statusMessage, headers: h }));
        }
        resolve(new Response(capped(m, maxBytes, done, () => (signal.aborted ? why() : undefined)), { status, statusText: m.statusMessage, headers: h }));
      } catch (e) {
        refuse(e as Error);
      }
    });
    r.end(body);
  });
}

/** The body as a stream that errors with too_large, and drops the connection, once it passes `maxBytes`. */
function capped(m: IncomingMessage, maxBytes: number, done: () => void, aborted: () => unknown): ReadableStream<Uint8Array> {
  let seen = 0;
  let over = false;
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      const fail = (e: unknown): void => {
        if (over) return;
        over = true;
        done();
        ctrl.error(e);
      };
      m.on('data', (c: Buffer) => {
        if (over) return;
        seen += c.length;
        if (seen > maxBytes) {
          fail(new SafeFetchError('too_large', `over ${maxBytes} bytes`));
          m.destroy();
          return;
        }
        ctrl.enqueue(new Uint8Array(c));
      });
      m.on('end', () => {
        if (over) return;
        over = true;
        done();
        ctrl.close();
      });
      m.on('error', (e) => fail(aborted() ?? e));
      m.on('close', () => fail(aborted() ?? new Error('connection closed before the body ended')));
    },
    cancel() {
      over = true;
      done();
      m.destroy();
    },
  });
}
