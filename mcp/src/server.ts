/**
 * The Charter MCP server, over stdio: the tools an agent needs to rent a machine and pay for it itself.
 *
 * An MCP client cannot sign an x402 payment, so this process runs beside it, holds one Base key in a
 * file (USDC only; no ETH, the facilitator submits each transfer) and pays Charter's door once per paid
 * tool call. The rules that bound the money are in core.ts.
 *
 * stdout belongs to the MCP transport; every log line here goes to stderr.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { createPublicClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { z } from 'zod';
import {
  BASE,
  BASE_USDC,
  CapError,
  DEFAULT_DOOR,
  PayError,
  extend,
  lease,
  microToUsdc,
  onlyDoorExact,
  output,
  rent,
  runJob,
  usdcToMicro,
  type Answer,
  type Deps,
  type SpendBook,
} from './core.js';

export const VERSION = '0.1.0';

export interface Options {
  door: string;
  keyFile: string;
  spendFile: string;
  /** Micro-USDC. */
  maxHour: bigint;
  maxDay: bigint;
  baseRpc?: string;
  /** false: never make a key; with no key file the paid tools stay off. */
  makeKey: boolean;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): Options {
  const dir = join(homedir(), '.charter');
  const v = (k: string): string | undefined => env[k]?.trim() || undefined;
  return {
    door: (v('CHARTER_DOOR_URL') ?? DEFAULT_DOOR).replace(/\/+$/, ''),
    keyFile: v('CHARTER_MCP_KEY_FILE') ?? join(dir, 'mcp.key'),
    spendFile: v('CHARTER_MCP_SPEND_FILE') ?? join(dir, 'mcp-spend.json'),
    maxHour: usdcToMicro(v('CHARTER_MAX_USDC_PER_HOUR') ?? '0.01'),
    maxDay: usdcToMicro(v('CHARTER_MAX_USDC_PER_DAY') ?? '0.25'),
    ...(v('CHARTER_BASE_RPC') ? { baseRpc: v('CHARTER_BASE_RPC')! } : {}),
    makeKey: v('CHARTER_MCP_NO_NEW_KEY') === undefined,
  };
}

const KEY = /^0x[0-9a-fA-F]{64}$/;
const GET_TIMEOUT_MS = 30_000;
/** A rent waits for the host to open the lease over an onion hop, which has taken 15 s and more. */
const PAY_TIMEOUT_MS = 90_000;

/** The key in the file; made first (mode 600, never overwriting) when the file is absent and `make` is set. */
export function loadKey(file: string, make: boolean): `0x${string}` | undefined {
  if (!existsSync(file)) {
    if (!make) return undefined;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, `0x${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      // Another server started at the same moment and made it first: use that one.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  const key = readFileSync(file, 'utf8').trim();
  if (!KEY.test(key)) throw new Error(`${file} must hold one private key: 0x and 64 hex digits`);
  return key as `0x${string}`;
}

const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 10_000;

/** Runs `fn` holding `<file>.lock` (a directory, so making it is atomic), since two MCP clients may run two servers on one book. */
function locked<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        // A server killed while holding it must not block the book for good.
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // Gone already: try again.
      }
      if (Date.now() > until) throw new CapError(`the spend book ${file} is locked by another server; nothing was paid. Try again.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Removed as stale by another server: nothing to undo.
    }
  }
}

/**
 * The day's spend in one small JSON file, changed only under a lock and rewritten whole. A file that
 * exists but cannot be read is an error, never "nothing spent": a damaged book must not reopen the cap.
 */
export function fileSpendBook(file: string, maxDay: bigint): SpendBook {
  const read = (): Record<string, unknown> => {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      o = undefined;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.values(o).some((v) => typeof v !== 'string' || !/^\d{1,15}$/.test(v))) {
      throw new CapError(`the spend book ${file} is damaged, so today's spend is unknown and nothing is paid. Delete the file to start the day's count again.`);
    }
    return o as Record<string, unknown>;
  };
  const of = (o: Record<string, unknown>, d: string): bigint => (typeof o[d] === 'string' ? BigInt(o[d] as string) : 0n);
  const write = (d: string, total: bigint): void => {
    // Only today is kept: yesterday's total bounds nothing.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ [d]: (total < 0n ? 0n : total).toString() }), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    maxDay,
    spent: (d) => of(read(), d),
    reserve: (d, micro) =>
      locked(file, () => {
        const next = of(read(), d) + micro;
        if (micro < 0n || next > maxDay) return false;
        write(d, next);
        return true;
      }),
    release: (d, micro) => locked(file, () => write(d, of(read(), d) - micro)),
  };
}

