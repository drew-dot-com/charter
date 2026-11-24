import { createHmac, randomBytes } from 'node:crypto';
import type { SocialConfig } from './config.js';

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string;
  conversationId: string;
  /** Epoch ms. */
  createdAt: number;
}

/**
 * X pay-per-use prices in USD per call. Source: docs.x.com pricing page, read 2026-11-24.
 * Create post 0.015, create post with URL 0.20. readPost is the "owned reads" rate that
 * applies to GET /2/users/:id/mentions (0.001 per returned post); the general Posts: Read
 * rate on that page is 0.005. Prices change: recheck the Developer Console.
 */
export const X_PRICE_USD = { post: 0.015, postWithUrl: 0.2, readPost: 0.001 };

export function costOf(kind: 'post' | 'read', opts: { hasUrl?: boolean; count?: number } = {}): number {
  if (kind === 'post') return opts.hasUrl ? X_PRICE_USD.postWithUrl : X_PRICE_USD.post;
  return X_PRICE_USD.readPost * (opts.count ?? 1);
}

export class XError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'XError';
  }
}

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function oauth1Header(
  method: string,
  url: string,
  params: Record<string, string>,
  keys: SocialConfig['x'],
  nonce: string,
  timestamp: number,
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: keys.accessToken,
    oauth_version: '1.0',
  };
  const all = { ...params, ...oauth };
  const paramString = Object.entries(all)
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  const signingKey = `${enc(keys.consumerSecret)}&${enc(keys.accessSecret)}`;
  const signature = createHmac('sha1', signingKey).update(base).digest('base64');
  const header = { ...oauth, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.entries(header)
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(', ')
  );
}

const BASE = 'https://api.x.com';

interface MentionsBody {
  data?: { id: string; text: string; author_id: string; conversation_id: string; created_at: string }[];
  includes?: { users?: { id: string; username: string }[] };
  meta?: { newest_id?: string };
}

export class XClient {
  constructor(
    private readonly keys: SocialConfig['x'],
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<unknown> {
    const url = BASE + path;
    const auth = oauth1Header(method, url, query, this.keys, randomBytes(16).toString('hex'), Math.floor(Date.now() / 1000));
    const qs = new URLSearchParams(query).toString();
    const headers: Record<string, string> = { Authorization: auth };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchFn(qs ? `${url}?${qs}` : url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new XError(`X ${method} ${path} failed with ${res.status}: ${detail}`, res.status);
    }
    return res.json();
  }

  async post(text: string, replyTo?: string): Promise<string> {
    const body: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text };
    if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
    const r = (await this.call('POST', '/2/tweets', {}, body)) as { data?: { id?: string } };
    if (!r.data?.id) throw new XError('X POST /2/tweets returned no id', 502);
    return r.data.id;
  }

  async delete(id: string): Promise<void> {
    await this.call('DELETE', `/2/tweets/${encodeURIComponent(id)}`);
  }

  async mentions(sinceId?: string): Promise<{ mentions: Mention[]; newestId?: string }> {
    const q: Record<string, string> = {
      'tweet.fields': 'conversation_id,created_at,author_id',
      expansions: 'author_id',
      'user.fields': 'username',
      max_results: '100',
    };
    if (sinceId) q.since_id = sinceId;
    const r = (await this.call('GET', `/2/users/${encodeURIComponent(this.keys.userId)}/mentions`, q)) as MentionsBody;
    const handles = new Map((r.includes?.users ?? []).map((u) => [u.id, u.username]));
    const mentions = (r.data ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      authorHandle: handles.get(t.author_id) ?? '',
      conversationId: t.conversation_id,
      createdAt: Date.parse(t.created_at),
    }));
    return { mentions, newestId: r.meta?.newest_id };
  }
}
