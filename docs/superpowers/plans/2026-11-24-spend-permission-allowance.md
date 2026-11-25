# Spend-Permission Allowance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person approves a Base spend permission once, and a new biller service keeps their agent's Charter home paid through the door's normal x402 tick route until they cancel, the agent stops it, or the home is gone.

**Architecture:** The door stores allowance requests and signed permissions (a JSONL store like `GrantStore`), serves the approval page and exposes token-guarded biller routes. A new container, `charter-allow`, modelled on `charter-fund`, holds the spender key: each cycle it pulls up to 24 ticks from the person's account into its own wallet with `SpendPermissionManager.spend`, then pays the home's tick with `door.pay` exactly as the fund's paymaster does. The door's tick route, ledger and settlement do not change.

**Tech Stack:** TypeScript (Node 22, `node --test` via tsx), express 5, viem, `@base-org/account` 2.6.0 (`/spend-permission` for node and browser), `@x402/fetch` through `src/fund/door-client.ts`, esbuild (`scripts/build-web.mjs`), Docker compose on the Hetzner box.

**Spec:** `docs/superpowers/specs/2026-11-24-spend-permission-allowance-design.md`

## Global Constraints

- Base mainnet `eip155:8453`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, SpendPermissionManager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`.
- Pin `@base-org/account` at exactly `2.6.0` (the version the spike proved).
- A permission's `period` must be exactly `2592000` (30 days). Suggested allowance = 744 ticks (31 days x 24) at the home's tick price; the person may lower it to no less than 720 ticks (30 days, ruling R8).
- A pull is at most 24 ticks minus the allowance's credit, capped by what the permission has left this period.
- The biller pays only the door, `exact` USDC to the door's payTo, at most 10000 micro-USDC a tick (`MAX_TICK_MICRO`).
- The biller never opens a fresh home and never names a different host's offer.
- Allowances are private: no list route; `allowanceId` is 32 random hex; the owner token is stored only as its sha256.
- One live allowance per home (`waiting`, `approved`, `active`, `short`, `spent_for_period`, `stopping` are live).
- An unapproved allowance expires 7 days after creation. A home lapsed (no paid time) for 7 days ends its allowance.
- Secrets live in 0400 files under `/root/charter-allow/secrets/`, never in env values, logs, health.json or the door.
- The door's tick route, `DoorLedger` and settlement code are not edited, except the `payer_blocked` exemption line.
- No em dashes in anything that ships (code comments, docs, page copy, commit messages).
- Never open or use Drew's personal wallet. Mainnet tests use a fresh test Base Account.

## Review Focus

1. **The approval page under the door's CSP.** The Caddy snippet sets `connect-src 'self'`; the Base Account SDK talks to `keys.coinbase.com` and RPC hosts. Expect the page to work in Chrome with the live header. Pinned by Task 6's header test and Task 9's live check.
2. **A pull that lands but whose answer is lost.** The biller restarts mid-pull. Expect no second pull for the same need: credit is reconciled from the permission's on-chain `currentPeriod.spend`. Pinned in Task 4 (`reconciles a pull whose answer was lost`).
3. **Two payers on one home.** The agent's own renew loop or a live grant pays the same index. Expect the biller to treat `duplicate`/`out_of_order` as nothing paid and keep its credit. Pinned in Task 4 (`keeps credit on out_of_order`).
4. **A person who empties their account after approving.** Expect state `short`, one retry an hour, no gas burnt on a doomed pull (simulate first). Pinned in Task 4 (`goes short without sending`).
5. **The agent stops while the biller holds credit.** Expect revoke on chain, then a USDC refund of exactly the credit to the account, then `ended` with reason `stopped`. Pinned in Task 4 (`stop revokes then refunds credit`).

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/door/allowances.ts` (new) | Allowance type, states and moves, `AllowanceStore` (JSONL), request and permission validation, views |
| `src/door/allowances.test.ts` (new) | Store and validation tests |
| `src/door/server.ts` (modify) | Public allowance routes, biller routes, grant keep-home hint, payer exemption |
| `src/door/allowance-routes.test.ts` (new) | Route tests |
| `src/door/main.ts` (modify) | `CHARTER_ALLOW_ADDRESS`, `CHARTER_ALLOW_TOKEN_FILE`, store wiring |
| `src/allow/chain.ts` (new) | Thin wrapper over `@base-org/account/spend-permission` + viem: status, simulate, pull, revoke, refund, balances |
| `src/allow/biller.ts` (new) | The pure cycle: one pass over allowances with injected door and chain |
| `src/allow/biller.test.ts` (new) | Cycle tests with fakes |
| `src/allow/state.ts` (new) | Biller state file (credit, in-flight pull, lapse times) |
| `src/allow/main.ts` (new) | Process: loop every 60 s, `stop <id>` / `status` commands, health.json |
| `deploy/allow/` (new) | Dockerfile, docker-compose.yml, allow.env.example, new-allow-key.mjs |
| `deploy/ops/charter-allow-check.sh` (new) | Health check + alert, like `charter-fund-check.sh` |
| `web/allow.html`, `web/allow.ts`, `web/allow-copy.ts` (+ tests) (new) | The approval page |
| `scripts/build-web.mjs` (modify) | `allow` entry point |
| `deploy/door/Caddy.snippet` (modify) | Own CSP for `/allow` |
| `mcp/src/core.ts`, `mcp/src/server.ts` (+ tests) (modify) | `charter_allowance_link`, `charter_allowance_status`, `charter_allowance_stop` |
| `web/llms.txt`, `web/agents.html`, `README.md`, `src/door/openapi.ts` (modify) | Docs |

