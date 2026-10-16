// SSRF guard for the fetch job: decides whether a request may leave the container.
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const BLOCKED_HOSTS = new Set(['localhost', 'host.docker.internal', 'gateway.docker.internal']);

function v4ToInt(a) {
  const p = a.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// [network, prefix length]
const V4_BLOCKED = [
  ['0.0.0.0', 8], // unspecified / "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
].map(([net, bits]) => [v4ToInt(net), bits]);

function v4Blocked(addr) {
  const n = v4ToInt(addr);
  return V4_BLOCKED.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((net & mask) >>> 0);
  });
}

/** Expand an IPv6 literal to 8 16-bit groups, or null if malformed. */
function v6Groups(addr) {
  let a = addr.split('%')[0];
  const dotted = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4ToInt(dotted[2]);
    a = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

function v6Blocked(addr) {
  const g = v6Groups(addr);
  if (!g) return true; // cannot parse: refuse
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::/96)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Blocked(embeddedV4());
  if (g.slice(0, 6).every((x) => x === 0)) return v4Blocked(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embeddedV4());
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when an IP literal is loopback, private, link-local, CGNAT, ULA, unspecified, multicast or reserved. */
export function isBlockedAddress(addr) {
  const v = isIP(addr);
  if (v === 4) return v4Blocked(addr);
  if (v === 6) return v6Blocked(addr);
  return true; // not an IP: refuse
}

/** URL.hostname form: lowercase, no brackets, no trailing dot. */
function cleanHost(h) {
  return h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isBlockedHostname(host) {
  const h = cleanHost(host);
  return BLOCKED_HOSTS.has(h) || h.endsWith('.localhost');
}

/**
 * Decide whether `url` may be requested. Returns { ok: true } or { ok: false, host, reason }.
 * Resolves every address of a hostname and blocks if any is blocked.
 * `lookupFailure` says what to do when DNS fails locally: 'block' (default), or 'allow'
 * when a proxy resolves names itself (for example onion addresses).
 */
export async function checkUrl(url, { lookup = dnsLookup, lookupFailure = 'block' } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, host: url, reason: 'bad url' };
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return { ok: true };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, host: u.protocol, reason: 'scheme' };
  }
  const host = cleanHost(u.hostname);
  if (isBlockedHostname(host)) return { ok: false, host, reason: 'blocked name' };
  if (isIP(host)) {
    return isBlockedAddress(host) ? { ok: false, host, reason: 'blocked address' } : { ok: true };
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return lookupFailure === 'allow' ? { ok: true } : { ok: false, host, reason: 'lookup failed' };
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
    return { ok: false, host, reason: 'blocked address' };
  }
  return { ok: true };
}
