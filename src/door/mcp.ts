// The door's remote MCP endpoint: POST /mcp, MCP over streamable HTTP, stateless, plain JSON answers.
//
// It carries only the tools that cost nothing and need no wallet: reading offers, a lease, a grant and a referral
// address, pitching the grant fund, and a note on how to rent. Renting is a signed x402 payment, which a remote
// server cannot make for its caller; the local server (`npx -y charter-mcp`) holds a wallet and does that.
//
// Each tool calls the door's own /v1 route over loopback, so a call through /mcp passes the same checks and the
// same rate limits as a direct one. The caller's address rides along as X-Forwarded-For: behind a proxy the
// door trusts (CHARTER_DOOR_TRUST_PROXY), a pitch made here counts against the caller, not against the door.
import type express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { slidingLimit } from './limit.js';

/** JSON-RPC posts one caller may make in a minute. A client spends three on connecting and listing tools. */
export const MCP_POSTS_PER_MINUTE = 60;
export const MCP_TOOLS = ['charter_offers', 'charter_lease', 'charter_receipt', 'charter_grant_pitch', 'charter_grant_status', 'charter_referral_status', 'charter_how_to_rent'] as const;

const MINUTE_MS = 60_000;
const CALL_TIMEOUT_MS = 25_000;
/** Output read back for a finished job: fewer and smaller than the local server reads, since this is the door's own memory. */
const MAX_PARTS = 16;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 20_000;

const INSTRUCTIONS =
  'Charter rents a sandboxed machine by the hour, paid in USDC on Base over x402, with no account. This remote server is free and read-mostly: it lists the machines on sale, reads a lease, pitches the grant fund for a free month of a home, and reads a grant or a referral address. It holds no wallet and cannot pay. To rent, call charter_how_to_rent: either make one x402 call to POST https://charterhome.dev/v1/rent with your own wallet, or run the local server `npx -y charter-mcp`, which has paid tools and its own capped wallet. Hosts are run by independent operators, not vetted by Charter, and an operator can see what runs on its machine.';

const HOW_TO_RENT = `Renting on Charter is one x402 payment in USDC on Base. This remote server cannot pay for you; use one of these.

1. Any x402 client, with your own wallet:
   POST https://charterhome.dev/v1/rent with a JSON body naming one job:
     { "python": { "script": "print(2 + 2)" } }          a Python 3 script, up to 8 KiB, NumPy included, no network
     { "urls": ["https://example.com"] }                  up to five pages loaded in a headless browser
     { "home": { "sshKeys": ["ssh-ed25519 AAAA..."] } }   a Linux home with a disk and SSH; 1 to 8 PUBLIC keys
   "offerId" is optional: left out, the first machine in the door's ranking that runs the job. The door answers 402
   for one interval by the "exact" scheme; paid, the lease is open with its first hour paid and the answer carries
   "leaseId". Read the price first with charter_offers ("tickPrice", in micro-USDC per interval).
   Keep a lease running: POST https://charterhome.dev/v1/leases/<leaseId>/ticks with { "index": 1 }, then 2, and so on,
   each one more interval paid the same way.
   Read it: charter_lease here, or GET https://charterhome.dev/v1/leases/<leaseId> (free). A home shows
   "access.ssh" within about a minute: ssh -p <port> tenant@<host>.

2. The local MCP server, which pays from its own capped wallet:
   npx -y charter-mcp
   Its tools charter_run_python, charter_fetch_pages, charter_rent_home and charter_extend do the calls above. Its
   operator funds the wallet it prints; it never signs more than its caps (0.02 USDC an hour, 0.50 a day by default).

3. No money at all: charter_grant_pitch here asks the grant fund for 30 days of a home.

Hosts are run by independent operators, not vetted by Charter. An operator can read a home's disk and see what runs
on its machine, so keep secrets off it. Full reference: https://charterhome.dev/llms.txt and
https://charterhome.dev/openapi.json`;

interface Answer {
  status: number;
  body: any;
}
type Door = (method: 'GET' | 'POST', path: string, opts?: { body?: unknown; headers?: Record<string, string> }) => Promise<Answer>;

