#!/usr/bin/env node
// One paid tick through the door with an @x402/fetch client, so a facilitator that keeps a
// catalog (PayAI's /discovery/resources) sees the tick route's Bazaar declaration echoed in a
// settled payment and lists it. Spends exactly one tick (0.007 USDC on the live host) from a
// Base wallet holding USDC; the facilitator submits the transfer, so the wallet needs no ETH.
//
//   node scripts/bazaar-tick.mjs --dry-run                  # reads offers, probes a 402, pays nothing
//   BAZAAR_KEY_FILE=~/keys/bazaar-payer node scripts/bazaar-tick.mjs
//   ... --rent      # the same through POST /v1/rent: open and tick 0 in one paid call (lists the rent route)
//
// BAZAAR_KEY_FILE: a file holding one secp256k1 private key as 0x + 64 hex (never put the key
// in the environment or on the command line). CHARTER_DOOR_URL overrides the door. The dry run
// probes the lease DRY_RUN_LEASE names (any lease the door has seen; default: the first batch
// lease from 2026-10-20, whose tick index is past so the probe is refused before any payment
// when the index is wrong, and challenged with a 402 when it is right).
import { existsSync, readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const DOOR = (process.env.CHARTER_DOOR_URL ?? 'https://charter.mainnet.toonprotocol.dev').replace(/\/$/, '');
const CATALOG = 'https://facilitator.payai.network/discovery/resources';
const dryRun = process.argv.includes('--dry-run');
const viaRent = process.argv.includes('--rent');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** The one live offer that runs python, or exit. */
async function pickOffer() {
  const offers = await json(await fetch(`${DOOR}/v1/offers`));
  if (!Array.isArray(offers) || offers.length === 0) {
    console.error('no live offer: the host is down, nothing can be rented');
    process.exit(1);
  }
  const offer = offers.find((o) => o.images.includes('charter-job-python')) ?? offers[0];
  log(`offer ${offer.offerId.slice(0, 12)}… tick ${offer.tickPrice} micro-USDC per ${offer.intervalSeconds} s, ${offer.leases} paid leases so far`);
  return offer;
}

/** Whether the catalog lists a route of this door. */
async function listed(payTo) {
  const q = payTo ? `?payTo=${encodeURIComponent(payTo)}&limit=100` : '?limit=100';
  const res = await fetch(`${CATALOG}${q}`);
  if (!res.ok) return `catalog answered ${res.status}`;
  const { items = [], pagination } = await json(res);
  const mine = items.filter((i) => typeof i.resource === 'string' && i.resource.startsWith(DOOR));
  return mine.length ? `LISTED: ${mine.map((i) => i.resource).join(', ')}` : `not listed: the catalog has ${pagination?.total ?? items.length} entries for payee ${payTo}, none from this door`;
}

const door = await json(await fetch(`${DOOR}/v1/door`));
log(`door pays to ${door.payTo} on ${door.network}`);
const offer = await pickOffer();

const job = { offerId: offer.offerId, python: { script: `print("charter bazaar ${viaRent ? 'rent' : 'tick'}")\n` } };

if (dryRun && viaRent) {
  const res = await fetch(`${DOOR}/v1/rent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) });
  log(`probe POST /v1/rent (python job) -> ${res.status}`);
  const header = res.headers.get('payment-required');
  if (res.status === 402 && header) {
    const required = b64json(header);
    log(`accepts ${required.accepts.map((a) => `${a.scheme} ${a.amount} to ${a.payTo} on ${a.network}`).join('; ')}`);
    log(`bazaar declaration ${required.extensions?.bazaar ? 'present' : 'MISSING'}`);
  } else {
    log('no 402 to inspect:', JSON.stringify(await json(res)));
  }
  log(await listed(door.payTo));
  log('dry run over, nothing paid');
  process.exit(0);
}

if (dryRun) {
  const lease = process.env.DRY_RUN_LEASE ?? '811904795c4b68fcfd8a9020dfc03e50';
  const res = await fetch(`${DOOR}/v1/leases/${lease}/ticks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 1 }) });
  log(`probe POST /v1/leases/${lease.slice(0, 8)}…/ticks {index: 1} -> ${res.status}`);
  const header = res.headers.get('payment-required');
  if (res.status === 402 && header) {
    const required = b64json(header);
    log(`accepts ${required.accepts.map((a) => `${a.scheme} ${a.amount} on ${a.network}`).join('; ')} (this lease's own price snapshot, not the live offer above)`);
    log(`bazaar declaration ${required.extensions?.bazaar ? 'present' : 'MISSING'}; description: ${required.resource?.description ?? ''}`);
    log('an exact-only client would pick:', required.accepts.find((a) => a.scheme === 'exact') ? 'exact (one authorization, no deposit)' : 'nothing');
  } else {
    log('no 402 to inspect:', JSON.stringify(await json(res)));
  }
  log(await listed(door.payTo));
  log('dry run over, nothing paid');
  process.exit(0);
}

