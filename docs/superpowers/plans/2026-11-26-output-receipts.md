# Output Receipts and Renter-Paid Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The door signs a receipt over a job's output hash or a home's declared hash, and a home command pins a file to Pinata from the home's own wallet, with Charter hosting no content.

**Architecture:** A pure module builds and verifies receipts. Two door routes use it with a signer built from the door's payer key. The home's `charter-x402` gains `receipt` and `pin`. The remote MCP gains one read tool. Docs and the registration file point at it.

**Tech Stack:** TypeScript on Node 22, Express, viem (EIP-191 `signMessage` / `verifyMessage`), `@x402/fetch` + `@x402/evm` in the home script, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-26-output-receipts-design.md`

## Global Constraints

- No em dashes in any file.
- The door never signs free text: every receipt field is hex, an integer, a CID shape or the enum `job` | `declared`.
- A receipt never carries the lease id, only `leaseRef = sha256("charter-lease:" + leaseId)` hex.
- Message is exactly `"Charter receipt v1\n" + JSON.stringify(receipt)`, signed EIP-191.
- Receipt key order: `v, kind, door, leaseRef, hostId, image, ticksPaid, intervalSeconds, payer, sha256, bytes, cid, at`; absent optionals left out.
- Charter stores no renter content beyond the output parts it already caches. No Pinata call from the door.
- Nothing is deployed, published or pushed by this plan.
- Tests: `npm test` and `npm run typecheck` clean at the end of every task.

## Review Focus

1. A receipt asked for while a lease's parts are only partly cached and the host is gone: answers the host's failure, never signs a partial hash. (Task 2)
2. A job with zero-byte output (`outputParts` 0): 409 `no_output`, never a receipt over the empty string. (Task 2)
3. A declared body with an extra key, upper-case hex, or a `cid` that is free text: 400, nothing signed. (Tasks 1, 2)
4. `pin` on an empty file, a directory or a missing path: refused before any network call. (Task 4)
5. Pinata's 402 naming a non-USDC asset, another network, or a price over the cap: nothing signed. (Task 4)

---

### Task 1: The receipt module

**Files:**
- Create: `src/door/receipts.ts`
- Test: `src/door/receipts.test.ts`

**Interfaces (produces):**

```ts
export const RECEIPT_PREFIX = 'Charter receipt v1\n';
export type ReceiptKind = 'job' | 'declared';
export interface Receipt {
  v: 1; kind: ReceiptKind; door: string; leaseRef: string; hostId: string;
  image?: string; ticksPaid: number; intervalSeconds: number; payer?: string;
  sha256: string; bytes?: number; cid?: string; at: number;
}
export interface SignedReceipt { receipt: Receipt; message: string; signer: `0x${string}`; signature: `0x${string}` }
export interface ReceiptSigner { address: `0x${string}`; signMessage(a: { message: string }): Promise<`0x${string}`> }
export function leaseRefOf(leaseId: string): string;
/** Builds the receipt with keys in the fixed order, dropping undefined optionals. */
export function buildReceipt(f: Omit<Receipt, 'v'>): Receipt;
export function messageOf(r: Receipt): string;
export async function signReceipt(r: Receipt, s: ReceiptSigner): Promise<SignedReceipt>;
/** True only when `signature` is `signer`'s over `message`, the message has the prefix, and its JSON deep-equals `receipt`. */
export async function verifyReceipt(s: SignedReceipt): Promise<boolean>;
/** The declared body, or null: exactly the keys sha256 (64 lower hex), cid? (isCid), bytes? (non-negative safe integer). */
export function declaredBody(v: unknown): { sha256: string; cid?: string; bytes?: number } | null;
/** CIDv0 `Qm` + 44 base58btc chars, or CIDv1 `b` + 50 to 120 chars of [a-z2-7]. */
export function isCid(v: unknown): v is string;
```

- [ ] **Step 1: Write failing tests** in `src/door/receipts.test.ts`:
  - `messageOf` of a fixed receipt equals a literal string written out in the test (pins key order and prefix), with `payer`, `bytes`, `cid`, `image` absent then present.
  - `leaseRefOf('ab'.repeat(16))` is 64 hex, differs from the id, and does not contain it.
  - sign with `privateKeyToAccount` of a fixed test key, `verifyReceipt` true; flipping `receipt.sha256`, `message`, or `signer` makes it false.
  - `declaredBody`: accepts `{sha256}` and `{sha256,cid,bytes}`; rejects extra key `name`, upper-case hex, 63 hex, `bytes: -1`, `bytes: 1.5`, `cid: 'hello world'`, arrays, null.
  - `isCid`: accepts `QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG` and `bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy`; rejects `Qm` + 43 chars, `b` + upper case, a URL.
- [ ] **Step 2:** `node --test --import tsx src/door/receipts.test.ts`, expect failures on the missing module.
- [ ] **Step 3: Implement** the module. `verifyReceipt` uses viem `verifyMessage`.
- [ ] **Step 4:** same command passes; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `receipts: build, sign and verify a receipt`.

### Task 2: The door routes

**Files:**
- Modify: `src/door/ledger.ts` (`DoorLease.image?: string`; `open()` takes `image?`), `src/door/server.ts`, `src/door/main.ts`
- Test: `src/door/server.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `DoorDeps.receiptSigner?: ReceiptSigner`; `DoorDeps.doorUrl?: string` (default `https://charterhome.dev`, the receipt's `door`); routes `GET` and `POST /v1/leases/:id/receipt` answering a `SignedReceipt`; `GET /v1/door` field `receiptSigner`.

- [ ] **Step 1: Write failing tests** (follow the file's existing app-building helpers; pass a `receiptSigner` from a fixed test key):
  - both `ledger.open` call sites store `image`: a python lease's record has `image === PYTHON_IMAGE`.
  - GET on a done python lease with 2 parts: 200, `verifyReceipt` true, `kind: 'job'`, `sha256` equals the hash of the two decoded parts joined, `bytes` their length, `ticksPaid` and `intervalSeconds` from the ledger, no `leaseId` substring anywhere in the body, `leaseRef === leaseRefOf(id)`.
  - GET twice: identical bodies (same `at`), second call makes no host call; file `<dataDir>/receipts/<id>.json` exists with mode 0600.
  - GET with every part already cached and the host api throwing: still 200.
  - GET with part 0 cached, part 1 not, host throwing: the output route's failure status, no receipt file. (Review Focus 1)
  - GET refusals: unknown id 404; home lease 409 `home_lease`; `ticksPaidByRenter` 0 gives 409 `unpaid`; not done, or `outputParts` 0, gives 409 `no_output`. (Review Focus 2)
  - `payer` present for an ordinary payer; left out when it equals `fundAddress` or `allowAddress`.
  - POST on a running paid home with `{sha256, cid, bytes}`: 200, `kind: 'declared'`, fields echoed, verifies; nothing written under `receipts/`.
  - POST refusals: job lease 409 `not_a_home`; state not `running` or `paidThrough` past gives 409 `not_running`; unpaid 409 `unpaid`; bad bodies from Task 1 give 400 `bad_request`. (Review Focus 3)
  - POST 61 times within an hour on one lease: the 61st is 429 `rate_limited`.
  - `GET /v1/door` carries `receiptSigner`; without the dep both routes answer the app's 404 and the field is absent.
- [ ] **Step 2:** run `node --test --import tsx src/door/server.test.ts`, expect the new tests to fail.
- [ ] **Step 3: Implement.**
  - Ledger: `image` written at open from the `JobSpec` the route already built.
  - Server: mount both routes only when `deps.receiptSigner` is set, after the `/v1/leases` GET limiter. Reuse `known`, `leaseStatus`, `failRead`, `partFile`, and factor the body of `GET …/output/:part` into `const readPart = (id, part): Promise<{ part, parts, data }>` used by both.
  - Job route order: stored receipt file, then ledger checks (`home_lease`, `unpaid`), then cached-parts-only path (part 0's `parts`, all files present), else `leaseStatus` and `readPart` for each part in order.
  - Declared limiter: `Map<leaseId, ReturnType<typeof slidingLimit>>` built with `slidingLimit(now, 60, HOUR_MS)`.
  - `main.ts`: `receiptSigner` from `privateKeyToAccount(payerKey(env))` (`{ address, signMessage }`).
- [ ] **Step 4:** the file's tests pass; `npm test` and `npm run typecheck` clean.
- [ ] **Step 5: Commit** `door: signed receipts for a job's output and a home's declared hash`.

### Task 3: The remote MCP tool

**Files:**
- Modify: `src/door/mcp.ts`
- Test: `src/door/mcp.test.ts`

- [ ] **Step 1: Failing tests:** `charter_receipt` is listed (seven tools); with a stub door answering 200 it returns the signed receipt unchanged; with 409 `no_output` it answers the tool error text naming `no_output`.
- [ ] **Step 2:** run the file, expect failure.
- [ ] **Step 3: Implement** `server.registerTool('charter_receipt', …)`: input `leaseId` (32 hex, same schema as `charter_lease`), `readOnlyHint: true`, calls `door('GET', '/v1/leases/<id>/receipt')`. Description says: free; a signed statement that the host returned this output for a paid lease; hosts are not vetted; verify against `receiptSigner` at `/v1/door`; a home declares its own with `charter-x402 receipt` inside the home.
- [ ] **Step 4:** file passes; `npm test`, typecheck clean.
- [ ] **Step 5: Commit** `mcp: charter_receipt`.

### Task 4: The home commands

**Files:**
- Modify: `jobs/home/x402-rent.mjs`, `jobs/home/home.test.mjs` (usage line only)
- Test: `jobs/home/x402-rent.test.mjs`

**Interfaces (produces, exported for tests):**

```js
export const PINATA_402 = 'https://402.pinata.cloud';
/** Of what Pinata's 402 offers: only exact, USDC on Base, to `payTo`, at most `max`. */
export function onlyPinataExact(payTo, max);
/** { amount: bigint, payTo } from an x402 v2 `payment-required` header, or throws. Only an exact USDC-on-Base offer counts. */
export function pinPrice(header);
/** Reads a regular, non-empty file: { bytes: Buffer, sha256: hex }. Throws on a directory, a missing path or zero bytes. */
export function fileToPin(path);
/** deps: { fetch, paidFetch(payTo, max), saveDir, log }. Returns { cid, url, tx? }. */
export async function pinFile({ bytes, name, base, max }, deps);
/** POSTs the declared body to the door and saves the answer to <saveDir>/<sha256>.json. Returns the signed receipt. */
export async function declareReceipt({ door, leaseId, sha256, bytes, cid }, deps);
```

- [ ] **Step 1: Failing tests** with stub `fetch`es:
  - `fileToPin`: hashes a temp file; throws for a directory, a missing path and an empty file, with no fetch made. (Review Focus 4)
  - `pinPrice`: reads `amount` 1200 and `payTo` from a header built in the test; throws when the only offer is another asset, another network, or scheme `upto`. (Review Focus 5)
  - `onlyPinataExact`: filters as `onlyDoorExact` does.
  - `pinFile`: unpaid probe 402 with price 20000 and `max` 10000 throws before `paidFetch` is called; at price 1200 it calls `paidFetch` on `…/v1/pin/public?fileSize=<n>`, POSTs multipart `file`, `network=public`, `name` to the returned `url`, returns the `cid`; a paid answer of 402 throws with the wallet address to fund in the message; an upload answer without `data.cid` throws.
  - `declareReceipt`: POSTs `{sha256, bytes, cid}` to `/v1/leases/<id>/receipt`, writes the file, returns the body; a non-200 throws with the door's error name.
- [ ] **Step 2:** `node --test jobs/home/x402-rent.test.mjs`, expect failure.
- [ ] **Step 3: Implement.** In `main`, before the `open`/`renew` guard: `receipt <file>` (hash, `declareReceipt`, print JSON) and `pin <file>` (`account(env)`, `CHARTER_X402_MAX_PIN` default `10000`, `PINATA_402_URL` override, `pinFile`, then `declareReceipt` unless `--no-receipt`). `flags()` must accept one positional path for these two commands and `--no-receipt` as a boolean. Save dir `~/.charter/receipts` (0700). Print after a pin: the CID, `https://gateway.pinata.cloud/ipfs/<cid>`, and one line that the public gateway can take minutes and may rate-limit. Update the header comment and the usage string; update the usage regex in `home.test.mjs` only if it no longer matches.
- [ ] **Step 4:** file passes; `npm test` clean.
- [ ] **Step 5: Commit** `home: charter-x402 receipt and pin`.

### Task 5: Docs and the listing

**Files:**
- Modify: `web/llms.txt`, the agents page source under `web/`, `README.md`, `src/door/openapi.ts`, `docs/ops.md`, `web/well-known/agent-registration.json`
- Test: `src/live-urls.test.ts`, the openapi test if one covers route lists

- [ ] **Step 1:** add both routes to `openapi.ts` with the `SignedReceipt` schema; extend any test that enumerates paths.
- [ ] **Step 2:** add a "Receipts" section to `llms.txt`, the agents page and the README saying, in plain words: what a job receipt means and that hosts are not vetted; that a declared receipt is the renter's own claim with the door's timestamp; that pinning is a purchase from Pinata, a third party, paid by the renter, public for twelve months, never seen by Charter; and the verify snippet:

```js
import { verifyMessage } from 'viem';
const { message, signer, signature } = signed;
const door = await (await fetch('https://charterhome.dev/v1/door')).json();
const ok = signer.toLowerCase() === door.receiptSigner.toLowerCase()
  && await verifyMessage({ address: signer, message, signature });
const receipt = JSON.parse(message.slice(message.indexOf('\n') + 1));
```

- [ ] **Step 3:** `docs/ops.md`: where receipts are stored (`<dataDir>/receipts/`), that the payer key signs them, and the rollout steps from the spec.
- [ ] **Step 4:** add `{ "name": "receipts", "endpoint": "https://charterhome.dev/v1/door" }` to the registration file's services.
- [ ] **Step 5:** `grep -rn '—' web/llms.txt README.md docs/ops.md` on the added lines finds none; `npm test`, `npm run typecheck`, `npm run build:web` clean.
- [ ] **Step 6: Commit** `docs: receipts and renter-paid pinning`.
