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