const keyFile = process.env.BAZAAR_KEY_FILE;
if (!keyFile) {
  console.error('BAZAAR_KEY_FILE is not set (or pass --dry-run)');
  process.exit(2);
}
if (!existsSync(keyFile)) {
  console.error(`${keyFile} does not exist. Make one with: node deploy/door/new-claim-key.mjs ${keyFile} (prints the address to fund with USDC on Base)`);
  process.exit(2);
}
const account = privateKeyToAccount(readFileSync(keyFile, 'utf8').trim());
log(`paying from ${account.address}; this spends one tick, ${offer.tickPrice} micro-USDC, and nothing more`);

// Exact only: one EIP-3009 authorization for the tick, no channel deposit to refund later.
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }] });

let id;
if (viaRent) {
  // One paid call: the door opens the lease and pays tick 0; a non-2xx never settles.
  const rent = await paidFetch(`${DOOR}/v1/rent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) });
  const body = await json(rent);
  if (rent.status !== 200) {
    console.error(`rent refused ${rent.status}:`, JSON.stringify(body), '(a non-2xx never settles; nothing was charged)');
    // An x402 v2 refusal carries its reason in a header, not the body.
    for (const h of ['payment-required', 'payment-response']) {
      const v = rent.headers.get(h);
      if (!v) continue;
      try {
        const d = JSON.parse(Buffer.from(v, 'base64').toString());
        console.error(`${h}:`, JSON.stringify({ error: d.error, errorReason: d.errorReason, errorMessage: d.errorMessage, success: d.success }));
      } catch {
        console.error(`${h}: (not base64 JSON)`);
      }
    }
    process.exit(1);
  }
  id = body.leaseId;
  const receipt = rent.headers.get('payment-response');
  const settled = receipt ? decodePaymentResponseHeader(receipt) : undefined;
  log(`rented lease ${id}: paidIntervals ${body.paidIntervals}; settle tx ${settled?.transaction ?? '(no receipt header)'} on ${settled?.network ?? '?'}`);
  if (settled?.transaction) log(`https://basescan.org/tx/${settled.transaction}`);
} else {
const opened = await json(await fetch(`${DOOR}/v1/leases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) }));
if (!opened.leaseId || opened.state !== 'awaiting_first_tick') {
  console.error('open refused, nothing paid:', JSON.stringify(opened));
  process.exit(1);
}
id = opened.leaseId;
log(`lease ${id} opened (free); paying tick 0 within the host's grace`);

const tick = await paidFetch(`${DOOR}/v1/leases/${id}/ticks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 0 }) });
const body = await json(tick);
if (tick.status !== 200) {
  console.error(`tick refused ${tick.status}:`, JSON.stringify(body), '(a non-2xx never settles; nothing was charged)');
  process.exit(1);
}
const receipt = tick.headers.get('payment-response');
const settled = receipt ? decodePaymentResponseHeader(receipt) : undefined;
log(`tick 0 paid: paidIntervals ${body.paidIntervals}; settle tx ${settled?.transaction ?? '(no receipt header)'} on ${settled?.network ?? '?'}`);
if (settled?.transaction) log(`https://basescan.org/tx/${settled.transaction}`);
}

// The script finishes inside its one interval. No second tick, ever: maxIntervals is 1.
let lease;
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  lease = (await json(await fetch(`${DOOR}/v1/leases/${id}`))).lease;
  if (lease?.state === 'done' || lease?.state === 'closed') break;
}
log(`lease ${lease?.state ?? 'unknown'}${lease?.closedReason ? ` (${lease.closedReason})` : ''}, ${lease?.outputParts ?? 0} output part(s)`);
if (lease?.outputParts) {
  // A part is an envelope {part, parts, data}: data is the job's JSON, base64.
  const part = await json(await fetch(`${DOOR}/v1/leases/${id}/output/0`));
  const out = typeof part.data === 'string' ? b64json(part.data) : part;
  log(`job exit ${out.exitCode ?? '?'}, stdout: ${JSON.stringify(out.stdout ?? out)}`);
}
log(await listed(door.payTo));
log('done; a catalog that lists from settled payments may take a while to show the entry: rerun with --dry-run to check');
