// The browser's copy of the door's SSH key rules (src/jobs.ts normalizeSshKeys): the bundle does not import
// src/, which uses Node APIs. The door checks again; this only names the bad line before anything is paid.

const MAX_SSH_KEYS = 8;
const MAX_SSH_KEY_BYTES = 1024;
const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [\x20-\x7e]*)?$/;

/** One key per line, blank lines skipped: the trimmed lines, or a message naming what is wrong. */
export function parseSshKeys(text: string): string[] | string {
  const lines = text.split('\n').map((l, i) => ({ n: i + 1, t: l.trim() })).filter((l) => l.t !== '');
  if (lines.length < 1) return 'Paste at least one SSH public key.';
  if (lines.length > MAX_SSH_KEYS) return `At most ${MAX_SSH_KEYS} keys.`;
  for (const { n, t } of lines) {
    if (new TextEncoder().encode(t).length > MAX_SSH_KEY_BYTES || !SSH_KEY.test(t)) return `Line ${n} is not an SSH public key.`;
  }
  return lines.map((l) => l.t);
}

const ONION = /^[a-z2-7]{56}\.anyone$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The command a renter pastes into a shell to reach a running home. Built from what the host sent, so it is
 * given only for the shapes the host publishes: user tenant and either an onion name (the host's own check in
 * src/host/anon.ts) on port 22, reached over the Anyone client, or a public IPv4 address or hostname on an
 * integer port 1-65535, reached by plain ssh. Anything else is undefined and the page says pending.
 */
export function sshLine(access: unknown): string | undefined {
  const ssh = (access as { ssh?: unknown } | null | undefined)?.ssh as { host?: unknown; port?: unknown; user?: unknown } | null | undefined;
  if (!ssh || typeof ssh.host !== 'string' || ssh.user !== 'tenant') return undefined;
  if (!ONION.test(ssh.host)) {
    const port = ssh.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if (ssh.host.toLowerCase().endsWith('.anyone') || !(IPV4.test(ssh.host) || (HOSTNAME.test(ssh.host) && !ssh.host.startsWith('-')))) return undefined;
    return `ssh -p ${port} tenant@${ssh.host}`;
  }
  if (ssh.port !== 22) return undefined;
  // The SOCKS port is the renter's own Anyone client's; the page says to put it in, as the CLI and docs do.
  return `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${ssh.host}`;
}