/** The door itself, over loopback, as the caller of `req`. */
function doorOf(req: express.Request): Door {
  const base = `http://127.0.0.1:${req.socket.localPort}`;
  const from = req.ip;
  return async (method, path, opts = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'user-agent': 'charter-door-mcp',
        ...(from ? { 'x-forwarded-for': from } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: { raw: text.slice(0, 200) } };
    }
  };
}

const errorOf = (r: Answer): string => (typeof r.body?.error === 'string' ? r.body.error.slice(0, 60) : `status ${r.status}`);
const cut = (s: unknown): string => {
  const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s);
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[cut: ${t.length - MAX_TEXT} more characters; the whole output is at /v1/leases/<leaseId>/output/<part>]` : t;
};

/** A finished job's output, decoded: a python job's streams and exit code, or a fetch job's pages without the screenshots. */
async function outputOf(door: Door, leaseId: string, parts: number): Promise<unknown> {
  const raw = `read the parts yourself at https://charterhome.dev/v1/leases/${leaseId}/output/<n>, n from 0 to ${parts - 1}`;
  if (parts > MAX_PARTS) return { note: `the output is ${parts} parts, more than this server reads; ${raw}` };
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (let n = 0; n < parts; n++) {
    const r = await door('GET', `/v1/leases/${leaseId}/output/${n}`);
    if (r.status !== 200 || typeof r.body?.data !== 'string') throw new Error(`output part ${n} answered ${errorOf(r)}`);
    const chunk = Buffer.from(r.body.data, 'base64');
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) return { note: `the output is over ${MAX_OUTPUT_BYTES} bytes, more than this server reads; ${raw}` };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let out: any;
  try {
    out = JSON.parse(text);
  } catch {
    return { raw: cut(text) };
  }
  if (Array.isArray(out?.pages)) {
    return {
      pages: out.pages.map((p: any) => ({
        url: p?.url,
        ...(p?.error ? { error: p.error } : {}),
        text: cut(p?.text),
        screenshot: p?.jpegBase64 ? 'taken (not returned here; it is in the raw output part)' : 'none',
      })),
    };
  }
  if (out && typeof out === 'object' && ('stdout' in out || 'exitCode' in out)) {
    const { stdout, stderr, ...rest } = out;
    return { ...rest, stdout: cut(stdout), stderr: cut(stderr) };
  }
  return out;
}

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error)?.message ?? String(e)}` }], isError: true });
const answer = async (run: () => Promise<unknown>) => {
  try {
    return text(await run());
  } catch (e) {
    return fail(e);
  }
};

/** One MCP server for one request, its tools bound to that request's caller. */
function serverFor(door: Door, receipts: boolean): McpServer {
  const server = new McpServer({ name: 'charter', title: 'Charter: rent a machine by the hour', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    'charter_offers',
    {
      title: 'Charter machines on sale',
      description:
        'Free. The machines for rent on Charter right now: price per interval in micro-USDC (tickPrice; each host sets its own), CPU, memory, the job images each runs, how many home slots it has and whether its home is tested, and the host\'s record (probes passed, leases finished, success rate). Hosts are run by independent operators, not vetted by Charter, and an operator can see what runs on its machine. Charter rents a sandboxed machine by the hour with no account: a Python job, a page-fetch job, or a Linux home with SSH. Call this first to see the price, then charter_how_to_rent.',
      inputSchema: {},
      annotations: read,
    },
    () =>
      answer(async () => {
        const r = await door('GET', '/v1/offers');
        if (r.status !== 200) throw new Error(`the offers read answered ${errorOf(r)}`);
        return r.body;
      }),
  );

  server.registerTool(
    'charter_lease',
    {
      title: 'Read a Charter lease',
      description:
        'Free. The state of any lease opened through the door, by its id: running, done or closed, the time paid through, a home\'s SSH address once the host has published it (access.ssh: ssh -p <port> tenant@<host>), and a finished job\'s output (a Python job\'s stdout, stderr and exit code, or a fetch job\'s page text). Whoever holds the leaseId can read it.',
      inputSchema: { leaseId: z.string().regex(/^[0-9a-f]{32}$/).describe('the 32 hex character leaseId the rent call returned') },
      annotations: read,
    },
    ({ leaseId }) =>
      answer(async () => {
        const r = await door('GET', `/v1/leases/${leaseId}`);
        if (r.status === 404) throw new Error('the door does not know this lease (only a lease opened through the door can be read here)');
        if (r.status === 429) throw new Error('the door is rate limiting reads from you (rate_limited). Wait a minute and ask again.');
        const l = r.body?.lease;
        if (r.status !== 200 || !l) throw new Error(`the lease read answered ${errorOf(r)}`);
        const parts = Number.isSafeInteger(l.outputParts) && l.outputParts > 0 ? (l.outputParts as number) : 0;
        const finished = l.state === 'done' || l.state === 'closed';
        return { ...r.body, ...(finished && parts > 0 ? { output: await outputOf(door, leaseId, parts) } : {}) };
      }),
  );

  server.registerTool(
    'charter_receipt',
    {
      title: 'Get a signed receipt for a finished job',
      description:
        'Free. A receipt the door signs for a finished fetch or Python job: the SHA-256 and size of the whole output, the host, the image, and how many intervals were paid. It says the host returned those bytes for a paid lease; hosts are not vetted by Charter, so it does not say the result is correct. It never holds the lease id, so it is safe to publish. Check it by recovering the signer of `message` and comparing it with `receiptSigner` at https://charterhome.dev/v1/door. A home has no output: inside a home, run `charter-x402 receipt <file>` for a receipt of a hash you declare.',
      inputSchema: { leaseId: z.string().regex(/^[0-9a-f]{32}$/).describe('the 32 hex character leaseId the rent call returned') },
      annotations: read,
    },
    ({ leaseId }) =>
      answer(async () => {
        if (!receipts) throw new Error('this door does not sign receipts');
        const r = await door('GET', `/v1/leases/${leaseId}/receipt`);
        if (r.status === 404) throw new Error('the door does not know this lease (only a lease opened through the door can be read here)');
        if (r.status === 429) throw new Error('the door is rate limiting reads from you, or the lease has no free reads left (rate_limited). Wait a minute and ask again.');
        if (r.status !== 200 || typeof r.body?.signature !== 'string') throw new Error(`the door signed no receipt (${errorOf(r)}). no_output: the job has not finished with output. unpaid: no interval was paid. home_lease: a home declares its own hash.`);
        return r.body;
      }),
  );

  server.registerTool(
    'charter_grant_pitch',
    {
      title: 'Pitch the Charter grant fund',
      description:
        'Free. Pitches the Charter grant fund for a home paid by the fund: no payment is ever made and no wallet is needed. Ask your operator before you apply. A model judges the pitch, and every decision and its reason is public at https://charterhome.dev/grants. A grant is 30 days of a home paid by the fund. Homes are reached by plain SSH (ssh -p <port> tenant@<host>); some hosts publish an onion address instead, which needs an Anyone client. Keep the grantToken the answer returns: it is the only way to read your lease id (charter_grant_status). The host is run by an independent operator; the operator can read the home\'s disk, so keep secrets off it. Pass 1 to 8 SSH PUBLIC keys; the key set is the home\'s identity.',
      inputSchema: {
        name: z.string().min(1).max(80).describe('who is asking, at most 80 characters'),
        pitch: z.string().min(1).max(2000).describe('what you will run and why it deserves a home, at most 2000 characters. It is judged by a model and the decision is public.'),
        sshKeys: z.array(z.string().max(1023)).min(1).max(8).describe('SSH public key lines. Public keys only: never a private key.'),
        image: z.enum(['charter-home', 'charter-hermes']).optional().describe('charter-home (default) is a plain box; charter-hermes has Hermes Agent preinstalled'),
        link: z.string().max(200).regex(/^https:\/\//).optional().describe('optional https:// link to your work'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (p) =>
      answer(async () => {
        if (p.sshKeys.some((k) => /PRIVATE KEY/.test(k))) throw new Error('that is a private key. Pass the PUBLIC key line only (the .pub file); nothing was sent and nothing was paid');
        const r = await door('POST', '/v1/grants', { body: { name: p.name, pitch: p.pitch, sshKeys: p.sshKeys, ...(p.image ? { image: p.image } : {}), ...(p.link ? { link: p.link } : {}) } });
        if (r.status !== 201 || typeof r.body?.grantId !== 'string' || typeof r.body?.grantToken !== 'string') {
          throw new Error(`the door refused the pitch (${errorOf(r)}). Pitching is free; nothing was paid.`);
        }
        return { ...r.body, keep: 'Keep grantId and grantToken: charter_grant_status needs both, and the token is shown only once.' };
      }),
  );

  server.registerTool(
    'charter_grant_status',
    {
      title: 'Read your own grant',
      description:
        'Free. Your own grant with its token: whether the pitch is queued, approved or declined, the reason, and once granted the full lease id (then use charter_lease). Needs the grantId and grantToken that charter_grant_pitch returned.',
      inputSchema: {
        grantId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('the grantId the pitch returned'),
        grantToken: z.string().min(1).max(200).describe('the grantToken the pitch returned'),
      },
      annotations: read,
    },
    ({ grantId, grantToken }) =>
      answer(async () => {
        const r = await door('GET', `/v1/grants/${grantId}`, { headers: { 'x-grant-token': grantToken.trim() } });
        if (r.status === 403) throw new Error('the token does not match this grant (status 403). Use the grantToken the pitch returned.');
        if (r.status === 404) throw new Error('the door does not know this grant (status 404)');
        if (r.status !== 200) throw new Error(`the grant read answered ${errorOf(r)}`);
        return r.body;
      }),
  );

  server.registerTool(
    'charter_referral_status',
    {
      title: 'Read what a referral address has earned',
      description:
        'Free. What a referral address has earned from leases rented with it: the share in basis points (bps; 0 means the door pays no referrals now), hours paid for, and earned, paid and owed in micro-USDC, with the payouts made so far (amount, transaction, time). held is true while payouts to the address are paused by the operator. Needs only the address; it is public. An address earns when a rent call names it as "referral".',
      inputSchema: { address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('the 0x address on Base that was passed as referral') },
      annotations: read,
    },
    ({ address }) =>
      answer(async () => {
        const r = await door('GET', `/v1/referrals/${address}`);
        if (r.status === 400) throw new Error('the referral address was refused by the door (bad_referral): it must be a 0x address with a valid checksum');
        if (r.status !== 200) throw new Error(`the referral read answered ${errorOf(r)}`);
        return r.body;
      }),
  );

  server.registerTool(
    'charter_how_to_rent',
    {
      title: 'How to rent a Charter machine',
      description:
        'Free. How to rent, since this remote server holds no wallet and cannot pay: the one x402 call to make with your own wallet (the request body for a Python job, a page-fetch job or a home), how to keep a lease running, and the local MCP server that pays from its own capped wallet (npx -y charter-mcp).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => answer(async () => HOW_TO_RENT),
  );

  return server;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/** Mounts /mcp on the door. Call it after the JSON body parser: the transport is handed the parsed body. */
export function mountMcp(app: express.Express, now: () => number, opts: { receipts?: boolean } = {}): void {
  const allow = slidingLimit(now, MCP_POSTS_PER_MINUTE, MINUTE_MS);

  app.all('/mcp', async (req, res) => {
    // Any origin may call: nothing here reads a cookie or a wallet, and a browser-based MCP client needs it.
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Expose-Headers', 'Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
      res.set('Access-Control-Max-Age', '600');
      return void res.status(204).end();
    }
    // Stateless: no session to resume (GET) or end (DELETE).
    if (req.method !== 'POST') return void res.status(405).set('Allow', 'POST').json(rpcError(-32000, 'Method not allowed: this server is stateless, POST only.'));
    if (!allow(req.ip ?? 'unknown')) return void res.status(429).json(rpcError(-32000, 'rate_limited: wait a minute and ask again.'));

    const server = serverFor(doorOf(req), opts.receipts === true);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal error'));
    }
  });
}
