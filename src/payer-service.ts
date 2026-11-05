import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { buildJobEvent, chargeFor, routeFor, type NodeSelfDescription } from '@toon-protocol/client';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { DeadlinePassedError, PacketRefusedError, SendTimeoutError, type PacketAnswer, type Payer, type SendOpts } from './payer.js';
import type { SendWire, SendWireAnswer, SendWireError } from './payer-url.js';
import type { Micro } from './types.js';

/**
 * The payer service: one process that owns a box's channel, and an HTTP surface on loopback that every other
 * process in the box pays through. A channel voucher names a running total, so a second signer would race the
 * first and get its packets refused (docs/ops.md, "Homes"). The surface:
 *
 *   POST /send            the Payer interface over HTTP (`CHARTER_PAYER=url` in the charter CLI)
 *   GET  /extract?url=    one paid anonymous page fetch, the anonfetch payer sidecar's contract, so a Hermes
 *                         `web-toon` plugin pointed at this service needs no change
 *   GET  /fetch?url=[&method=HEAD]   the same job in raw mode
 *   POST /relay/post      {content, kind?, tags?}: a Nostr event signed with the service's own key, paid onto a relay route
 *   GET  /relay/read?filter=<json>[&relay=wss://...][&timeout_ms=]   a free relay read over a WebSocket
 *   GET  /health
 *
 * `/send` is for the charter CLI on this machine and is bounded only by what the caller asks. The app endpoints
 * (`/extract`, `/fetch`, `/relay/post`) share one daily cap, so a chatty agent cannot drain the channel the
 * rent comes from.
 */

export const DEFAULT_LISTEN = '127.0.0.1:3510';
/** Micro-USDC a UTC day across the app endpoints. 0.10 USDC: a hundred fetches at the default price. */
export const DEFAULT_DAILY_CAP: Micro = 100_000n;
export const DEFAULT_EXTRACT_ROUTE = 'g.drew.anon';
export const DEFAULT_RELAY_ROUTE = 'g.drew.relay';
export const DEFAULT_RELAY_URL = 'wss://relay.mainnet.toonprotocol.dev';
export const EXTRACT_JOB_KIND = 5301;
/** A relay read ends at EOSE, at this many events, or after `timeout_ms` (default below, at most MAX_READ_TIMEOUT_MS). */
export const MAX_READ_EVENTS = 500;
export const DEFAULT_READ_TIMEOUT_MS = 15_000;
export const MAX_READ_TIMEOUT_MS = 60_000;
export const MAX_POST_CHARS = 4_000;
/** A body on `/send` or `/relay/post` past this is refused unread. */
export const MAX_BODY_BYTES = 256 * 1024;

export type Json = Record<string, unknown>;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** The UTC day's spend across the app endpoints, kept in a small file so a restart does not reset it. */
export class DailyBudget {
  private day: string;
  private spent: Micro;

  constructor(
    private readonly file: string | undefined,
    readonly cap: Micro,
    private readonly now: () => number = Date.now,
  ) {
    this.day = DailyBudget.dayOf(now());
    this.spent = 0n;
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { day?: string; spent?: string };
        if (j.day === this.day && typeof j.spent === 'string' && /^\d+$/.test(j.spent)) this.spent = BigInt(j.spent);
      } catch {
        // A bad file starts a fresh day.
      }
    }
  }

  static dayOf(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  private roll(): void {
    const day = DailyBudget.dayOf(this.now());
    if (day !== this.day) {
      this.day = day;
      this.spent = 0n;
    }
  }

  /** Undefined when `price` may be spent now, else why not. */
  check(price: Micro): string | undefined {
    this.roll();
    if (this.spent + price > this.cap) return `daily cap ${this.cap} reached (${this.spent} spent today, ${price} asked)`;
    return undefined;
  }

  record(paid: Micro): void {
    this.roll();
    this.spent += paid;
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ day: this.day, spent: this.spent.toString() }));
    }
  }

  view(): { day: string; spent: string; cap: string; remaining: string } {
    this.roll();
    const left = this.cap - this.spent;
    return { day: this.day, spent: this.spent.toString(), cap: this.cap.toString(), remaining: (left < 0n ? 0n : left).toString() };
  }
}

