# Referral Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rent request can name a referral address, the door accrues 10% of each paid hour to it, and pays it in USDC on Base once a day.

**Architecture:** Referral code sits beside the door's money path and only reads what it booked. A `ReferralStore` (JSON file) holds per-address totals and home bindings; a `PayoutLog` (append-only JSONL) holds every payout step; a payout runner runs before the daily sweep. The operator command only appends to an ops file that the running door applies, so two processes never write the same file.

**Tech Stack:** TypeScript (ESM, Node 22), Express, viem, `node:test` with tsx. Tests: `npm test`, one file: `node --test --import tsx src/door/<file>.test.ts`. Types: `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-11-25-referral-payouts-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Work on branch `feat/referral-payouts` in a worktree. `main` carries unpushed work; do not push, publish or deploy anything.
- No em dashes in any file (code comments, docs, copy).
- Amounts are micro-USDC `bigint` in code and decimal strings in JSON, as the door already does.
- Addresses are stored and compared in lower case.
- A request with no `referral` must behave exactly as before: the existing suite stays green after every task.
- Referral code must never fail a renter's request: every store write on the request path is wrapped, and a failure is logged with `console.error('charter-door referral accrual failed: ...')`.
- Alerts use the sweep's convention: `alert(m)` prints `charter-door ${m}`, and every referral message starts with `referral `.
- No test sends a real transaction or reads a real RPC.
- Docs and copy never claim a renter count or that a referrer has been paid.
- Defaults, verbatim: `CHARTER_REFERRAL_BPS` 0 (max 5000), `CHARTER_REFERRAL_MIN_PAYOUT` 100000, `CHARTER_REFERRAL_DAILY_CAP` 5000000, `CHARTER_REFERRAL_KEEP` 5000000, `CHARTER_REFERRAL_HOSTS` empty.

## Review Focus

1. Two leases of one new home open at once naming different referrers: exactly one is bound, and both leases' hours earn for the bound one (Task 5).
2. The door stops between writing an intent and learning the result: on the next start that address is held and nothing is resent (Task 3).
3. The rate is set back to 0 while money is owed: nothing new accrues, the sweep still holds the owed money back, and the read route still shows it (Tasks 4, 6).
4. A referral named on thousands of unpaid opens: no store entry is created until an hour is paid (Task 5).
5. An address with more than 50 payouts: the read route answers the newest 50 and totals stay right (Task 6).

---

## File Structure

| file | responsibility |
| --- | --- |
| `src/door/referrals.ts` (new) | `parseReferral`, `shareOf`, `ReferralStore` |
| `src/door/referral-payouts.ts` (new) | `PayoutLog`, `payoutOnce`, `holdOpenIntents`, `applyReferralOps`, `baseReferralSend` |
| `src/door/referrals-command.ts` (new) | `charter-door referrals ...` |
| `src/door/config.ts` | `referralConfig(env)` |
| `src/door/ledger.ts` | `DoorLease.referral`, `homeHasPaidHour` |
| `src/door/sweep.ts` | `reserve` and `before` hooks |
| `src/door/server.ts` | the `referral` field, accrual, binding, read route, advertising |
| `src/door/openapi.ts` | the field and the route |
| `src/door/main.ts` | wiring, the start-up refusal, the command |
| `mcp/src/core.ts`, `mcp/src/server.ts` | `referral` on paid tools, `charter_referral_status` |
| docs, `deploy/door/door.env.example`, `clawhub/`, `plugins/` | Task 9 |

---

### Task 1: Config and the pure rules

**Files:**
- Modify: `src/door/config.ts`, `src/door/config.test.ts`
- Create: `src/door/referrals.ts`, `src/door/referrals.test.ts`

**Interfaces (produces):**

```ts
// config.ts
export interface ReferralConfig { bps: number; minPayout: bigint; dailyCap: bigint; keep: bigint; hosts: Set<string> }
export function referralConfig(env: Record<string, string | undefined>): ReferralConfig;

