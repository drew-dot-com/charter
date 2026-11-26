#!/usr/bin/env -S node --disable-warning=UNDICI-EHPA
// Rents and keeps a Charter home with nothing but a Base wallet: plain x402 calls to the door, `exact`
// only. Each hour is one USDC authorization: no deposit, no channel, no TOON node, and no ETH (the
// facilitator submits the transfer). In a home it is /usr/local/bin/charter-x402; anywhere else, run this
// file with Node 22 beside `npm install @x402/fetch @x402/evm viem`.
//
//   charter-x402 open --keys <file of SSH public keys> [--image charter-home]   from outside: open + first hour
//   charter-x402 renew [--lease <id>] [--max-intervals <n>] [--once]             in the box: pay each hour when due
//   charter-x402 status [--lease <id>]                                           free: state and paid-through
//   charter-x402 address                                                         the wallet to fund
//   charter-x402 receipt <file> [--lease <id>] [--cid <cid>]                      free: the door signs the file's hash
//   charter-x402 pin <file> [--lease <id>] [--no-receipt]                         pay Pinata to pin the file, then the receipt
//
// CHARTER_X402_KEY_FILE: a file holding one private key as 0x + 64 hex (default ~/.charter/x402.key; never
// the environment, never the command line). `address` makes one when the file is absent.
// CHARTER_X402_MAX_TICK: the most one hour may cost, micro-USDC (default 20000 = 0.02 USDC). A dearer 402
// is never signed. CHARTER_DOOR_URL overrides the door. `renew` reads CHARTER_LEASE_ID, set in every home.
//
// `receipt` moves no money: the door signs a statement that the holder of this lease declared this SHA-256 at
// this time (a claim of yours with the door's timestamp, not proof of where the file came from). `pin` buys a
// public pin from Pinata, a third party: the file is readable by anyone for twelve months, Charter never sees
// it, and the wallet above pays (0.10 USDC per GiB, floor 0.001). CHARTER_X402_MAX_PIN: the most one pin may
// cost, micro-USDC (default 10000 = 0.01 USDC, about 100 MiB). Receipts are kept in ~/.charter/receipts.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = 'eip155:8453';
/** The most one hour may cost by default, micro-USDC (0.02 USDC). */
export const DEFAULT_MAX_TICK = 20000n;
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULT_DOOR = 'https://charterhome.dev';
const LEASE_ID = /^[0-9a-f]{32}$/;
/** After a failed try: a minute, doubling to ten while the tries keep failing, so a dry wallet does not spend the lease's free reads. */
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 10 * 60_000;
/** The longest one sleep: the paid time is read again after it, so a tick paid by someone else is seen. */
const NAP_MS = 10 * 60_000;

/**
 * The payment policy: of what a 402 offers, only `exact` in USDC on Base, to the door's own payee, at no
 * more than `maxTick`. Nothing left means nothing is signed.
 */
export function onlyDoorExact(payTo, maxTick) {
  return (_version, reqs) =>
    reqs.filter(
      (r) =>
        r.scheme === 'exact' &&
        r.network === BASE &&
        String(r.asset).toLowerCase() === BASE_USDC.toLowerCase() &&
        String(r.payTo).toLowerCase() === String(payTo).toLowerCase() &&
        /^\d+$/.test(String(r.amount)) &&
        BigInt(r.amount) <= maxTick,
    );
}

export const PINATA_402 = 'https://402.pinata.cloud';
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
/** The look of a CID the door takes: v0, or v1 in base32 over a sha2-256 digest. The door checks the bytes. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})$/;

const isBaseUsdcExact = (r) =>
  r?.scheme === 'exact' && r.network === BASE && String(r.asset).toLowerCase() === BASE_USDC.toLowerCase() && /^\d+$/.test(String(r.amount));

/** The pin policy: of what Pinata's 402 offers, only `exact` in USDC on Base, to the payee its price named, at no more than `max`. */
export function onlyPinataExact(payTo, max) {
  return (_version, reqs) => reqs.filter((r) => isBaseUsdcExact(r) && String(r.payTo).toLowerCase() === String(payTo).toLowerCase() && BigInt(r.amount) <= max);
}

