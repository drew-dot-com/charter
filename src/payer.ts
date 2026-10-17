import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToonClient, type SendRequest, type SendOptions, type SendResult, type ToonClientConfig } from '@toon-protocol/client';
import type { Micro } from './types.js';

export interface PacketRequest {
  method: 'GET' | 'POST';
  /** With a leading `/`, as callers write it. ToonClientPayer strips it (the connector refuses an absolute envelope target with F00); the CLI takes it as given. */
  path: string;
  body?: unknown;
}

export interface PacketAnswer {
  /** The app's HTTP status. A 5xx is still a paid answer. */
  status: number;
  /** Parsed JSON when the app's body is JSON, otherwise the raw string. */
  body: unknown;
  paid: Micro;
}

export interface Payer {
  /**
   * `sealKey` is the terminating connector's `/ilp` URL (the name stays for
   * compatibility). A packet the app never answers is a thrown error, not a
   * `PacketAnswer`.
   */
  send(dest: string, req: PacketRequest, opts: { sealKey: string; amount: Micro; priority?: 'high' }): Promise<PacketAnswer>;
}

/** The path as a ToonClient envelope target: no leading slash. (The CLI takes it as given.) */
export function relativeTarget(path: string): string {
  return path.replace(/^\/+/, '');
}

/** An app body as text: parsed when it is JSON, else the string itself. */
export function decodeBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A packet the network refused: nothing was delivered to the app. */
export class PacketRefusedError extends Error {
  constructor(
    readonly code: string,
    readonly refusedBy: string,
    message: string,
  ) {
    super(`packet refused ${code} by ${refusedBy}: ${message.slice(0, 400)}`);
    this.name = 'PacketRefusedError';
  }
}

export interface ToonClientPayerConfig {
  connectorUrl: string;
  /** Solana: a JSON array of secret key bytes. EVM: a hex private key. */
  keyFile: string;
  /** The x402 channel store. Losing it strands a live channel's deposit. */
  channelStore: string;
  chain: 'evm' | 'solana';
  /** Chain RPC. The client's own default when omitted. */
  rpcUrl?: string;
  /** What each channel opens with, in micro-USDC. Default 2 USDC, as LADING. */
  deposit?: Micro;
}

/** The slice of ToonClient this payer uses. */
export interface SendClient {
  send(destination: string, request?: SendRequest, options?: SendOptions): Promise<SendResult>;
}

export interface ToonClientPayerDeps {
  /** Replace ToonClient.create, for tests. */
  createClient?: (config: ToonClientConfig) => Promise<SendClient>;
}

/** A key file that does not parse as the chain's key. The message never carries any of the file. */
export class KeyFileError extends Error {
  constructor(chain: string) {
    super(`key file is not a valid ${chain} key`);
    this.name = 'KeyFileError';
  }
}

/** Per-packet timeout handed to ToonClient. */
export const CLIENT_SEND_TIMEOUT_MS = 40_000;

/** A send that got no answer in time. The packet may or may not have been paid. */
export class SendTimeoutError extends Error {
  constructor() {
    super('send timed out');
    this.name = 'SendTimeoutError';
  }
}

export interface SerializedOpts {
  /** Per send. Default 45 s. */
  timeoutMs?: number;
  /** Timer functions, replaceable in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * One `send` in flight at a time: a channel voucher names the running total, so two at once would race
 * it. Sends with `priority: 'high'` (ticks) go before any waiting normal send (reads); within a class it is
 * first in, first out. A send that does not answer within the timeout is rejected with SendTimeoutError
 * and the queue moves on.
 */
export function serialized(p: Payer, o: SerializedOpts = {}): Payer {
  const timeoutMs = o.timeoutMs ?? 45_000;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const high: Array<() => Promise<void>> = [];
  const normal: Array<() => Promise<void>> = [];
  let running = false;
  const pump = (): void => {
    if (running) return;
    const job = high.shift() ?? normal.shift();
    if (!job) return;
    running = true;
    void job().then(() => {
      running = false;
      pump();
    });
  };
  return {
    send(dest, req, opts) {
      return new Promise((resolve, reject) => {
        const job = () =>
          new Promise<void>((done) => {
            let over = false;
            const end = (settle: () => void) => {
              if (over) return;
              over = true;
              clearTimer(timer);
              settle();
              done();
            };
            const timer = setTimer(() => end(() => reject(new SendTimeoutError())), timeoutMs);
            let sent: Promise<PacketAnswer>;
            try {
              sent = p.send(dest, req, opts);
            } catch (e) {
              sent = Promise.reject(e);
            }
            sent.then(
              (v) => end(() => resolve(v)),
              (e) => end(() => reject(e)),
            );
          });
        (opts.priority === 'high' ? high : normal).push(job);
        pump();
      });
    },
  };
}

function solanaKey(raw: string): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyFileError('solana');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new KeyFileError('solana');
  }
  return Uint8Array.from(parsed as number[]);
}

export class ToonClientPayer implements Payer {
  private constructor(private readonly client: SendClient) {}

  static async create(cfg: ToonClientPayerConfig, deps: ToonClientPayerDeps = {}): Promise<ToonClientPayer> {
    mkdirSync(dirname(cfg.channelStore), { recursive: true });
    const raw = readFileSync(cfg.keyFile, 'utf8').trim();
    // The chain's own key comes from the file. The other chain's key is a
    // throwaway, as in LADING: the client wants both set and pays on `chain`.
    if (cfg.chain === 'evm' && !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new KeyFileError('evm');
    const solanaSecretKey = cfg.chain === 'solana' ? solanaKey(raw) : randomBytes(64);
    const evmPrivateKey = (cfg.chain === 'evm' ? (raw.startsWith('0x') ? raw : '0x' + raw) : '0x' + randomBytes(32).toString('hex')) as `0x${string}`;
    const config: ToonClientConfig = {
      connector: cfg.connectorUrl,
      solanaSecretKey,
      evmPrivateKey,
      chain: cfg.chain,
      ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      transport: 'http',
      channelStore: cfg.channelStore,
      // The first paid packet opens the channel; one it cannot cover opens a fresh one.
      autoOpenChannel: true,
      deposit: cfg.deposit ?? 2_000_000n,
      // Base only, and a Solana payer names no facilitator rather than fall back to the devnet one.
      facilitatorUrl: '',
    };
    const client = await (deps.createClient ?? ((c) => ToonClient.create(c)))(config);
    return new ToonClientPayer(client);
  }

  async send(dest: string, req: PacketRequest, opts: { sealKey: string; amount: Micro }): Promise<PacketAnswer> {
    const request: SendRequest = { method: req.method, target: relativeTarget(req.path) };
    if (req.body !== undefined) request.body = req.body as SendRequest['body'];
    // The client ends its own send (and its claim state) before the wrapper's 45 s timeout gives up on it.
    const res = await this.client.send(dest, request, { amount: opts.amount, sealTo: opts.sealKey, timeoutMs: CLIENT_SEND_TIMEOUT_MS });
    if (!res.fulfilled) throw new PacketRefusedError(res.code, res.refusedBy, res.message);
    return { status: res.status, body: decodeBody(res.text()), paid: res.claim?.amount ?? 0n };
  }
}
