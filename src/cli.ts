#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HomeAccess, Lease, Micro } from './types.js';
import type { LeaseEvent, RunLeaseResult } from './tenant/run-lease.js';

/** What rent, renew, status and offers say until they pay through the door. */
export const MOVED = 'this command moves to the door in the next release';

const USAGE = `usage:
  charter offers | rent | renew | status
${MOVED}`;

export interface CliDeps {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultDeps: CliDeps = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

/** 1000000n -> "1", 5000n -> "0.005". */
export function formatUsdc(n: Micro): string {
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const ONION = /^[a-z2-7]{56}\.anyone$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * How a tenant reaches its home: plain ssh to a public host, or through Anyone for an onion host (the port is
 * the tenant's own SOCKS port). The line is meant to be pasted into a shell and is built from what the host
 * sent, so it is given only for a valid shape (the same rules as web/keys.ts); anything else is undefined.
 */
export function sshLine(a: HomeAccess): string | undefined {
  const { host, port, user } = (a?.ssh ?? {}) as Partial<HomeAccess['ssh']>;
  if (typeof host !== 'string' || user !== 'tenant') return undefined;
  if (ONION.test(host)) {
    if (port !== 22) return undefined;
    return `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${host}`;
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (host.toLowerCase().endsWith('.anyone') || host.startsWith('-') || !(IPV4.test(host) || HOSTNAME.test(host))) return undefined;
  return `ssh -p ${port} tenant@${host}`;
}

/** Progress to stderr (none with --json), and the ssh line once, the first time a read shows it. */
function leaseProgress(d: CliDeps, json: boolean | undefined): (e: LeaseEvent) => void {
  let shown = false;
  return (e) => {
    if (e.kind === 'opened' && !json) d.err(`opened lease ${e.leaseId}`);
    else if (e.kind === 'ticked' && !json) d.err(`paid tick ${e.index}`);
    else if (e.kind === 'status' && e.access && !shown) {
      shown = true;
      const line = sshLine(e.access);
      if (line) d.err(line);
      else d.err('the host sent an address that is not a valid ssh login; not printing it');
    }
  };
}

function printResult(d: CliDeps, r: RunLeaseResult, json: boolean | undefined): number {
  const output = r.output ? decodeOutput(r.output) : undefined;
  if (json) {
    d.out(
      JSON.stringify({
        leaseId: r.lease.id,
        state: r.lease.state,
        paidIntervals: r.lease.paidIntervals,
        spent: r.spent.toString(),
        ...(output !== undefined ? { output } : {}),
      }),
    );
  } else {
    for (const line of leaseLines(r.lease, r.spent)) d.out(line);
    if (r.error) d.out(`boot error ${r.error}`);
    if (output !== undefined) d.out(`output\n${typeof output === 'string' ? output : JSON.stringify(output, null, 2)}`);
  }
  return r.lease.state === 'closed' ? 1 : 0;
}

function leaseLines(l: Lease, spent: Micro): string[] {
  const lines = [`lease ${l.id}`, `state ${l.state}${l.closedReason ? ` (${l.closedReason})` : ''}`, `paid intervals ${l.paidIntervals}`];
  if (l.paidThrough !== undefined) lines.push(`paid through ${new Date(l.paidThrough).toISOString()}`);
  lines.push(`spent ${formatUsdc(spent)} USDC`);
  return lines;
}

function decodeOutput(b: Buffer): unknown {
  const text = b.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runCli(argv: string[], _env: Record<string, string | undefined>, deps: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = { ...defaultDeps, ...deps };
  const [cmd] = argv;
  if (cmd === 'offers' || cmd === 'rent' || cmd === 'renew' || cmd === 'status') d.err(MOVED);
  else d.err(USAGE);
  return 2;
}

// Run only when executed (also through the npm bin symlink), not when imported by a test.
const self = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (self === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
}