/** The service's Nostr signing key: the file's 32 hex bytes, made (mode 600) when the file is missing. Not a money key. */
export function loadNostrKey(file: string): Uint8Array {
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('the Nostr key file is not 32 hex bytes');
    return Uint8Array.from(Buffer.from(raw, 'hex'));
  }
  const sk = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sk.toString('hex') + '\n', { mode: 0o600 });
  return Uint8Array.from(sk);
}

/** Read a relay once: open, REQ, collect until EOSE, the cap or the timeout, close. The default uses Node's WebSocket, which follows the box's proxy variables. */
export type RelayReader = (relay: string, filter: Json, timeoutMs: number) => Promise<NostrEvent[]>;

export const webSocketRelayReader: RelayReader = (relay, filter, timeoutMs) =>
  new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    const sub = randomBytes(8).toString('hex');
    let done = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch (e) {
      reject(new Error(`cannot open ${relay}: ${String(e instanceof Error ? e.message : e)}`));
      return;
    }
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(events);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', sub, filter]));
    ws.onerror = () => finish(new Error(`relay ${relay} connection failed`));
    ws.onclose = () => finish();
    ws.onmessage = (m) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[1] === sub && msg[2] && typeof msg[2] === 'object') {
        events.push(msg[2] as NostrEvent);
        if (events.length >= MAX_READ_EVENTS) finish();
      } else if (msg[0] === 'EOSE' && msg[1] === sub) {
        finish();
      } else if (msg[0] === 'CLOSED' && msg[1] === sub) {
        finish(new Error(`relay closed the subscription: ${String(msg[2] ?? '')}`.slice(0, 300)));
      }
    };
  });

export interface PayerServiceDeps {
  /** The channel owner, already wrapped in `serialized`. */
  payer: Payer;
  /** The connector's `GET /ilp`, as the client reads it: route prices and the sealing key. Cached by the caller. */
  describe: () => Promise<NodeSelfDescription>;
  /** The `/ilp` URL the payer sends through; also the seal URL for routes this connector terminates. */
  connectorUrl: string;
  /** The address the channel is funded from, so a tenant can fund it; `/health` shows it even when `channel` fails. */
  payerAddress?: string | null;
  /** Headroom and channel facts for `/health`, when the payer can say. */
  channel?: () => Promise<Json>;
  /** The service's Nostr signing key, for `/relay/post`. */
  nostrKey: () => Uint8Array;
  budget: DailyBudget;
  extractRoute?: string;
  relayRoute?: string;
  relayUrl?: string;
  relayRead?: RelayReader;
  now?: () => number;
  log?: (line: string) => void;
  version?: string;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Json = {},
  ) {
    super(message);
    this.name = 'Refusal';
  }
}