---

### Task 1: The door's allowance store

**Files:**
- Create: `src/door/allowances.ts`
- Test: `src/door/allowances.test.ts`

**Interfaces:**
- Consumes: `homeIdOf`, `normalizeSshKeys` from `src/jobs.ts`.
- Produces:
  ```ts
  export type AllowanceState = 'waiting' | 'approved' | 'active' | 'short' | 'spent_for_period' | 'stopping' | 'refused' | 'ended' | 'expired';
  export const LIVE_STATES: AllowanceState[]; // waiting, approved, active, short, spent_for_period, stopping
  export const ALLOWED_MOVES: Record<AllowanceState, AllowanceState[]>;
  export type EndReason = 'cancelled' | 'stopped' | 'home_gone' | 'operator';
  export interface SignedPermission { // as @base-org/account returns it, numbers as JSON gives them
    signature: string; chainId: number; permissionHash?: string;
    permission: { account: string; spender: string; token: string; allowance: string; period: number; start: number; end: number; salt: string; extraData: string };
  }
  export interface Allowance {
    allowanceId: string; state: AllowanceState; homeId: string; sshKeys: string[]; image: 'charter-home' | 'charter-hermes';
    tickMicro: string; tokenHash: string; createdAt: number; updatedAt: number;
    signed?: SignedPermission; account?: string; reason?: string; endReason?: EndReason;
    remainingMicro?: string; periodEndsAt?: number; creditMicro?: string; hoursPaid: number; lastPullTx?: string; leaseId?: string;
  }
  export const EXPIRE_MS = 7 * 86_400_000;
  export const PERIOD_SECONDS = 2_592_000;
  export const SUGGESTED_TICKS = 744n; export const MIN_TICKS = 720n;
  export function validateRequest(body: unknown): { ok: true; sshKeys: string[]; image: Allowance['image'] } | { ok: false; error: string };
  export function validatePermission(body: unknown, o: { spender: string; tickMicro: bigint; now: number }): { ok: true; signed: SignedPermission } | { ok: false; error: string };
  export class AllowanceStore {
    constructor(file: string, now: () => number);
    add(r: { sshKeys: string[]; image: Allowance['image']; tickMicro: bigint }, token: string): Allowance;
    get(id: string): Allowance | undefined; all(): Allowance[];
    liveForHome(homeId: string): Allowance | undefined; // expires stale `waiting` ones first
    update(id: string, patch: Partial<Omit<Allowance, 'allowanceId' | 'homeId' | 'sshKeys' | 'image' | 'tokenHash' | 'createdAt'>>): Allowance; // throws BadMove
    tokenOk(id: string, token: string): boolean;
  }
  export function pageView(a: Allowance, spender: string): Record<string, unknown>; // no sshKeys, homeId, tokenHash, signature, leaseId
  export function ownerView(a: Allowance, spender: string): Record<string, unknown>; // pageView + homeId + leaseId
  export function billerView(a: Allowance): Record<string, unknown>; // everything but tokenHash
  ```
  Moves: `waiting -> approved | expired`; `approved -> active | refused | stopping`; `active -> short | spent_for_period | stopping | ended`; `short -> active | spent_for_period | stopping | ended`; `spent_for_period -> active | short | stopping | ended`; `stopping -> ended`; terminal: `refused`, `ended`, `expired`. `pageView` carries `allowanceId, state, image, tickMicro, suggestedMicro (744 x tick), minMicro (720 x tick), periodDays: 30, spender, account?, remainingMicro?, periodEndsAt?, creditMicro?, hoursPaid, lastPullTx?, reason?, endReason?, createdAt`.

