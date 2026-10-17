import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileExec, type Exec } from './exec.js';
import { decodeBody, relativeTarget, type PacketAnswer, type PacketRequest, type Payer } from './payer.js';
import type { Micro } from './types.js';

export type { Exec };

/** The `toon` binary exited non-zero, or printed something unreadable. */
export class ToonCliError extends Error {
  readonly stderr: string;
  constructor(
    readonly code: number,
    stderr: string,
  ) {
    super(`toon exited ${code}: ${stderr.slice(0, 400)}`);
    this.name = 'ToonCliError';
    this.stderr = stderr.slice(0, 400);
  }
}

export interface ToonCliOptions {
  bin?: string;
  /** Path of the file holding the wallet passphrase. It goes in env only. */
  passphraseFile: string;
  exec?: Exec;
}

/** The flags and output shapes are the ones recorded in docs/spike-notes.md (toon 0.3.0). */
export class ToonCli implements Payer {
  private readonly exec: Exec;
  private readonly env: Record<string, string>;

  constructor(opts: ToonCliOptions) {
    this.exec = opts.exec ?? execFileExec(opts.bin ?? 'toon');
    this.env = { TOON_PASSPHRASE_FILE: opts.passphraseFile };
  }

  private async run(args: string[]): Promise<any> {
    const r = await this.exec(args, this.env);
    if (r.code !== 0) throw new ToonCliError(r.code, r.stderr.trim() || r.stdout.trim());
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new ToonCliError(r.code, 'unparseable JSON from toon');
    }
  }

  async send(dest: string, req: PacketRequest, opts: { sealKey: string; amount: Micro }): Promise<PacketAnswer> {
    const path = relativeTarget(req.path);
    const args = ['send', '--json', '--seal-to', opts.sealKey, '--method', req.method];
    if (path) args.push('--path', path);
    // `--body` takes a file path, not inline JSON.
    let dir: string | undefined;
    try {
      if (req.body !== undefined) {
        dir = mkdtempSync(join(tmpdir(), 'charter-body-'));
        const file = join(dir, 'body.json');
        writeFileSync(file, JSON.stringify(req.body), { mode: 0o600 });
        args.push('--body', file);
      }
      args.push('--amount', opts.amount.toString(), '--yes', dest);
      const out = await this.run(args);
      return { status: out.response.status, body: decodeBody(out.response.body), paid: toMicro(out.paid) };
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Publish a signed event to `relayUrl`; the relay's price is paid. Returns the event id. */
  async publishEvent(ev: { kind: number; tags: string[][]; content: string }, relayUrl: string): Promise<string> {
    const out = await this.run([
      'event', 'publish', '--kind', String(ev.kind), '--content', ev.content,
      '--tags', JSON.stringify(ev.tags), '--relay', relayUrl, '--yes', '--json',
    ]);
    if (out.outcome !== 'published') throw new ToonCliError(0, `event not published: ${String(out.outcome)}`);
    return out.event.id as string;
  }

  async channels(): Promise<Array<{ id: string; direction: 'inbound' | 'outbound'; chain: string }>> {
    const out = await this.run(['channel', 'list', '--json']);
    return (out.channels as any[]).map((c) => ({ id: c.id, direction: c.direction, chain: c.chain }));
  }

  /** Redeem a channel's vouchers on chain. Returns the transactions. */
  async land(channelId: string): Promise<Array<{ chain: string; tx: string }>> {
    const out = await this.run(['channel', 'land', channelId, '--json']);
    return (out.transactions as any[]).map((t) => ({ chain: t.chain, tx: t.hash }));
  }
}

function toMicro(n: unknown): Micro {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new ToonCliError(0, `bad paid amount from toon: ${String(n)}`);
  return BigInt(n);
}