async function body(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error)?.message ?? String(e)}` }], isError: true });

const SSH_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+( .*)?$/;

export interface Built {
  server: McpServer;
  address: string | undefined;
}

/** The server with its tools, not yet connected to a transport. `fetchFn` is the network (a test hands in a fake door). */
export function build(o: Options, log: (line: string) => void, fetchFn: typeof fetch = fetch): Built {
  const key = loadKey(o.keyFile, o.makeKey);
  const account = key ? privateKeyToAccount(key) : undefined;
  const spend = fileSpendBook(o.spendFile, o.maxDay);

  const origin = new URL(o.door).origin;
  const agent = { 'user-agent': `charter-mcp/${VERSION}` };

  /**
   * Every request this server makes: to the door's own origin only, never following a redirect (a
   * redirect could carry a signed payment to another host), and never waiting for ever.
   */
  const guarded = (ms: number, onSend?: (signed: boolean) => void): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (new URL(req.url).origin !== origin) throw new Error(`refusing a request to ${new URL(req.url).origin}: this server talks to ${origin} only`);
      onSend?.(req.headers.has('payment-signature') || req.headers.has('x-payment'));
      return fetchFn(new Request(req, { redirect: 'error', signal: AbortSignal.timeout(ms) }));
    }) as typeof fetch;

  const get = async (path: string): Promise<Answer> => {
    const res = await guarded(GET_TIMEOUT_MS)(`${o.door}${path}`, { headers: agent });
    return { status: res.status, body: await body(res) };
  };

  // Where payments go is read from the door once, and nothing is signed until it is known.
  let payee: Promise<string> | undefined;
  const payTo = (): Promise<string> =>
    (payee ??= (async () => {
      const info = await get('/v1/door');
      if (info.status !== 200 || !/^0x[0-9a-fA-F]{40}$/.test(info.body?.payTo ?? '') || info.body.network !== BASE) {
        throw new Error(`GET /v1/door answered ${info.status}: cannot tell where payments go, nothing signed`);
      }
      return info.body.payTo as string;
    })().catch((e) => {
      payee = undefined;
      throw e;
    }));

  const pay = async (path: string, json: unknown, limit: bigint): Promise<Answer> => {
    let signed = false;
    let res: Response;
    try {
      const to = await payTo();
      // One client a call, so each signs at most what this call reserved (and never over the hourly cap).
      const paidFetch = wrapFetchWithPaymentFromConfig(
        guarded(PAY_TIMEOUT_MS, (s) => void (signed ||= s)),
        {
          schemes: [{ network: BASE, client: new ExactEvmScheme(account!) }],
          policies: [onlyDoorExact(to, limit < o.maxHour ? limit : o.maxHour)],
        },
      );
      res = await paidFetch(`${o.door}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...agent }, body: JSON.stringify(json) });
    } catch (e) {
      log(`paid call ${path} failed ${signed ? 'after' : 'before'} a payment was signed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      throw new PayError(
        `${String((e as Error)?.message ?? e).slice(0, 300)}. ${signed ? 'A signed payment had left, so it is counted against the day in case it settles.' : 'No payment was signed; nothing was charged.'}`,
        signed,
      );
    }
    const out: Answer = { status: res.status, body: await body(res), signed };
    const receipt = res.headers.get('payment-response');
    if (receipt) {
      try {
        const d = decodePaymentResponseHeader(receipt) as { transaction?: string; errorReason?: string };
        if (d.transaction) out.tx = d.transaction;
        if (d.errorReason) out.reason = d.errorReason;
      } catch {
        // A receipt that does not decode changes nothing about the answer.
      }
    }
    // An x402 v2 refusal says why in the 402's own header, not the body.
    const refusal = res.status === 402 ? res.headers.get('payment-required') : null;
    if (refusal && !out.reason) {
      try {
        const d = JSON.parse(Buffer.from(refusal, 'base64').toString('utf8'));
        if (typeof d.error === 'string') out.reason = d.error.slice(0, 120);
      } catch {
        // No reason to show.
      }
    }
    log(`paid call ${path} -> ${out.status}${out.tx ? ` tx ${out.tx}` : ''}${out.reason ? ` (${out.reason})` : ''}`);
    return out;
  };

  const deps: Deps = {
    get,
    ...(account ? { pay } : {}),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spend,
    maxHour: o.maxHour,
  };

  const balance = async (): Promise<string> => {
    const client = createPublicClient({ chain: base, transport: http(o.baseRpc) });
    const raw = await client.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account!.address] });
    return microToUsdc(raw);
  };

  const caps = () => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      maxUsdcPerHour: microToUsdc(o.maxHour),
      maxUsdcPerDay: microToUsdc(o.maxDay),
      spentTodayUsdc: microToUsdc(spend.spent(today)),
    };
  };

  const server = new McpServer({ name: 'charter', version: VERSION });
  const cost = 'Costs one interval of the cheapest machine: 0.007 USDC on the live host (see charter_offers), paid from this server\'s own wallet in USDC on Base.';

  server.registerTool(
    'charter_offers',
    {
      title: 'Charter machines on sale',
      description:
        'Free. The machines for rent on Charter right now: price per interval in USDC (0.007 an hour on the live host), CPU, memory, the job images each runs, and how many home slots it has. Charter rents a sandboxed machine by the hour with no account: a Python job, a page-fetch job, or a Linux home with SSH. Call this first to see the price before any paid tool.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const r = await get('/v1/offers');
        if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`GET /v1/offers answered ${r.status}`);
        return text({
          offers: r.body.map((x: any) => ({
            offerId: x.offerId,
            usdcPerInterval: /^\d+$/.test(String(x.tickPrice)) ? microToUsdc(x.tickPrice) : x.tickPrice,
            intervalSeconds: x.intervalSeconds,
            cpu: x.cpu,
            memoryMiB: x.memoryMiB,
            images: x.images,
            home: x.home ?? null,
          })),
          docs: `${o.door}/agents`,
          ...caps(),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'charter_wallet',
    {
      title: 'Charter payer wallet',
      description:
        'Free. The wallet this server pays Charter from: its address, its USDC balance on Base, the spending caps, what has been spent today, and how to fund it. Call this when a paid tool is refused, or to tell your operator where to send USDC.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        if (!account) {
          return text({ address: null, paidTools: 'off', why: `no key at ${o.keyFile} and CHARTER_MCP_NO_NEW_KEY is set. Put a key there (0x and 64 hex digits, mode 600) or unset the variable to have one made.`, ...caps() });
        }
        const usdc = await balance().catch((e: Error) => `unavailable (${e.message.slice(0, 80)})`);
        return text({
          address: account.address,
          usdcOnBase: usdc,
          ...caps(),
          keyFile: o.keyFile,
          fund: `Send USDC on Base (chain id 8453, token ${BASE_USDC}) to ${account.address}. No ETH is needed. 0.007 USDC buys one hour; 1 USDC is about 6 days of a home. Keep only what the rent needs in this wallet: the key is a plain file on this machine.`,
          pays: 'Only Charter: exact USDC on Base, to the payee the door names, within the caps above. The operator changes the caps with CHARTER_MAX_USDC_PER_HOUR and CHARTER_MAX_USDC_PER_DAY.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'charter_run_python',
    {
      title: 'Run a Python script on a rented machine',
      description: `PAID. ${cost} Runs your Python 3 script once in a sandbox on a rented machine and returns its stdout, stderr and exit code. NumPy is installed; there is no network and no other package; the script is at most 8 KiB. Most scripts finish in seconds. If it is still running when the wait ends, the leaseId comes back and charter_lease collects the output for free.`,
      inputSchema: {
        script: z.string().min(1).max(8192).describe('the Python 3 source, at most 8192 bytes'),
        waitSeconds: z.number().int().min(10).max(240).optional().describe('how long to wait for the job before handing back the leaseId (default 40, under most clients\' 60 s tool timeout)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ script, waitSeconds }) => {
      try {
        if (Buffer.byteLength(script, 'utf8') > 8192) throw new Error('the script is over 8192 bytes; nothing was paid');
        return text(await runJob(deps, { python: { script } }, waitSeconds ?? 40));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'charter_fetch_pages',
    {
      title: 'Fetch pages in a headless browser through a hidden exit',
      description: `PAID. ${cost} Loads up to five http or https pages in a headless browser on a rented machine, through an exit on the Anyone network so the site sees neither you nor the host, and returns each page's text. Useful when a page needs JavaScript or your own address is refused. Slow (a page can take a minute) and some sites refuse shared exits. If it is still running when the wait ends, charter_lease collects the output for free.`,
      inputSchema: {
        urls: z.array(z.string().url().regex(/^https?:\/\//i)).min(1).max(5).describe('one to five http or https URLs'),
        waitSeconds: z.number().int().min(10).max(240).optional().describe('how long to wait for the job before handing back the leaseId (default 40, under most clients\' 60 s tool timeout; pages often need longer, so expect to collect with charter_lease)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ urls, waitSeconds }) => {
      try {
        return text(await runJob(deps, { urls }, waitSeconds ?? 40));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'charter_rent_home',
    {
      title: 'Rent a Linux home with SSH',
      description: `PAID. ${cost} Opens a Linux box of your own (Debian, 1 CPU, 1 GiB memory, a 2 GiB disk kept 7 days after the lease ends, user "tenant", no root) and pays its first interval. Pass 1 to 8 SSH PUBLIC keys; the key set is the home's identity, so the same keys open the same disk again. Read this before renting: SSH is reachable only at an onion address on the Anyone network, so whoever logs in needs an Anyone client; all outbound traffic leaves through Anyone and is slow; the live host has two home slots and an open answers busy when both are taken. After renting, call charter_lease about once a minute until it shows the SSH address, and charter_extend before the paid time runs out.`,
      inputSchema: {
        sshKeys: z.array(z.string().max(1023)).min(1).max(8).describe('SSH public key lines (ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa). Public keys only: never a private key.'),
        image: z.enum(['charter-home', 'charter-hermes']).optional().describe('charter-home (default) is a plain box; charter-hermes has Hermes Agent preinstalled'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ sshKeys, image }) => {
      try {
        const keys = sshKeys.map((k) => k.trim());
        const bad = keys.find((k) => !SSH_KEY.test(k));
        if (bad !== undefined) {
          throw new Error(
            /PRIVATE KEY/.test(bad)
              ? 'that is a private key. Pass the PUBLIC key line only (the .pub file); nothing was sent or paid'
              : 'each key must be one public key line starting with ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa; nothing was paid',
          );
        }
        const rented = await rent(deps, { home: { sshKeys: keys, ...(image ? { image } : {}) } });
        return text({
          ...rented,
          next: 'Call charter_lease with this leaseId about once a minute until it shows ssh (the onion address is published within about a minute). Pay more time with charter_extend before paidThrough; a home that lapses keeps its disk 7 days and opens again with the same keys.',
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'charter_lease',
    {
      title: 'Read a Charter lease',
      description:
        'Free. The state of a lease opened by this server: running, done or closed, the paid time left, a home\'s SSH address once published, and a finished job\'s output (a Python job\'s stdout, stderr and exit code, or a fetch job\'s page text).',
      inputSchema: { leaseId: z.string().regex(/^[0-9a-f]{32}$/).describe('the 32 hex character leaseId a paid tool returned') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ leaseId }) => {
      try {
        const { view } = await lease(deps, leaseId);
        if ((view.state === 'done' || view.state === 'closed') && view.outputParts > 0) return text({ lease: view, output: await output(deps, leaseId, view.outputParts) });
        return text({ lease: view });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'charter_extend',
    {
      title: 'Pay more time on a lease',
      description:
        'PAID. Pays the next intervals of a running lease, one payment each (0.007 USDC an hour on the live host), from this server\'s wallet. Use it to keep a home running: pay before the paid time runs out, ideally half an hour early. Stops at the first refused payment and reports what was paid. A lease that has closed cannot be extended; a home opens again with the same keys.',
      inputSchema: {
        leaseId: z.string().regex(/^[0-9a-f]{32}$/).describe('the leaseId to pay for'),
        hours: z.number().int().min(1).max(24).describe('how many intervals to pay now, 1 to 24. The door refunds nothing, so pay only what you will use.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ leaseId, hours }) => {
      try {
        return text(await extend(deps, leaseId, hours));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return { server, address: account?.address };
}

export async function run(env: NodeJS.ProcessEnv): Promise<void> {
  const log = (line: string): void => void process.stderr.write(`charter-mcp: ${line}\n`);
  const o = optionsFromEnv(env);
  const { server, address } = build(o, log);
  await server.connect(new StdioServerTransport());
  log(`connected: door ${o.door}, wallet ${address ?? 'none (free tools only)'}, at most ${microToUsdc(o.maxHour)} USDC an hour and ${microToUsdc(o.maxDay)} a day`);
}