- [ ] **Step 1: Write the failing tests** in `src/door/allowances.test.ts`:
  - `add makes a waiting allowance with a 32-hex id and hashed token`: `a.state === 'waiting'`, `/^[0-9a-f]{32}$/.test(a.allowanceId)`, `a.tokenHash !== token`, `store.tokenOk(a.allowanceId, token) === true`, `store.tokenOk(a.allowanceId, 'x') === false`.
  - `the store reloads from its file and survives a torn last line` (same pattern as `GrantStore`'s test).
  - `liveForHome expires a waiting allowance after 7 days`: with `now` advanced by `EXPIRE_MS + 1`, `liveForHome(homeId) === undefined` and `get(id).state === 'expired'`.
  - `update refuses a move the table does not allow`: `waiting -> active` throws `BadMove`.
  - `validateRequest takes keys and defaults the image`: `{ sshKeys: [key] }` gives `image: 'charter-home'`; `image: 'x'` fails; 9 keys fail.
  - `validatePermission accepts the spike's shape`: the JSON from the spike (account `0xCAa32aC8bD59741Fd6Aab2432Cc4802fd0DCa334`, spender set to the test spender, `period: 2592000`, `allowance: '5208000'`, `end: 281474976710655`) with `tickMicro 7000n` is ok.
  - `validatePermission refuses`: wrong `spender` (case-insensitive compare), wrong `token`, `chainId !== 8453`, `period !== 2592000`, `allowance < 24 x tick` (`'167999'` at 7000), `end <= now/1000`, a non-hex `signature`, `account` not a 0x address. Each gives `ok: false` with an error naming the field.
  - `pageView hides keys, homeId, token hash, signature and leaseId; ownerView adds homeId and leaseId`.
- [ ] **Step 2: Run to see them fail.** Run: `node --test --import tsx src/door/allowances.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/door/allowances.ts`** to the interfaces above, copying `GrantStore`'s JSONL append, reload and torn-line handling. `liveForHome` returns the newest allowance for the home in `LIVE_STATES`, after moving any `waiting` one older than `EXPIRE_MS` to `expired`.
- [ ] **Step 4: Run to see them pass.** Same command. Expected: all PASS.
- [ ] **Step 5: Commit.** `git add src/door/allowances.ts src/door/allowances.test.ts && git commit -m "door: allowance store, validation and views"`

### Task 2: The door's allowance routes

**Files:**
- Modify: `src/door/server.ts` (deps interface near line 66; new block after the grant routes; the `payer_blocked` line at 731)
- Modify: `src/door/main.ts` (beside `CHARTER_FUND_TOKEN_FILE` / `CHARTER_FUND_ADDRESS`, lines 123-198)
- Test: `src/door/allowance-routes.test.ts` (follow `grants-routes.test.ts`'s server setup)

**Interfaces:**
- Consumes: Task 1's exports; `DoorLedger.all()`; registry `homeHost(homeId)`; `GrantStore.all()`.
- Produces (HTTP):
  - `POST /v1/allowances` body `{ sshKeys, image? }` -> 201 `{ allowanceId, ownerToken, approveUrl, state: 'waiting', next: '/v1/allowances/<id>' }`. 400 bad body; 404 `no_home` unless the ledger has a lease with this `homeId` and `ticksPaidByRenter > 0` and `homeHost(homeId)` is set; 409 `{ error: 'already_live', allowanceId }` if `liveForHome` finds one; 429 by the same limiter as pitches. `tickMicro` = the home's latest lease's tick price plus fee (the door's `priceOf`). `approveUrl` = `${deps.allowPageUrl}?id=<id>`.
  - `GET /v1/allowances/:id` -> `pageView`; with `x-allowance-token`: `ownerView`, or 403 `bad_token`. 404 `not_found`.
  - `POST /v1/allowances/:id/permission` body = the SDK's permission object -> 200 `pageView` with `state: 'approved'`. 409 `not_waiting` unless state is `waiting`; 400 with `validatePermission`'s error.
  - `POST /v1/allowances/:id/stop` with `x-allowance-token` -> 200 `ownerView` with `state: 'stopping'` (from any live state but `waiting`, which goes straight to `expired`); 403 bad token; 409 `not_live`.
  - Biller routes behind `Authorization: Bearer <allowToken>` (copy `fundAuth`): `GET /v1/biller/allowances` -> `{ allowances: billerView[] }` for live states; `POST /v1/biller/allowances/:id` patch with fields `state, reason, endReason, account, remainingMicro, periodEndsAt, creditMicro, hoursPaid, lastPullTx, leaseId` (type-checked like `/v1/fund/grants/:id`; 409 `bad_move`); `GET /v1/biller/homes/:homeId` -> `{ leaseId: string | null, offerId: string | null, hostKnown: boolean, grantLive: boolean }` where `leaseId` is the ledger's newest lease for the home and `grantLive` is any grant on the home in `active` or `approved_waiting`.
  - Deps: `allowances?: AllowanceStore; allowToken?: string; allowAddress?: string; allowPageUrl?: string` (default `https://charterhome.dev/allow`).
  - Env: `CHARTER_ALLOW_ADDRESS` (0x, lowercased), `CHARTER_ALLOW_TOKEN_FILE`, `CHARTER_ALLOW_PAGE_URL`; the store at `join(dataDir, 'allowances.jsonl')`. Routes mount only when `allowances` and `allowAddress` are both set; biller routes need `allowToken` too.
  - The `payer_blocked` check skips `deps.allowAddress` as it skips `deps.fundAddress`.

- [ ] **Step 1: Write the failing route tests**, one per bullet above, plus:
  - `no_home for keys that never paid a tick` and `201 for a home with a paid tick`.
  - `a second request for the same home is 409 already_live naming the first`.
  - `the page view never carries sshKeys or homeId`.
  - `biller routes are 401 without the token`.
  - `the biller address is never payer_blocked`: book a `settle_failed` loss for the biller address, then a tick paid by it is not 403.
- [ ] **Step 2: Run to see them fail.** `node --test --import tsx src/door/allowance-routes.test.ts`. Expected: FAIL (404s).
- [ ] **Step 3: Implement the routes, deps and env wiring** as specified.
- [ ] **Step 4: Run the new tests and the whole door suite.** `node --test --import tsx 'src/door/**/*.test.ts'`. Expected: PASS, no existing test changed.
- [ ] **Step 5: Commit.** `git commit -m "door: allowance routes, biller routes, biller exempt from payer_blocked"`

### Task 3: The keep-home hint in a grant's owner view

**Files:**
- Modify: `src/door/server.ts` (`GET /v1/grants/:id`, owner branch)
- Test: `src/door/allowance-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 `AllowanceStore.add`, `liveForHome`; `GRANT_HOURS` (720) from `src/fund/paymaster.ts`.
- Produces: in the owner view only, when `g.state === 'active'` and `g.paidHours >= 672` and allowance routes are mounted: `keepHome: { allowanceId, ownerToken?, approveUrl, state, message }`. If `liveForHome(g.homeId)` exists it is reused (no `ownerToken`: it was handed out when made); otherwise one is created with a fresh token and that token is returned once. `message` = `"Your grant ends soon. To keep this home after it, send your person this link to approve a monthly allowance: <approveUrl>"`.

- [ ] **Step 1: Write the failing tests:** `no keepHome before hour 672`; `keepHome at hour 672 with a new allowance and its token`; `a second read reuses it and omits the token`; `the public grant view never has keepHome`.
- [ ] **Step 2: Run to see them fail.** Same command as Task 2. Expected: FAIL.
- [ ] **Step 3: Implement** in the owner branch only.
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "door: keep-home allowance link in a grant's last 48 hours"`

### Task 4: The biller's chain wrapper and cycle

**Files:**
- Create: `src/allow/chain.ts`, `src/allow/state.ts`, `src/allow/biller.ts`
- Test: `src/allow/biller.test.ts`
- Modify: `package.json` (add `"@base-org/account": "2.6.0"`)

**Interfaces:**
- Consumes: `DoorClient` and `doorClient()` from `src/fund/door-client.ts`; `tickDue`, `MAX_TICK_MICRO` from `src/fund/paymaster.ts`; Task 2's biller routes.
- Produces:
  ```ts
  // chain.ts
  export interface Chain {
    status(p: SignedPermission): Promise<{ isRevoked: boolean; isExpired: boolean; remainingMicro: bigint; periodSpentMicro: bigint; periodEndsAt: number }>;
    canPull(p: SignedPermission, micro: bigint): Promise<{ ok: true } | { ok: false; why: 'short' | 'over_limit' | 'invalid' | 'revoked'; detail: string }>; // eth_call of every prepared call from the spender
    pull(p: SignedPermission, micro: bigint): Promise<{ tx: string }>; // prepareSpendCallData(p, micro, spender), sends each call, waits for receipts
    revoke(p: SignedPermission): Promise<{ tx: string }>; // prepareRevokeCallData from the spender
    refund(to: string, micro: bigint): Promise<{ tx: string }>; // USDC transfer
    usdc(addr: string): Promise<bigint>; eth(addr: string): Promise<bigint>;
    spender: string;
  }
  export function baseChain(o: { key: `0x${string}`; rpcUrl: string }): Chain;
  // state.ts
  export interface AllowEntry { allowanceId: string; creditMicro: string; periodSpentSeen?: string; pullInFlight?: { micro: string; at: number }; lapsedSince?: number; nextTryAt?: number; tickInFlight?: { leaseId: string; index: number } }
  export interface AllowState { version: 1; entries: Record<string, AllowEntry> }
  export function loadState(file: string): AllowState; export function saveState(file: string, s: AllowState): void; // atomic, 0600; unreadable throws
  // biller.ts
  export const PULL_TICKS = 24n; export const LAPSE_END_MS = 7 * 86_400_000; export const SHORT_RETRY_MS = 3_600_000;
  export function pullNeed(creditMicro: bigint, tickMicro: bigint, remainingMicro: bigint): bigint; // 0 when credit >= tick; else min(24*tick - credit, remaining); 0 when that is < tick - credit
  export interface BillerDeps { door: DoorClient; chain: Chain; state: AllowState; save(): void; now(): number; problem(key: string, msg: string): void; stops: Set<string> }
  export async function cycle(d: BillerDeps): Promise<void>;
  ```
  One `cycle` reads `GET /v1/biller/allowances` and, for each, in this order:
  1. `approved`: `chain.status` + `canPull(p, tick)`. `invalid` -> `refused` with the detail; `short` -> `active` then `short` (approval stands); ok -> `active`. Post `account`, `remainingMicro`, `periodEndsAt`.
  2. `stopping`, or the id in `d.stops`: if `status` is not revoked, `revoke`; then if credit > 0, `refund(account, credit)`; post `ended` with `endReason` `stopped` (or `operator` for `d.stops`), `creditMicro: '0'`.
  3. live and `status.isRevoked`: refund credit, post `ended` / `cancelled`.
  4. Reconcile a `pullInFlight`: if `status.periodSpentMicro` grew past `periodSpentSeen`, add the in-flight amount to credit; clear it either way.
  5. `GET /v1/biller/homes/:homeId`. `hostKnown: false` -> refund, `ended` / `home_gone`. `grantLive` -> skip this allowance this cycle.
  6. Read the lease (`door.get('/v1/leases/<leaseId>')`). Closed or done: set `lapsedSince` if unset; if `now - lapsedSince > LAPSE_END_MS` -> refund, `ended` / `home_gone`; else re-open with `door.pay('/v1/rent', { offerId, home: { sshKeys }, image })` on the home's own `offerId` only (needs credit >= one tick, pulling first if not); a 409 `home_host_gone` -> refund, `ended` / `home_gone`.
  7. Running and `tickDue`: if credit < tick, compute `pullNeed`; 0 -> post `spent_for_period`; else `canPull` (`short` -> post `short`, `nextTryAt = now + SHORT_RETRY_MS`, nothing sent); else save `pullInFlight` + `periodSpentSeen`, `pull`, add to credit, post `lastPullTx`, `remainingMicro`, state `active`. Then save `tickInFlight`, `door.pay('/v1/leases/<id>/ticks', { index })`: 200 -> credit -= tick, `hoursPaid + 1`, clear `lapsedSince`; 409 `duplicate`/`out_of_order` -> nothing paid, credit unchanged.
  8. One allowance's error never stops the others (`problem(key, msg)` and move on).

- [ ] **Step 1: Write the failing tests** in `src/allow/biller.test.ts` with a fake `DoorClient` (records calls, scripted answers) and a fake `Chain`:
  - `pullNeed`: `(0n, 7000n, 5208000n) === 168000n`; `(7000n, 7000n, x) === 0n`; `(3000n, 7000n, 5208000n) === 165000n`; `(0n, 7000n, 50000n) === 50000n`; `(0n, 7000n, 6999n) === 0n`.
  - `activates an approved allowance it can pull from`; `refuses one the contract will not take`; `goes short without sending` (`canPull` short: no `pull`, no `door.pay`, state `short`, `nextTryAt` set).
  - `pulls a day of ticks then pays the due tick`: one `pull(168000n)`, one `door.pay` to `/ticks`, credit `161000`.
  - `pays from credit without pulling` when credit >= tick.
  - `does not pay while a grant is live`.
  - `keeps credit on out_of_order`.
  - `reconciles a pull whose answer was lost`: `pullInFlight` saved and `pull` throws; next cycle `status.periodSpentMicro` grew by the amount; credit includes it and no second `pull` is sent.
  - `stop revokes then refunds credit`: order of chain calls `revoke` then `refund(account, credit)`; state `ended`, `endReason: 'stopped'`.
  - `a revoke seen on chain ends it as cancelled and refunds`.
  - `re-opens a closed home on its own offer only`, and `ends as home_gone on 409 home_host_gone`, and `ends as home_gone after 7 days lapsed`.
  - `spent_for_period when the permission has less than a tick left`.
  - `one allowance throwing does not stop the next`.
- [ ] **Step 2: Run to see them fail.** `node --test --import tsx src/allow/biller.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `chain.ts`** with `@base-org/account/spend-permission` node exports (`getPermissionStatus`, `prepareSpendCallData`, `prepareRevokeCallData`, each with `{ rpcUrl }`) and viem wallet/public clients on `base`. `canPull` maps the contract's revert selectors: `0xfd1ebc88` -> `over_limit`, `0x282b9f97` -> `revoked`; a USDC transfer revert -> `short`; anything else -> `invalid`.
- [ ] **Step 4: Implement `state.ts` and `biller.ts`** to the interfaces and order above. Save state before every send (pull, tick, refund), as the paymaster does.
- [ ] **Step 5: Run to see them pass; run typecheck.** `node --test --import tsx src/allow/biller.test.ts && npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 6: Commit.** `git commit -m "allow: chain wrapper and biller cycle"`

### Task 5: The biller process and its deployment

**Files:**
- Create: `src/allow/main.ts`, `deploy/allow/Dockerfile`, `deploy/allow/docker-compose.yml`, `deploy/allow/allow.env.example`, `deploy/allow/new-allow-key.mjs`, `deploy/ops/charter-allow-check.sh`
- Modify: `deploy/ops/charter-ops-check.sh` (call the new check), `deploy/ops/charter-backup-stream.sh` (back up `/root/charter-allow/data/state.json`), `deploy/door/door.env.example` (the three new door env lines)
- Test: `src/allow/main.test.ts`

**Interfaces:**
- Consumes: Task 4's `cycle`, `baseChain`, `loadState`/`saveState`; `doorClient`, `addSecrets`/`redact` (copy from `src/fund/main.ts`).
- Produces: `node dist/allow/main.js` (loop every 60 s), `node dist/allow/main.js stop <allowanceId>` (writes `stops.json`), `node dist/allow/main.js status` (prints the state file and health). Env: `CHARTER_ALLOW_DATA_DIR=/data`, `CHARTER_ALLOW_KEY_FILE=/secrets/allow-key`, `CHARTER_ALLOW_TOKEN_FILE=/secrets/allow-token`, `CHARTER_ALLOW_RPC_URL_FILE=/secrets/rpc-url`, `CHARTER_ALLOW_DOOR_URL` (default `https://charterhome.dev`). `health.json` = `{ at, problems: [{ key, msg, at }], ethWei, usdcMicro }`; a problem `low_eth` when ETH < 0.0001.
- `charter-allow-check.sh` mirrors `charter-fund-check.sh` with home `/root/charter-allow` and alert key `allow`.

- [ ] **Step 1: Write the failing tests:** `stop writes stops.json and the loop reads it`; `health redacts the RPC URL and token`; `low ETH is a problem`; `an unreadable state file stops the process instead of starting fresh`.
- [ ] **Step 2: Run to see them fail.** `node --test --import tsx src/allow/main.test.ts`.
- [ ] **Step 3: Implement `main.ts` and the deploy files** by copying the fund's shapes (`deploy/fund/*`), with no judge key. `new-allow-key.mjs` writes a 0400 key and prints only the address.
- [ ] **Step 4: Run tests, typecheck, and build the image.** `npm test && npm run typecheck && docker compose -f deploy/allow/docker-compose.yml build`. Expected: PASS and an image `charter-allow:local`.
- [ ] **Step 5: Commit.** `git commit -m "allow: biller process, deploy files and ops check"`

### Task 6: The approval page

**Files:**
- Create: `web/allow.html`, `web/allow.ts`, `web/allow-copy.ts`, `web/allow-copy.test.ts`
- Modify: `scripts/build-web.mjs` (`entryPoints.allow`), `deploy/door/Caddy.snippet`

**Interfaces:**
- Consumes: Task 2's `GET /v1/allowances/:id` (`pageView`) and `POST /v1/allowances/:id/permission`.
- Produces: a page at `/allow?id=<allowanceId>`. `allow-copy.ts` exports pure helpers the page uses and the test pins:
  - `formatUsdc(micro: bigint): string`.
  - `hoursFor(allowanceMicro: bigint, tickMicro: bigint): number`.
  - `clampAllowance(input: string, minMicro: bigint, maxMicro: bigint): bigint | string`, where a string is the error to show.
  - `BEFORE_YOU_START: string`: the friction copy, naming the Coinbase sign-up with an email, the pop-up to allow, and one signature.
- The page flow:
  1. Read the view and show the home's price an hour, the suggested amount per 30 days (editable, from `minMicro` to `suggestedMicro`) and the spender address.
  2. Press 1 to connect (`createBaseAccountSDK({ appName: 'Charter', appChainIds: [8453] })`, then `eth_requestAccounts`).
  3. Press 2 to approve (`requestSpendPermission({ account, spender, token: USDC, chainId: 8453, allowance, periodInDays: 30, provider })`), then POST the result.
  4. After approval, show the state from the view, refreshing every 30 s.
  5. The cancel button (`requestRevoke`) sits behind `const CANCEL_TESTED = false` and is hidden until Task 9 step 2 passes.
- Caddy: a `@allow path /allow /allow.html /allow.js` matcher with its own `Content-Security-Policy` that adds what the SDK needs: `connect-src 'self' https://keys.coinbase.com https://*.coinbase.com https://mainnet.base.org https://base-rpc.publicnode.com`. Keep `frame-ancestors 'none'`. Find the exact hosts in the browser console during Step 4; do not use `*`.

- [ ] **Step 1: Write the failing tests:**
  - `formatUsdc(5208000n) === '5.208'`.
  - `hoursFor(5208000n, 7000n) === 744`.
  - `clampAllowance('0.1', 168000n, 5208000n)` returns an error string naming 0.168.
  - `clampAllowance('5', 168000n, 5208000n) === 5000000n`.
  - `BEFORE_YOU_START` mentions "email" and "pop-up".
- [ ] **Step 2: Run to see them fail.** `node --test --import tsx web/allow-copy.test.ts`.
- [ ] **Step 3: Implement the helpers, page and build entry.** Use no em dashes in the copy.
- [ ] **Step 4: Check it locally.**
  1. Run `npm run dev:door` (the `charter-dev-door` launch config) and open `/allow?id=<id from a dev POST>`.
  2. Confirm the view renders and the Connect button opens the Coinbase pop-up from a real click in Chrome.
  3. Copy the hosts the console lists into the Caddy CSP.
- [ ] **Step 5: Commit.** `git commit -m "web: allowance approval page, its own CSP"`

### Task 7: charter-mcp tools

**Files:**
- Modify: `mcp/src/core.ts`, `mcp/src/server.ts`, `mcp/src/core.test.ts`, `mcp/src/server.test.ts`, `mcp/package.json` (version `0.5.0`), `mcp/server.json`, `mcp/README.md`

**Interfaces:**
- Consumes: Task 2's public routes.
- Produces three free tools (no wallet needed):
  - `charter_allowance_link({ sshKeys: string[], image?: 'charter-home' | 'charter-hermes' })` returns `{ allowanceId, ownerToken, approveUrl, message }`. The `message` text is ready to send to the person, and the tool tells the agent to keep `ownerToken`.
  - `charter_allowance_status({ allowanceId, ownerToken })` returns the owner view.
  - `charter_allowance_stop({ allowanceId, ownerToken })` returns the owner view in state `stopping`.
  - Errors are mapped like `pitch`'s: `no_home` becomes "open the home and pay its first hour first"; `already_live` names the live allowance.

- [ ] **Step 1: Write the failing tests** for each tool, against a fake `post`/`get`, including the two error mappings and the private-key refusal that `pitch` already has for keys.
- [ ] **Step 2: Run to see them fail.** `cd mcp && npm test`.
- [ ] **Step 3: Implement, bump to 0.5.0.**
- [ ] **Step 4: Run to see them pass.** `cd mcp && npm test && npm run build`.
- [ ] **Step 5: Commit.** `git commit -m "mcp: allowance link, status and stop tools (0.5.0)"`

### Task 8: Docs for agents

**Files:**
- Modify: `web/llms.txt`, `web/agents.html`, `README.md`, `src/door/openapi.ts`, and its test if one pins the route list.

- [ ] **Step 1: Add one short "Monthly allowance" section** to `llms.txt`, `/agents` and the README. It says:
  - **What it is:** a person approves once and Charter keeps the home paid.
  - **The call:** `POST /v1/allowances` with the home's keys, or the MCP tool.
  - **What the person meets:** a Coinbase sign-up with an email, a pop-up to allow, and one signature.
  - **After approval:** stop your own renew loop once the state is `active`.
  - **Stopping it:** `POST /v1/allowances/<id>/stop` with the owner token.
  - **Limits:** Base Account only; homes only.
- [ ] **Step 2: Add the four public routes to `openapi.ts`.** Run `npm test`. Expected: PASS.
- [ ] **Step 3: Commit.** `git commit -m "docs: monthly allowance for agents"`

### Task 9: Mainnet proof with Drew (before advertising)

No code. Each step's result goes in `docs/demo.md` as a new section with the transaction hashes.

- [ ] **Step 1: Period reset.**
  1. In the spike (`~/src/TOON/spend-spike`), Drew's test Base Account approves a new permission with `periodInDays: 1`.
  2. Pull 0.01 now, then try again until the pull is refused for the period.
  3. After `nextPeriodStart`, pull again. Expected: the pull after the reset succeeds.
- [ ] **Step 2: Person-side cancel.** Drew presses a `requestRevoke` button on the spike page (add one) for that permission. Expected: `getPermissionStatus` reads `isRevoked: true` and a pull is refused. If this passes, set `CANCEL_TESTED = true` in `web/allow.ts`.
- [ ] **Step 3: Deploy.**
  1. Make the biller key (`new-allow-key.mjs`) and the token.
  2. Drew sends about 0.0005 ETH to the biller address.
  3. Set the door env, `door.env` backup first, named `.bak-<date>-preallow`.
  4. Deploy the door (rsync + `compose up -d --build`), then `charter-allow`.
  5. Check the door is healthy and `charter-allow status` is clean.
- [ ] **Step 4: End to end.**
  1. A test home (keys Claude makes, first hour paid from the bazaar key) asks for a link.
  2. Drew approves 5.04 USDC per 30 days (the minimum, 720 ticks at 0.007, ruling R8) with the test Base Account.
  3. Expected: the biller activates it, pulls once (168000) and pays at least 2 ticks, and the lease's `paidIntervals` grows.
  4. Then `charter_allowance_stop`. Expected: a revoke tx, then a refund tx of exactly the credit, then state `ended` / `stopped`, all on chain.
- [ ] **Step 5: Push, publish charter-mcp 0.5.0** (Drew approves the staged publish), then the MCP registry. Expected: `npm view charter-mcp version` prints `0.5.0`.