// referrals.ts
/** undefined: none named. 'bad_referral': malformed, a mixed-case address failing its checksum, the zero address, or one of `refuse` (lower case). Else the address in lower case. */
export function parseReferral(v: unknown, refuse: ReadonlyArray<string | undefined>): string | undefined | 'bad_referral';
/** floor(paid * bps / 10000); on a host that is not listed, at most `fee`. */
export function shareOf(a: { paid: bigint; fee: bigint; bps: number; hostListed: boolean }): bigint;
```

- [ ] **Step 1: Write the failing tests**

`config.test.ts`: defaults as in Global Constraints; `CHARTER_REFERRAL_BPS=5001` throws, `=abc` throws; `CHARTER_REFERRAL_HOSTS` is a comma list of 64-hex host ids, trimmed and lower-cased into a Set; an entry that is not 64 hex throws.

`referrals.test.ts`:

```ts
test('parseReferral', () => {
  const a = '0x52908400098527886E0F7030069857D2E4169EE7'; // valid checksum
  assert.equal(parseReferral(undefined, []), undefined);
  assert.equal(parseReferral(a, []), a.toLowerCase());
  assert.equal(parseReferral(a.toLowerCase(), []), a.toLowerCase());
  assert.equal(parseReferral('0x52908400098527886E0F7030069857D2E4169Ee7', []), 'bad_referral'); // checksum broken
  assert.equal(parseReferral('0x' + '0'.repeat(40), []), 'bad_referral');
  assert.equal(parseReferral(a, [a.toLowerCase()]), 'bad_referral');
  for (const v of [null, 7, '', '0x12', {}, [a]]) assert.equal(parseReferral(v, []), 'bad_referral');
});
test('shareOf', () => {
  assert.equal(shareOf({ paid: 7000n, fee: 0n, bps: 1000, hostListed: true }), 700n);
  assert.equal(shareOf({ paid: 7000n, fee: 0n, bps: 1000, hostListed: false }), 0n);
  assert.equal(shareOf({ paid: 7700n, fee: 700n, bps: 1000, hostListed: false }), 700n);
  assert.equal(shareOf({ paid: 7700n, fee: 300n, bps: 1000, hostListed: false }), 300n);
  assert.equal(shareOf({ paid: 7001n, fee: 0n, bps: 1000, hostListed: true }), 700n); // floor
  assert.equal(shareOf({ paid: 7000n, fee: 0n, bps: 0, hostListed: true }), 0n);
});
```

- [ ] **Step 2: Run them, expect FAIL** (functions not defined).
- [ ] **Step 3: Implement.** `referralConfig` reuses `wholeEnv`. `parseReferral` uses viem's `isAddress` (strict: it checks the checksum of a mixed-case address).
- [ ] **Step 4: Run them, expect PASS.** Run `npm run typecheck`.
- [ ] **Step 5: Commit** `door: referral config and share rule`.

---

### Task 2: The referral store

**Files:**
- Modify: `src/door/referrals.ts`, `src/door/referrals.test.ts`

**Interfaces (produces):**

```ts
export const REFERRALS_FILE = 'referrals.json';
export interface ReferrerRecord { earned: bigint; paid: bigint; hours: number; /** why payouts are held */ held?: string; /** epoch ms owed last rose from 0 */ owedSince?: number }
export class ReferralStore {
  constructor(file: string);                       // a missing file is an empty store; unparseable JSON throws
  accrue(address: string, micro: bigint, at: number): void;   // hours += 1, earned += micro
  get(address: string): ReferrerRecord | undefined;
  all(): Array<{ address: string } & ReferrerRecord>;
  owed(address: string): bigint;                   // earned - paid, 0 for an unknown address
  totalOwed(): bigint;
  markPaid(address: string, micro: bigint): void;  // paid += micro; clears owedSince when owed reaches 0
  hold(address: string, reason: string): void;
  release(address: string): void;
  homeReferrer(homeId: string): string | undefined;
  /** False, and nothing changes, when the home is already bound. */
  bindHome(homeId: string, address: string): boolean;
  /** Operator only: sets or replaces. */
  setHome(homeId: string, address: string | undefined): void;
}
```

Written whole through a temp file and a rename, as `DoorLedger` does. bigints are stored as decimal strings.

- [ ] **Step 1: Write the failing tests:** accrue twice then `get` (earned, hours, `owedSince` is the first time); `markPaid` of all owed clears `owedSince`, a later accrue sets a new one; `hold`/`release`; `bindHome` returns true then false and keeps the first; `setHome(id, undefined)` unbinds; a new `ReferralStore` on the same file reads everything back; a missing file gives an empty store and `totalOwed() === 0n`; a file holding `{` throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `door: referral store`.

---

### Task 3: The payout log and runner

**Files:**
- Create: `src/door/referral-payouts.ts`, `src/door/referral-payouts.test.ts`

**Interfaces:**
- Consumes: `ReferralStore` (Task 2), `ReferralConfig` (Task 1), `utcDay` from `ledger.ts`, `errorReason` from `redact.ts`.
- Produces:

```ts
export const PAYOUTS_FILE = 'referral-payouts.jsonl';
export const REFERRAL_OPS_FILE = 'referral-ops.jsonl';
export interface Payout { id: string; to: string; amount: bigint; at: number; state: 'intent' | 'sent' | 'failed'; tx?: string; reason?: string }
export class PayoutLog {
  constructor(file: string);                              // lines that do not parse are skipped
  /** Appends an intent line and fsyncs it before returning. id: 16 random bytes, hex. */
  intent(to: string, amount: bigint, at: number): string;
  sent(id: string, tx: string, at: number): void;
  failed(id: string, reason: string, at: number): void;
  get(id: string): Payout | undefined;
  open(): Payout[];                                       // state 'intent'
  sentTo(address: string, limit: number): Payout[];       // newest first
  /** Sum of every intent written on that UTC day, whatever became of it. */
  intendedOn(day: string): bigint;
}
export type SendResult = { status: 'sent'; tx: `0x${string}` } | { status: 'reverted' } | { status: 'not_sent'; reason: string } | { status: 'unknown'; reason: string };
export type ReferralSend = (to: `0x${string}`, amount: bigint) => Promise<SendResult>;
export interface PayoutDeps {
  store: ReferralStore; log: PayoutLog; opsFile: string;
  cfg: Pick<ReferralConfig, 'minPayout' | 'dailyCap' | 'keep'>;
  balance: () => Promise<bigint>; send: ReferralSend;
  now: () => number; info: (s: string) => void; alert: (s: string) => Promise<void>;
}
/** Holds every address with an open intent (reason 'unresolved payout <id>') and alerts once per newly held address. */
export async function holdOpenIntents(d: Pick<PayoutDeps, 'store' | 'log' | 'alert'>): Promise<void>;
/** Applies ops-file lines not yet applied (the count applied is kept in `<opsFile>.applied`). Returns how many it applied. */
export function applyReferralOps(d: Pick<PayoutDeps, 'store' | 'log' | 'opsFile' | 'now'>): number;
/** One payout run. Never throws. */
export async function payoutOnce(d: PayoutDeps): Promise<void>;
export function baseReferralSend(rpcUrl: string, key: `0x${string}`): ReferralSend;
```

Ops lines (appended by Task 7's command): `{op:'release',address}`, `{op:'bind',homeId,address}`, `{op:'unbind',homeId}`, `{op:'resolve',id,as:'sent',tx}`, `{op:'resolve',id,as:'failed'}`. `resolve ... sent` calls `log.sent` and `store.markPaid`; `resolve ... failed` calls `log.failed(id, 'operator', ...)`. Neither releases the hold; `release` does. A resolve for an id that is not an open intent is skipped.

`payoutOnce`, in order: `applyReferralOps`; `holdOpenIntents`; read `balance()` once (a throw alerts `referral payout skipped: balance unreadable` and ends the run); then for each address with `owed >= minPayout` and not held, by `owedSince` ascending:
- `amount = owed`. If `log.intendedOn(today) + amount > dailyCap`: skip this address, continue with the next.
- If `balance - amount < keep`: alert `referral payout skipped: wallet short for <address>` and continue.
- `id = log.intent(...)`, then `send`:
  - `sent`: `log.sent`, `store.markPaid`, `balance -= amount`, info line with the tx.
  - `reverted`: `log.failed(id,'reverted')`, `store.hold(address,'transfer reverted')`, alert.
  - `not_sent`: `log.failed(id, reason)`, no hold, alert. It is retried next run.
  - `unknown`: leave the intent open, `store.hold(address, 'unresolved payout <id>')`, alert. Never resend.

`baseReferralSend`: `simulateContract` the USDC `transfer` first. A `ContractFunctionRevertedError` there is `reverted`; any other error there is `not_sent`. Then `writeContract`: a throw is `unknown`. Then `waitForTransactionReceipt`: `success` is `sent`, a reverted receipt is `reverted`, a throw or timeout is `unknown`. It has no unit test (it needs a chain); keep it under 40 lines.

- [ ] **Step 1: Write the failing tests** (fake `send`, temp dir):
  - an address owed 99999 is not paid; one owed 100000 is paid in full, the log has intent then sent, `owed` is 0;
  - order is `owedSince` ascending;
  - daily cap 250000, in `owedSince` order A owed 100000, B owed 200000, C owed 100000: A is paid, B does not fit and waits, C still fits and is paid; the next UTC day B is paid;
  - `balance - amount < keep`: no intent written, alert raised, the next address still considered;
  - `reverted`: failed line, held, still owed, next run does not pay it;
  - `not_sent`: failed line, not held, next run pays it;
  - `unknown`: intent stays open, held, and a second `payoutOnce` calls `send` zero times for that address (Review Focus 2);
  - a new `PayoutLog` and `ReferralStore` on the same files with an open intent: `holdOpenIntents` holds the address and `send` is never called for it (Review Focus 2);
  - `intendedOn` counts an intent that later failed;
  - ops: `resolve sent` marks paid and closes the intent but the address stays held until `release`; an ops line is applied once across two calls; `bind` and `unbind` change `homeReferrer`;
  - `send` throwing is treated as `unknown`; `payoutOnce` never throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** `door: referral payout log and runner`.

---

### Task 4: The sweep keeps owed money and runs after payouts

**Files:**
- Modify: `src/door/sweep.ts`, `src/door/sweep.test.ts`

**Interfaces (produces):** two optional fields on `SweepDeps`:

```ts
/** Run before each sweep. A throw is alerted and the sweep still runs. */
before?: () => Promise<void>;
/** Added to `keep` each time: money owed that must stay in the wallet. */
reserve?: () => bigint;
```

- [ ] **Step 1: Write the failing tests:** balance 20, keep 15, reserve 3: sends 2; reserve 6: sends nothing; `before` runs before `balance` is read (record the order); `before` throwing alerts and the sweep still sends; with neither field the existing tests are unchanged.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement in `sweepOnce`.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `door: sweep reserves owed referral money`.

---

### Task 5: The `referral` field, binding and accrual in the door

**Files:**
- Modify: `src/door/ledger.ts`, `src/door/server.ts`, `src/door/server.test.ts` (or a new `src/door/referral-routes.test.ts` built like `allowance-routes.test.ts`)

**Interfaces:**
- Consumes: `parseReferral`, `shareOf`, `ReferralStore`.
- Produces:

```ts
// ledger.ts
interface DoorLease { /** The address named at open, lower case. */ referral?: string }
open(o: { ...; referral?: string }): void;
/** True when any lease of this home has ticksPaidByRenter > 0. */
homeHasPaidHour(homeId: string): boolean;

// server.ts, on DoorDeps
/** Referral accrual. Left out: the field is still checked, recorded and echoed, and nothing accrues. */
referrals?: { store: ReferralStore; bps: number; hosts: Set<string> };
```

Rules, all from the spec:
- `POST /v1/rent` (in `rentGuard`, before the offers are read, on the unpaid challenge too) and `POST /v1/leases` (before the offers are read) run `parseReferral(body.referral, [deps.payer, x402 payTo, deps.fundAddress])` with each lower-cased. `'bad_referral'` answers `400 {error:'bad_referral'}`. A body holding only `referral` is `bad_request`, as any body with no job is today.
- Both pass the named address to `ledger.open`.
- **Who will earn** (a helper `earnerAtOpen(homeId, named)`): not a home: `named`. A home: `store.homeReferrer(homeId)` if bound, else `named` if `!ledger.homeHasPaidHour(homeId)`, else none. Without `deps.referrals` it is `named`.
- Both 2xx answers carry `referral: <earner>` when there is one, and omit the field otherwise.
- In `booked()`, on the success branch, around the existing `ledger.renterTick` call, inside one `try` that logs and swallows:
  1. before `renterTick`: `first = homeId !== undefined && !ledger.homeHasPaidHour(homeId)`;
  2. after it: if `first` and the lease has a `referral`, `store.bindHome(homeId, referral)`;
  3. earner: a home lease earns for `store.homeReferrer(homeId)` only; any other lease for its `referral`;
  4. no earner, or `bps === 0`, or the payer (lower case) equals `deps.fundAddress`: stop;
  5. `share = shareOf({ paid: offer.tickPrice + leaseFee, fee: leaseFee, bps, hostListed: hosts.has(offer.hostId) })`, both prices from the lease record; if `share > 0n`, `store.accrue(earner, share, now())`.
- `renterTick` itself and everything after it in `booked()` must run whether or not the referral code throws.

- [ ] **Step 1: Write the failing tests** (the door in `free-for-tests` mode with a fake host, as the existing route tests do):
  - rent with a valid referral: 200, answer echoes it lower-cased, the lease record has it, the store shows `earned 700`, `hours 1` (tick price 7000, bps 1000, host listed); a second tick makes it 1400;
  - `bad_referral` on rent (paid and on the unpaid challenge) and on `/v1/leases`, for a broken checksum, the zero address, the door's payer and the fund address; nothing opens on the host;
  - no referral: answers have no `referral` field and equal today's;
  - an open with a referral and no paid tick creates no store entry (Review Focus 4);
  - host not listed, fee 0: nothing accrues; fee 300: accrues 300;
  - payer equal to `fundAddress`: nothing accrues; payer equal to `allowAddress`: accrues;
  - `bps: 0`: recorded and echoed, nothing accrues;
  - a tick whose settle fails (use the test hook that fails settlement): nothing accrues;
  - home: first rent names A, pays: bound to A. A later rent of the same home naming B echoes A and accrues to A. A later rent naming nobody echoes A and accrues to A;
  - home with a paid hour and no binding: a rent naming A echoes no referral and accrues nothing; after `store.setHome(homeId, A)` the next hour accrues to A;
  - two leases of one new home opened before either is paid, naming A and B, then both paid: exactly one binding, and both hours accrued to it (Review Focus 1);
  - a store whose `accrue` throws: the tick still answers 200 and `ticksPaidByRenter` is 1.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new tests, then `npm test` and `npm run typecheck`, all PASS.**
- [ ] **Step 5: Commit** `door: referral on rent and open, accrual per paid hour`.

---

### Task 6: The read route and telling agents

**Files:**
- Modify: `src/door/server.ts`, `src/door/openapi.ts`, their tests

**Interfaces:**
- Consumes: `PayoutLog.sentTo` (Task 3). `DoorDeps.referrals` gains `log?: PayoutLog`.
- Produces:
  - `GET /v1/referrals/:address`, free, limited by the existing `allowGet`: `{ address, bps, hours, earned, paid, owed, held, payouts: [{ amount, tx, at }] }`. Amounts are decimal strings, `held` a boolean, `payouts` the newest 50 sent. An unknown address answers zeros and an empty list. A malformed address answers `400 bad_referral`. With no `deps.referrals`: zeros and `bps: 0`. The hold reason is never shown.
  - `GET /v1/door` gains `referral: { bps, how }` when `bps > 0`. `how`, verbatim: `Add "referral": "<0x address on Base>" to POST /v1/rent. That address earns a share of every hour the renter pays for, paid in USDC on Base. Read GET /v1/referrals/<address>.`
  - Each public offer gains `referralShare` (micro-USDC per hour as a string, from `shareOf` with that host and the current fee) when it is above 0.
  - `openapi.ts`: the `referral` property on the rent and open request bodies, `referral` on their answers, the new route, and one sentence in the rent description. Keep the x402scan shape the file documents.

- [ ] **Step 1: Write the failing tests:** the answers above for an unknown address, an address with accruals, a held address (`held: true`, no reason), a bad address; 51 sent payouts give 50, newest first, and `paid` is the sum of all 51 (Review Focus 5); with `bps: 0` and money owed the route still shows `owed` (Review Focus 3); `/v1/door` and `/v1/offers` carry the fields only when above 0; a listed host shows `referralShare: "700"` and an unlisted one with fee 0 has none; the OpenAPI document has the property and the path.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npm test` and `npm run typecheck` PASS.**
- [ ] **Step 5: Commit** `door: referral read route, share shown in offers and OpenAPI`.

---

### Task 7: Wiring, the start-up refusal and the operator command

**Files:**
- Modify: `src/door/main.ts`, `src/door/main` tests if any exist for start-up checks (else test the extracted function)
- Create: `src/door/referrals-command.ts`, `src/door/referrals-command.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
/** Throws when the rate is above 0, the grant fund is on (a fund token is set) and CHARTER_FUND_ADDRESS is not set. */
export function checkReferralFund(cfg: ReferralConfig, fundOn: boolean, fundAddress: string | undefined): void;
export function referralsCommand(args: string[], env: NodeJS.ProcessEnv, now: () => number, out: (m: string) => void): number;
```

`main.ts`: build `referralConfig(env)`; call `checkReferralFund`; always construct the store and the log in the data dir and pass `referrals: { store, bps, hosts, log }` to the door; call `holdOpenIntents` at start; pass the sweep `reserve: () => store.totalOwed()` and, only when `bps > 0`, `before: () => payoutOnce(...)`; apply ops every 60 s on an unref'd timer so a bind or release takes effect without waiting a day; add `if (process.argv[2] === 'referrals')` beside `unblock`. Log one start-up line stating the rate and the listed host count.

`referralsCommand` (data dir from `CHARTER_DATA_DIR`, exit codes as `unblockCommand`: 0 ok, 1 nothing there, 2 usage):
- no args or `list`: one line per address: address, earned, paid, owed, held reason; then open intents with their ids. Reads the store and log; writes nothing.
- `resolve <payoutId> sent <0x tx hash, 64 hex>` and `resolve <payoutId> failed`: refuses an id that is not an open intent.
- `release <address>`, `bind <homeId, 64 hex> <address>`, `unbind <homeId>`.
- Every writing form appends one line to `REFERRAL_OPS_FILE` and prints what the running door will do within a minute. It never writes the store or the log.

- [ ] **Step 1: Write the failing tests:** `checkReferralFund` throws only in the one case; each command form appends the right ops line and returns 0; bad arguments return 2 with a usage line; `resolve` of an unknown id returns 1; `list` prints owed and open intents from fixture files; a command line followed by `applyReferralOps` changes the store as stated.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npm test`, `npm run typecheck`, `npm run build` PASS.**
- [ ] **Step 5: Commit** `door: wire referral payouts, referrals command`.

---

### Task 8: charter-mcp

**Files:**
- Modify: `mcp/src/core.ts`, `mcp/src/server.ts`, their tests, `mcp/package.json`, `mcp/server.json`, `mcp/README.md`

**Interfaces (produces):**
- `charter_run_python`, `charter_fetch_pages` and `charter_rent_home` take an optional `referral` (a `0x` address) and send it in the rent body. A `400 bad_referral` from the door is reported in plain words.
- A new free tool `charter_referral_status` with input `{ address }` calls `GET /v1/referrals/<address>` and answers what it returns, amounts also shown in USDC.
- `charter_offers` passes `referralShare` through when the door sends it.
- One sentence added to the description of the three paid tools and to `charter_offers`, verbatim: `Pass referral (a 0x address on Base) and that address earns a share of every hour this lease pays for; see charter_referral_status.`
- Version `0.5.0` becomes `0.6.0` in `package.json`, `server.json` and wherever `VERSION` reads it. Nothing is published.

- [ ] **Step 1: Write the failing tests** in the style of the existing `core.test.ts` and `server.test.ts`: the rent body carries `referral` when given and omits it when not; the new tool calls the right path and formats the answer; a bad address is refused before any request.
- [ ] **Step 2: Run (`cd mcp && npm test`), expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Tests and the mcp build PASS.**
- [ ] **Step 5: Commit** `mcp: referral on paid tools, charter_referral_status (0.6.0)`.

---

### Task 9: Docs and examples

**Files:**
- Modify: `README.md`, `docs/demo.md`, `docs/ops.md`, `docs/env.md`, `deploy/door/door.env.example`, the skill text under `clawhub/charter-compute/` and `plugins/charter/`

Content:
- `README.md` and `docs/demo.md`: a "Referrals" section for an agent reader: the field, who earns (10% of each paid hour on hosts that show `referralShare`), when it is paid (daily, once 0.10 USDC is owed), how to check (`GET /v1/referrals/<address>`), that a renter may name its own address, that a home's referrer is set at its first paid hour and cannot be changed by a request, and that hours paid by the grant fund earn nothing.
- `docs/ops.md`: a "Referrals" runbook: the five variables, that payouts come out of the door's wallet and the operator tops it up at the current price, the daily run before the sweep, what each alert means (`referral payout skipped`, `transfer reverted`, `unresolved payout`), and the `charter-door referrals` forms with one example each. State plainly: for an unresolved payout, look the address up on a Base explorer before choosing `sent` or `failed`.
- `docs/env.md` and `door.env.example`: the five variables with their defaults; the example leaves the rate at 0 with a comment that the live door uses 1000 and lists its own host ids.
- `clawhub` and `plugins` skill text: the same short agent-facing section as the README. Do not bump or publish them.

- [ ] **Step 1: Write the text.**
- [ ] **Step 2: Check:** `grep -rn "—" README.md docs/demo.md docs/ops.md docs/env.md deploy/door/door.env.example clawhub plugins` finds no new em dash; every variable name and default matches Global Constraints; no sentence claims a referrer has been paid.
- [ ] **Step 3: `npm test` once more, PASS.**
- [ ] **Step 4: Commit** `docs: referrals for agents and operators`.

---

## Not in this plan

Publishing `charter-mcp`, ClawHub or the plugin; deploying the door; setting the live rate and host list; the first real payout; the x402 extension proposal. Each needs Drew.