const HEX_KEY = /^0x04[0-9a-fA-F]{128}$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Refusal(413, 'body_too_large', `body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (e) => reject(e));
  });
}

function jsonBody(text: string): Json {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal(400, 'bad_json', 'body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Refusal(400, 'bad_json', 'body must be a JSON object');
  return parsed as Json;
}

/** The `/send` body checked field by field; the message names the field, never its value. */
export function parseSendWire(j: Json): { dest: string; req: { method: 'GET' | 'POST'; path: string; body?: unknown }; opts: SendOpts } {
  const w = j as Partial<SendWire>;
  if (typeof w.dest !== 'string' || !/^[a-zA-Z0-9._~-]+$/.test(w.dest)) throw new Refusal(400, 'bad_request', 'dest must be an ILP address');
  if (w.method !== 'GET' && w.method !== 'POST') throw new Refusal(400, 'bad_request', 'method must be GET or POST');
  if (typeof w.path !== 'string') throw new Refusal(400, 'bad_request', 'path must be a string');
  if (typeof w.sealKey !== 'string' || !HEX_KEY.test(w.sealKey)) throw new Refusal(400, 'bad_request', 'sealKey must be 0x04 and 128 hex digits');
  if (typeof w.sealUrl !== 'string' || w.sealUrl === '') throw new Refusal(400, 'bad_request', 'sealUrl must be a URL');
  if (typeof w.amount !== 'string' || !/^\d{1,30}$/.test(w.amount)) throw new Refusal(400, 'bad_request', 'amount must be a decimal string of micro-USDC');
  if (w.priority !== undefined && w.priority !== 'high') throw new Refusal(400, 'bad_request', 'priority must be high or absent');
  if (w.deadline !== undefined && (typeof w.deadline !== 'number' || !Number.isFinite(w.deadline))) throw new Refusal(400, 'bad_request', 'deadline must be epoch ms');
  const opts: SendOpts = { sealKey: w.sealKey, sealUrl: w.sealUrl, amount: BigInt(w.amount) };
  if (w.priority) opts.priority = w.priority;
  if (w.deadline !== undefined) opts.deadline = w.deadline;
  return { dest: w.dest, req: { method: w.method, path: w.path, ...('body' in j ? { body: j.body } : {}) }, opts };
}

/** A send failure as the wire carries it, so UrlPayer can throw the same error on its side. */
export function wireError(e: unknown): { status: number; body: SendWireError } {
  if (e instanceof PacketRefusedError) return { status: 502, body: { error: 'packet_refused', code: e.code, refusedBy: e.refusedBy, message: e.message } };
  if (e instanceof DeadlinePassedError) return { status: 504, body: { error: 'deadline_passed', message: e.message } };
  if (e instanceof SendTimeoutError) return { status: 504, body: { error: 'send_timeout', message: e.message } };
  return { status: 502, body: { error: 'send_failed', message: String(e instanceof Error ? e.message : e).slice(0, 400) } };
}

/** The receipt a NIP-90 app answered: `result`, else the base64 `data`. */
export function receiptOf(body: unknown): Json | undefined {
  const b = body as { result?: unknown; data?: unknown } | null;
  if (b && typeof b === 'object') {
    if (b.result && typeof b.result === 'object') return b.result as Json;
    if (typeof b.data === 'string') {
      try {
        const r = JSON.parse(Buffer.from(b.data, 'base64').toString('utf8')) as unknown;
        if (r && typeof r === 'object') return r as Json;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function payerService(d: PayerServiceDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => undefined);
  const extractRoute = d.extractRoute ?? DEFAULT_EXTRACT_ROUTE;
  const relayRoute = d.relayRoute ?? DEFAULT_RELAY_ROUTE;
  const relayUrl = d.relayUrl ?? DEFAULT_RELAY_URL;
  const relayRead = d.relayRead ?? webSocketRelayReader;
  const started = now();

  const send = (res: ServerResponse, status: number, obj: unknown): void => {
    const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const refuse = (res: ServerResponse, r: Refusal): void => send(res, r.status, { ok: false, code: r.code, error: r.message, ...r.extra });

  /** The connector's price for a route, from its self-description, metered over `bytes` when the route meters. */
  async function priceFor(route: string, bytes: number): Promise<{ price: Micro; sealKey: string }> {
    const desc = await d.describe();
    const terms = routeFor(desc, route);
    if (!terms) throw new Refusal(502, 'route_unpriced', `route ${route} is not priced at ${d.connectorUrl}`);
    const sealKey = desc.edgeIdentity?.publicKey;
    if (!sealKey || !HEX_KEY.test(sealKey)) throw new Refusal(502, 'no_seal_key', `${d.connectorUrl} publishes no sealing key`);
    return { price: chargeFor(terms, bytes), sealKey };
  }

  /** One paid app call under the daily cap: priced, checked, sent, recorded. */
  async function paidApp(route: string, body: Json, what: string): Promise<{ answer: PacketAnswer; price: Micro }> {
    const bytes = Buffer.byteLength(JSON.stringify(body));
    const { price, sealKey } = await priceFor(route, bytes);
    const over = d.budget.check(price);
    if (over) throw new Refusal(402, 'budget_exhausted', over);
    const t0 = now();
    let answer: PacketAnswer;
    try {
      answer = await d.payer.send(route, { method: 'POST', path: '/', body }, { sealKey, sealUrl: d.connectorUrl, amount: price });
    } catch (e) {
      const w = wireError(e);
      log(`${what} ${route} failed ${w.body.error} ${w.body.message ?? ''}`.trim());
      throw new Refusal(w.status, w.body.error, w.body.message ?? '', { ...(w.body.code ? { ilp_code: w.body.code } : {}) });
    }
    d.budget.record(answer.paid);
    log(`${what} ${route} -> ${answer.status} paid=${answer.paid} ms=${now() - t0} spent_today=${d.budget.view().spent}`);
    return { answer, price };
  }

  const usdc = (units: Micro, chain: string) => ({ units: units.toString(), asset: 'USDC', decimals: 6, chain });

  async function chainName(): Promise<string> {
    const c: Json = d.channel ? await d.channel().catch(() => ({})) : {};
    return typeof c.chain === 'string' ? c.chain : 'unknown';
  }

  async function fetchJob(u: URL, mode: 'extract' | 'raw', res: ServerResponse): Promise<void> {
    const raw = u.searchParams.get('url');
    if (!raw) throw new Refusal(400, 'bad_url', 'url query parameter is required');
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      throw new Refusal(400, 'bad_url', 'url is not an absolute URL');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Refusal(400, 'bad_url', 'url must be http or https');
    const method = (u.searchParams.get('method') ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw new Refusal(400, 'bad_method', 'method must be GET or HEAD');
    const event = buildJobEvent({ kind: EXTRACT_JOB_KIND, params: { url: target.toString(), method, mode } });
    const { answer, price } = await paidApp(extractRoute, { event }, mode);
    const b = answer.body as { accept?: boolean; code?: string; message?: string } | null;
    if (answer.status !== 200 || !b || typeof b !== 'object' || b.accept !== true) {
      throw new Refusal(502, 'node_refused', `${b?.code ?? `HTTP ${answer.status}`} ${b?.message ?? ''}`.trim(), { paid: answer.paid.toString() });
    }
    const r = receiptOf(answer.body) ?? {};
    const common = { ok: true, price: usdc(price, await chainName()), node: { edge: d.connectorUrl, destination: extractRoute }, budget: d.budget.view() };
    if (mode === 'raw') return send(res, 200, { ...common, ...r, exit: r.via });
    send(res, 200, {
      ...common,
      url: r.url,
      final_url: r.final_url,
      status: r.status,
      headers: r.headers,
      title: r.title,
      content: r.content,
      content_hash: r.content_hash,
      raw_hash: r.raw_hash,
      protocol: r.protocol,
      protocol_version: r.protocol_version,
      format: r.format,
      thin: r.thin,
      truncated: r.truncated,
      content_bytes: r.content_bytes,
      returned_bytes: r.returned_bytes,
      bytes: r.bytes,
      exit: r.via,
      fetched_at: r.fetched_at,
      elapsed_ms: r.elapsed_ms,
      job_id: r.job_id,
    });
  }

  async function relayPost(j: Json, res: ServerResponse): Promise<void> {
    const content = j.content;
    if (typeof content !== 'string' || content.trim() === '') throw new Refusal(400, 'bad_request', 'content must be a non-empty string');
    if (content.length > MAX_POST_CHARS) throw new Refusal(400, 'bad_request', `content is over ${MAX_POST_CHARS} characters`);
    const kind = j.kind === undefined ? 1 : j.kind;
    if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind > 65535) throw new Refusal(400, 'bad_request', 'kind must be a whole number');
    const tags = j.tags === undefined ? [] : j.tags;
    if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))) throw new Refusal(400, 'bad_request', 'tags must be arrays of strings');
    const sk = d.nostrKey();
    const event = finalizeEvent({ kind, created_at: Math.floor(now() / 1000), tags: tags as string[][], content }, sk) as NostrEvent;
    const { answer, price } = await paidApp(relayRoute, { event }, 'post');
    send(res, answer.status >= 200 && answer.status < 300 ? 200 : 502, {
      ok: answer.status >= 200 && answer.status < 300,
      event,
      relay_status: answer.status,
      relay_answer: answer.body,
      paid: answer.paid.toString(),
      price: usdc(price, await chainName()),
      route: relayRoute,
      relay: relayUrl,
      budget: d.budget.view(),
    });
  }

  async function relayReadRoute(u: URL, res: ServerResponse): Promise<void> {
    const rawFilter = u.searchParams.get('filter') ?? '{}';
    let filter: unknown;
    try {
      filter = JSON.parse(rawFilter);
    } catch {
      throw new Refusal(400, 'bad_filter', 'filter must be a JSON object');
    }
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Refusal(400, 'bad_filter', 'filter must be a JSON object');
    const relay = u.searchParams.get('relay') ?? relayUrl;
    if (!/^wss?:\/\//.test(relay)) throw new Refusal(400, 'bad_relay', 'relay must be a ws:// or wss:// URL');
    const t = Number(u.searchParams.get('timeout_ms') ?? DEFAULT_READ_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, MAX_READ_TIMEOUT_MS) : DEFAULT_READ_TIMEOUT_MS;
    const f = filter as Json;
    if (typeof f.limit !== 'number' || f.limit > MAX_READ_EVENTS) f.limit = Math.min(typeof f.limit === 'number' ? f.limit : 10, MAX_READ_EVENTS);
    let events: NostrEvent[];
    try {
      events = await relayRead(relay, f, timeoutMs);
    } catch (e) {
      throw new Refusal(502, 'relay_unreachable', String(e instanceof Error ? e.message : e).slice(0, 300));
    }
    send(res, 200, { ok: true, relay, count: events.length, events });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && u.pathname === '/health') {
      const channel = d.channel ? await d.channel().catch((e) => ({ error: String(e instanceof Error ? e.message : e).slice(0, 200) })) : undefined;
      return send(res, 200, {
        ok: true,
        service: 'charter-payer',
        version: d.version ?? '0',
        connector: d.connectorUrl,
        routes: { extract: extractRoute, relay: relayRoute },
        relay: relayUrl,
        payer: d.payerAddress ?? null,
        nostr_pubkey: getPublicKey(d.nostrKey()),
        budget: d.budget.view(),
        uptime_s: Math.floor((now() - started) / 1000),
        ...(channel ? { channel } : {}),
      });
    }
    if (req.method === 'POST' && u.pathname === '/send') {
      const { dest, req: pr, opts } = parseSendWire(jsonBody(await readBody(req)));
      const t0 = now();
      try {
        const a = await d.payer.send(dest, pr, opts);
        log(`send ${dest} ${pr.method} ${pr.path} -> ${a.status} paid=${a.paid} ms=${now() - t0}`);
        const out: SendWireAnswer = { status: a.status, body: a.body, paid: a.paid.toString() };
        return send(res, 200, out);
      } catch (e) {
        const w = wireError(e);
        log(`send ${dest} ${pr.method} ${pr.path} failed ${w.body.error} ${w.body.message ?? ''}`.trim());
        return send(res, w.status, w.body);
      }
    }
    if (req.method === 'GET' && u.pathname === '/extract') return fetchJob(u, 'extract', res);
    if (req.method === 'GET' && u.pathname === '/fetch') return fetchJob(u, 'raw', res);
    if (req.method === 'POST' && u.pathname === '/relay/post') return relayPost(jsonBody(await readBody(req)), res);
    if (req.method === 'GET' && u.pathname === '/relay/read') return relayReadRoute(u, res);
    throw new Refusal(404, 'not_found', 'POST /send  GET /extract?url=  GET /fetch?url=[&method=HEAD]  POST /relay/post  GET /relay/read?filter=  GET /health');
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof Refusal) return refuse(res, e);
      log(`error ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
      if (!res.headersSent) send(res, 500, { ok: false, code: 'error', error: String(e instanceof Error ? e.message : e).slice(0, 400) });
    });
  };
}