/** The price in an x402 v2 `payment-required` header: `{ amount, payTo }` of its exact USDC-on-Base offer. Throws when there is none. */
export function pinPrice(header) {
  let accepts;
  try {
    accepts = JSON.parse(Buffer.from(header, 'base64').toString('utf8')).accepts;
  } catch {
    throw new Error('Pinata answered no price (no readable payment-required header): nothing signed');
  }
  const offer = Array.isArray(accepts) ? accepts.find((r) => isBaseUsdcExact(r) && /^0x[0-9a-fA-F]{40}$/.test(String(r.payTo))) : undefined;
  if (!offer) throw new Error('Pinata offered no exact USDC price on Base: nothing signed');
  return { amount: BigInt(offer.amount), payTo: offer.payTo };
}

/** A regular, non-empty file: its bytes and their SHA-256 as hex. */
export function fileToPin(path) {
  if (!path) throw new Error('this command needs a file: charter-x402 receipt <file> | pin <file>');
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`no file at ${path}`);
  }
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size === 0) throw new Error(`${path} is empty`);
  const bytes = readFileSync(path);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Pins `bytes` through Pinata's x402 door: an unpaid POST answers the price, the paid POST answers a signed
 * upload address, and a multipart POST there answers the CID. Nothing is signed for a price over `max`.
 *
 * deps: `fetch`; `paidFetchFor(payTo, max)` answers a fetch that pays under that policy; `address` is the
 * wallet that pays. Returns `{ cid, url, price }`.
 */
