import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToonClient, type SendRequest, type SendOptions, type SendResult, type ToonClientConfig } from '@toon-protocol/client';
import type { Micro } from './types.js';

export interface PacketRequest {
  method: 'GET' | 'POST';
  /** With a leading `/`, as callers write it. Payers strip it: the connector refuses an absolute target with F00. */
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
  send(dest: string, req: PacketRequest, opts: { sealKey: string; amount: Micro }): Promise<PacketAnswer>;
}

/** The path as a payer sends it: no leading slash. */
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

export class ToonClientPayer implements Payer {
  private constructor(private readonly client: SendClient) {}

  static async create(cfg: ToonClientPayerConfig, deps: ToonClientPayerDeps = {}): Promise<ToonClientPayer> {
    mkdirSync(dirname(cfg.channelStore), { recursive: true });
    const raw = readFileSync(cfg.keyFile, 'utf8').trim();
    // The chain's own key comes from the file. The other chain's key is a
    // throwaway, as in LADING: the client wants both set and pays on `chain`.
    const solanaSecretKey = cfg.chain === 'solana' ? Uint8Array.from(JSON.parse(raw) as number[]) : randomBytes(64);
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
    const res = await this.client.send(dest, request, { amount: opts.amount, sealTo: opts.sealKey });
    if (!res.fulfilled) throw new PacketRefusedError(res.code, res.refusedBy, res.message);
    return { status: res.status, body: decodeBody(res.text()), paid: res.claim?.amount ?? 0n };
  }
}