export async function pinFile({ bytes, name, base = PINATA_402, max }, deps) {
  const door = `${base.replace(/\/$/, '')}/v1/pin/public?fileSize=${bytes.length}`;
  const probe = await deps.fetch(door, { method: 'POST' });
  if (probe.status !== 402) throw new Error(`Pinata's price probe answered ${probe.status}, not 402: nothing signed`);
  const price = pinPrice(probe.headers.get('payment-required'));
  if (price.amount > max) {
    throw new Error(`pinning ${bytes.length} bytes costs ${usdc(price.amount)} USDC, over the cap of ${usdc(max)} (CHARTER_X402_MAX_PIN, micro-USDC): nothing signed`);
  }
  // The paid leg may sign the quoted price and no more, even when the cap would allow it.
  const paid = await deps.paidFetchFor(price.payTo, price.amount)(door, { method: 'POST' });
  if (paid.status === 402) throw new Error(`payment refused by Pinata, nothing settled: does the wallet ${deps.address} hold ${usdc(price.amount)} USDC on Base?`);
  if (!paid.ok) throw new Error(`Pinata's door answered ${paid.status}: ${JSON.stringify(await body(paid)).slice(0, 200)}`);
  const signed = await body(paid);
  if (typeof signed.url !== 'string' || !/^https:\/\//.test(signed.url)) throw new Error('Pinata was paid but answered no upload address');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  form.append('network', 'public');
  form.append('name', name);
  const up = await deps.fetch(signed.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Pinata was paid but the upload answered ${up.status}: ${JSON.stringify(await body(up)).slice(0, 200)}`);
  const cid = (await body(up)).data?.cid;
  if (typeof cid !== 'string' || !CID.test(cid)) throw new Error('Pinata was paid and took the upload but answered no CID');
  return { cid, url: PINATA_GATEWAY + cid, price: price.amount };
}

/**
 * Asks the door for a declared receipt of `sha256` for `leaseId`, and keeps the signed answer at
 * `<saveDir>/<sha256>.json`. deps: `fetch`, `saveDir`. Returns `{ signed, file }`.
 */
export async function declareReceipt({ door, leaseId, sha256, bytes, cid }, deps) {
  const res = await deps.fetch(`${door}/v1/leases/${leaseId}/receipt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha256, ...(bytes !== undefined ? { bytes } : {}), ...(cid ? { cid } : {}) }),
  });
  const signed = await body(res);
  if (res.status !== 200 || typeof signed.signature !== 'string') {
    throw new Error(`the door signed no receipt (${signed.error ?? `status ${res.status}`}). not_running: the home's paid time has run out. unpaid: no interval is paid yet. not_a_home: only a home declares a hash.`);
  }
  mkdirSync(deps.saveDir, { recursive: true, mode: 0o700 });
  const file = join(deps.saveDir, `${sha256}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(signed, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return { signed, file };
}

async function body(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

const usdc = (micro) => (Number(micro) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';

/**
 * Pays a lease's ticks as they come due until the lease is over or `maxIntervals` are paid. A tick is due
 * half an interval before the paid time ends, as the door's docs ask. Returns why it stopped:
 * `max` | `once` | `over` (the lease closed or finished) | `unknown` (not a door lease) | `blocked`.
 *
 * deps: `get(path)` and `pay(path, json)` answer `{ status, body }`; `now()` is epoch ms; `sleep(ms)`;
 * `log(line)`; `paidThroughFile()` answers the box's own clock file as epoch ms, or undefined.
 */
export async function renewLoop({ leaseId, maxIntervals = 720, once = false }, deps) {
  const { get, pay, now, sleep, log, paidThroughFile = () => undefined } = deps;
  let paid = 0;
  let failures = 0;
  const retry = async () => {
    const ms = Math.min(RETRY_MS * 2 ** failures++, RETRY_MAX_MS);
    await sleep(ms);
  };
  const soon = () => `again in ${Math.round(Math.min(RETRY_MS * 2 ** failures, RETRY_MAX_MS) / 60_000)} min`;
  for (;;) {
    let st;
    try {
      st = await get(`/v1/leases/${leaseId}`);
    } catch (e) {
      log(`renew: the door did not answer (${String(e?.message ?? e).slice(0, 120)}), ${soon()}`);
      await retry();
      continue;
    }
    if (st.status === 404) {
      log('renew: the door does not know this lease. Only a lease opened through the door (POST /v1/rent or /v1/leases) is paid here; one opened over TOON is renewed with `charter renew`.');
      return 'unknown';
    }
    const lease = st.body?.lease;
    if (st.status !== 200 || !lease) {
      log(`renew: status read answered ${st.status}, ${soon()}`);
      await retry();
      continue;
    }
    if (lease.state === 'closed' || lease.state === 'done' || st.body.stopped) {
      log(`renew: the lease is over (${lease.closedReason ?? lease.state}${st.body.stopped ? ', stopped by the door' : ''}). Open again with the same keys to get the same disk back.`);
      return 'over';
    }
    const interval = (st.body.offer?.intervalSeconds ?? 3600) * 1000;
    // The box's own file is rewritten by the host on every tick, so it is never behind the door's cached read.
    const through = Math.max(lease.paidThrough ?? 0, paidThroughFile() ?? 0);
    const due = through - interval / 2;
    if (lease.state === 'running' && now() < due) {
      await sleep(Math.min(due - now(), NAP_MS));
      continue;
    }
    const index = lease.paidIntervals ?? 0;
    let t;
    try {
      t = await pay(`/v1/leases/${leaseId}/ticks`, { index });
    } catch (e) {
      // The x402 client throws when the policy left nothing to sign, or the wallet could not sign.
      log(`renew: tick ${index} not paid: ${String(e?.message ?? e).slice(0, 200)}; ${left(through, now())}, ${soon()}`);
      await retry();
      continue;
    }
    if (t.status === 200) {
      failures = 0;
      paid++;
      log(`renew: tick ${index} paid${t.tx ? ` (${t.tx})` : ''}; paid through ${utc(t.body.paidThrough)}; ${paid} of ${maxIntervals}`);
      if (once) return 'once';
      if (paid >= maxIntervals) {
        log(`renew: ${maxIntervals} intervals paid, stopping. Nothing pays after ${utc(t.body.paidThrough)} unless renew runs again.`);
        return 'max';
      }
      continue;
    }
    const error = t.body?.error ?? `status ${t.status}`;
    if (t.status === 403 && error === 'payer_blocked') {
      log('renew: this wallet is blocked by the door (a payment from it failed to settle). Pay from another wallet.');
      return 'blocked';
    }
    if (t.status === 409 && (error === 'lease_done' || error === 'not_running' || error === 'stopped')) {
      log(`renew: the lease is over (${error}).`);
      return 'over';
    }
    // 402 after a signed payment: the facilitator refused it, most often an empty wallet.
    const why = t.status === 402 ? `payment refused${t.reason ? ` (${t.reason})` : ''}: does the wallet hold USDC on Base?` : error;
    log(`renew: tick ${index} not paid: ${why}; ${left(through, now())}, ${soon()}`);
    await retry();
  }
}

function left(through, t) {
  const min = Math.round((through - t) / 60_000);
  return min > 0 ? `${min} min of paid time left` : 'the paid time has run out';
}

function keyFile(env) {
  return env.CHARTER_X402_KEY_FILE?.trim() || join(homedir(), '.charter', 'x402.key');
}

/** The wallet in the key file; made first (mode 400) when `make` is set and the file is absent. */
async function account(env, make = false) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const file = keyFile(env);
  if (!existsSync(file)) {
    if (!make) throw new Error(`no key at ${file}: run \`charter-x402 address\` to make one, then fund the address it prints with USDC on Base`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `0x${randomBytes(32).toString('hex')}\n`, { mode: 0o400, flag: 'wx' });
  }
  const key = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} must hold one private key: 0x and 64 hex digits`);
  return privateKeyToAccount(key);
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    if (a === '--once') out.once = true;
    else if (a === '--no-receipt') out['no-receipt'] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

export async function main(argv, env) {
  const [cmd, ...rest] = argv;
  // `receipt` and `pin` take one file before their flags.
  const takesFile = (cmd === 'receipt' || cmd === 'pin') && rest[0] !== undefined && !rest[0].startsWith('--');
  const f = flags(takesFile ? rest.slice(1) : rest);
  const door = (f.door ?? env.CHARTER_DOOR_URL ?? DEFAULT_DOOR).replace(/\/$/, '');
  const log = (line) => console.log(`${utc(Date.now())} ${line}`);
  const get = async (path) => {
    const res = await fetch(`${door}${path}`);
    return { status: res.status, body: await body(res) };
  };
  const leaseOf = () => {
    const id = f.lease ?? env.CHARTER_LEASE_ID;
    if (!id || !LEASE_ID.test(id)) throw new Error('no lease: pass --lease <32 hex> (in a home CHARTER_LEASE_ID is set)');
    return id;
  };

  if (cmd === 'address') {
    const a = await account(env, true);
    console.log(a.address);
    return 0;
  }
  if (cmd === 'status') {
    const st = await get(`/v1/leases/${leaseOf()}`);
    if (st.status !== 200) {
      console.log(JSON.stringify({ status: st.status, ...st.body }));
      return 1;
    }
    const { lease, offer } = st.body;
    console.log(JSON.stringify({
      state: lease.state,
      ...(lease.closedReason ? { closedReason: lease.closedReason } : {}),
      paidIntervals: lease.paidIntervals,
      paidThrough: lease.paidThrough ? utc(lease.paidThrough) : null,
      minutesLeft: lease.paidThrough ? Math.round((lease.paidThrough - Date.now()) / 60_000) : null,
      access: lease.access ?? null,
      tickPrice: offer?.tickPrice,
    }, null, 2));
    return 0;
  }
  if (cmd === 'receipt' || cmd === 'pin') {
    const path = takesFile ? rest[0] : undefined;
    const { bytes, sha256 } = fileToPin(path);
    const saveDir = join(homedir(), '.charter', 'receipts');
    // Before any money moves: a pin that is to end in a receipt needs a lease to ask for.
    const leaseId = cmd === 'pin' && f['no-receipt'] ? undefined : leaseOf();
    // `receipt --cid`: for a file pinned earlier whose receipt was not signed then.
    let cid = cmd === 'receipt' ? f.cid : undefined;
    if (cmd === 'pin') {
      const max = BigInt(env.CHARTER_X402_MAX_PIN?.trim() || '10000');
      const acct = await account(env);
      const { ExactEvmScheme } = await import('@x402/evm/exact/client');
      const { wrapFetchWithPaymentFromConfig } = await import('@x402/fetch');
      const paidFetchFor = (payTo, cap) =>
        wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: BASE, client: new ExactEvmScheme(acct) }], policies: [onlyPinataExact(payTo, cap)] });
      log(`pinning ${path} (${bytes.length} bytes, sha256 ${sha256}) through Pinata, paid from ${acct.address}, at most ${usdc(max)} USDC`);
      const pinned = await pinFile({ bytes, name: basename(path), base: env.PINATA_402_URL?.trim() || PINATA_402, max }, { fetch, paidFetchFor, address: acct.address });
      cid = pinned.cid;
      log(`pinned for ${usdc(pinned.price)} USDC: ${cid}`);
      log(`public for twelve months at ${pinned.url} (Pinata's public gateway can take minutes to show a new pin, and rate-limits)`);
      if (f['no-receipt']) {
        console.log(JSON.stringify({ sha256, bytes: bytes.length, cid, url: pinned.url }, null, 2));
        return 0;
      }
    }
    let got;
    try {
      got = await declareReceipt({ door, leaseId, sha256, bytes: bytes.length, cid }, { fetch, saveDir });
    } catch (e) {
      // The pin is paid and done either way: say so before the failure.
      if (cid) console.error(`charter-x402: the file is pinned (${cid}) but no receipt was signed. Ask again with: charter-x402 receipt ${path} --cid ${cid}`);
      throw e;
    }
    log(`receipt saved to ${got.file}: a declared receipt, your own claim with the door's timestamp${got.signed.receipt?.cid ? `. It names the CID in base16 (${got.signed.receipt.cid}): the same CID, in the form the door signs` : ''}`);
    console.log(JSON.stringify(got.signed, null, 2));
    return 0;
  }
  if (cmd !== 'open' && cmd !== 'renew') {
    console.error('usage: charter-x402 open --keys <file> [--image charter-home] | renew [--lease <id>] [--max-intervals <n>] [--once] | status [--lease <id>] | address | receipt <file> [--lease <id>] [--cid <cid>] | pin <file> [--lease <id>] [--no-receipt]');
    return 2;
  }

  const maxTick = env.CHARTER_X402_MAX_TICK?.trim() ? BigInt(env.CHARTER_X402_MAX_TICK.trim()) : DEFAULT_MAX_TICK;
  const acct = await account(env);
  const info = await get('/v1/door');
  if (info.status !== 200 || !/^0x[0-9a-fA-F]{40}$/.test(info.body?.payTo ?? '') || info.body.network !== BASE) {
    throw new Error(`GET /v1/door answered ${info.status}: cannot tell where payments go, nothing signed`);
  }
  const { ExactEvmScheme } = await import('@x402/evm/exact/client');
  const { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } = await import('@x402/fetch');
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: BASE, client: new ExactEvmScheme(acct) }],
    policies: [onlyDoorExact(info.body.payTo, maxTick)],
  });
  const pay = async (path, json) => {
    const res = await paidFetch(`${door}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
    const out = { status: res.status, body: await body(res) };
    const receipt = res.headers.get('payment-response');
    if (receipt) {
      try {
        const d = decodePaymentResponseHeader(receipt);
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
    return out;
  };
  log(`paying from ${acct.address} to ${info.body.payTo}, exact only, at most ${usdc(maxTick)} USDC a tick`);

  if (cmd === 'open') {
    if (!f.keys) throw new Error('open needs --keys <file of SSH public keys, one a line>');
    const sshKeys = readFileSync(f.keys, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const home = { sshKeys, ...(f.image ? { image: f.image } : {}) };
    const r = await pay('/v1/rent', { home, ...(f.offer ? { offerId: f.offer } : {}) });
    if (r.status !== 200) {
      console.error(`open refused ${r.status}: ${JSON.stringify(r.body)}${r.reason ? ` (${r.reason})` : ''}. A non-2xx never settles.${r.body?.leaseId ? ` The lease ${r.body.leaseId} exists unpaid: pay index 0 within 90 s or let it lapse.` : ''}`);
      return 1;
    }
    log(`home open: lease ${r.body.leaseId}, first interval paid${r.tx ? ` (${r.tx})` : ''}, paid through ${utc(r.body.paidThrough)}`);
    log(`next: GET ${door}/v1/leases/${r.body.leaseId} until lease.access.ssh is set (about a minute), then ssh in and run \`charter-x402 renew\` there, or keep paying from here with: charter-x402 renew --lease ${r.body.leaseId}`);
    console.log(JSON.stringify({ leaseId: r.body.leaseId, paidThrough: r.body.paidThrough }));
    return 0;
  }

  const max = f['max-intervals'] === undefined ? 720 : Number(f['max-intervals']);
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('--max-intervals must be a positive integer');
  const leaseId = leaseOf();
  // The box's clock file speaks for the box's own lease only.
  const file = leaseId === env.CHARTER_LEASE_ID ? env.CHARTER_PAID_THROUGH_FILE?.trim() : undefined;
  const why = await renewLoop(
    { leaseId, maxIntervals: max, once: f.once === true },
    {
      get,
      pay,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
      paidThroughFile: () => {
        if (!file) return undefined;
        try {
          const n = Number(readFileSync(file, 'utf8').trim());
          return Number.isFinite(n) ? n : undefined;
        } catch {
          return undefined;
        }
      },
    },
  );
  return why === 'blocked' || why === 'unknown' ? 1 : 0;
}

// Only when run, not when a test imports it. realpath: in the image the command is a symlink to this file.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`charter-x402: ${String(e?.message ?? e)}`);
      process.exit(1);
    },
  );
}
