# Open Hosts on Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charter drops TOON: the door pays any registered host over x402 on Base, probes and ranks hosts by track record, and renters keep paying the door exactly as today.

**Architecture:** Each host serves one HTTPS app (offer, open, tick, status) that answers only requests signed by the door's Base key; ticks sit behind an x402 `batch-settlement` gate paying the host's own address. The door replaces its TOON payer with an x402 batch client (one channel per host, one call in flight per host), keeps a host registry with probes and records, and ranks offers by record then price. The CLI talks to the door through a `HostApi` that maps onto door routes, so `runLease` is unchanged.

**Tech Stack:** TypeScript, Node 22, Express 5, `@x402/*` 2.28.0, `viem` (already a dependency through `@x402/evm`), `node --test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-23-open-hosts-on-base-design.md` (read it first; every "Calls made" value is fixed).

## Global Constraints

- Base mainnet only: network `eip155:8453`, asset `BASE_USDC` `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. No devnet or testnet infrastructure.
- `@coinbase/cdp-sdk` stays pinned at 1.60.0; lockfile resolved with `npx -y npm@10 install --package-lock-only`.
- Door to host: `batch-settlement` only. Only ticks are paid; a host offer with `openPrice` or `statusPrice` other than 0 is refused.
- Money rule kept from `payHostTick`: verify the renter's payment, pay the host, then settle the renter. The door never pays a host more than the tick price it snapshotted at open.
- Defaults (env name: value): `CHARTER_DOOR_FEE` 0 (micro-USDC per tick), `CHARTER_HOST_DEPOSIT` 500000, `CHARTER_HOST_CAPITAL_CAP` 10000000, `CHARTER_PROBE_DEPOSIT` 100000, `CHARTER_PROBE_CAPITAL_CAP` 1000000, `CHARTER_PROBES_PER_DAY` 10, `CHARTER_SWEEP_KEEP` 15000000, `CHARTER_GRANT_MIN_LEASES` 5.
- Host channel terms: `withdrawDelay` at most 86400 s. Host idle refund for the door's channel: 7 days. Door withdraws a channel idle 7 days, and at once for a dropped host.
- Probes: at most one per host per day; three consecutive failures drop a host; at most `CHARTER_PROBES_PER_DAY` first probes a day across all hosts.
- Ranking: success rate floor 0.8 (finished / (finished + host failures)) applies when a host at or above it fits; proven before new; then price; then `hostId`.
- `offerId` keeps the shape `<64 hex>:<id>`; the 64 hex is now `hostId` = sha256 of the normalized host URL.
- Copy: no em dashes in anything that ships; docs say hosts are run by independent operators and nothing claims they are vetted, safe or private. CDP descriptions stay at or under `DESCRIPTION_MAX` (500).
- `docker build` on hel1 needs `--network host`.
- Run all tests with `npm test`, types with `npm run typecheck`; both green at the end of every task.

## Review Focus

1. A registered URL that points inward (loopback, private, link-local, the door's own docker network such as `172.18.0.2`) or redirects there: the door must refuse to fetch it (`bad_url`), checked after DNS resolution. Test in Task 5.
2. A host whose 402 asks for more than the snapshotted tick price, a different `payTo`, another network, asset or scheme: the door pays nothing and records a host failure. Test in Task 4.
3. A host that raises its `tickPrice` after renters opened leases: running leases keep the open-time price for both renter and host; new leases see the new price. Test in Task 7.
4. Door restart between ticks: the per-host channel state reloads from disk and the next voucher continues the cumulative amount. Test in Task 4.
5. Clock skew on signed door requests: a timestamp 61 s off is refused, 59 s is accepted, and a replayed signature on a different path or body is refused. Test in Task 2.

---

### Task 1: Shared x402 seller module

Move what door and host will both use as x402 sellers out of `src/door/` so the host can import it. Pure move plus one option; door behavior unchanged.

**Files:**
- Create: `src/x402/seller.ts` (from `src/door/x402.ts`: `X402Config`, `Schemes`, `buildSchemes`, `facilitatorOffersBatch`, `BASE_USDC`, `WITHDRAW_DELAY_SECONDS`, `microToUsdc`, `MAX_TIMEOUT_SECONDS`, `MIN_WINDOW_SECONDS`, `SETTLE_MARGIN_SECONDS`, `PaymentId` types, `paymentIdOf`, `settleReasonOf`, `isPayerFault`, `Gate`, `TestHooks`)
- Create: `src/x402/claims.ts` (all of `src/door/claims.ts`)
- Modify: `src/door/x402.ts` (keeps door-only: `BAZAAR_TAGS`, rent schema and descriptions, `realGate`, `stubGate`; re-imports the rest), `src/door/main.ts`, every importer the compiler names
- Modify: `src/door/config.ts` (move `parseClaimKey`, `claimSigner` to `src/x402/seller.ts`)
- Test: move `src/door/claims.test.ts` to `src/x402/claims.test.ts`; door x402 tests keep their file

**Interfaces:**
- Produces: `startClaims(manager, opts: { idleMs: number; log; now? })` with `idleMs` now required at the call site (door passes `idleMsFor(...)` as today; host will pass `REFUND_IDLE_HOST_MS = 7 * 86_400_000`), exported from `src/x402/claims.ts`.
- Produces: everything listed above, same names and signatures, from `src/x402/seller.ts`.

- [ ] **Step 1:** Move the code and fix imports; add `export const REFUND_IDLE_HOST_MS = 604_800_000` to `src/x402/claims.ts`.
- [ ] **Step 2:** Add test `selectRefundable keeps a channel idle under REFUND_IDLE_HOST_MS` in `src/x402/claims.test.ts`: a channel last used 6 days ago with `idleMs = REFUND_IDLE_HOST_MS` is not selected; 8 days ago is.
- [ ] **Step 3:** Run `npm test && npm run typecheck`. Expected: all pass, same count plus one.
- [ ] **Step 4:** Commit `refactor: shared x402 seller module for door and host`.

---

### Task 2: Door request signing

**Files:**
- Create: `src/door-auth.ts`
- Test: `src/door-auth.test.ts`

**Interfaces:**
- Produces:
  - `DOOR_SIG_HEADER = 'x-charter-door-sig'`, `DOOR_TS_HEADER = 'x-charter-door-ts'`, `DOOR_AUTH_WINDOW_MS = 60_000`
  - `doorAuthMessage(method: string, path: string, body: string, ts: number): string` = `charter-door-v1\n<METHOD upper>\n<path incl. query>\n<sha256 hex of body>\n<ts>`
  - `signDoorRequest(account: LocalAccount, method: string, path: string, body: string, now: number): Promise<Record<string, string>>` (EIP-191 `signMessage`)
  - `verifyDoorRequest(o: { headers: Record<string, string | undefined>; method: string; path: string; body: string; door: `0x${string}`; now: number }): Promise<boolean>`
  - `requireDoor(door: () => `0x${string}` | undefined, now?: () => number): express.RequestHandler`: answers `401 {error:'not_door'}` when unset door, missing headers, bad signature or skew. Needs the raw body: export `rawJson = express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8') } })` and use `rawBody ?? ''`.

- [ ] **Step 1: Write the failing tests** in `src/door-auth.test.ts`:
  - `a signed request verifies` (viem `privateKeyToAccount` with a fixed test key)
  - `skew: 59 s accepted, 61 s refused` (both directions)
  - `a signature replayed on another path or body is refused`
  - `another key is refused`
  - `requireDoor answers 401 not_door with no headers` (supertest-style via `node:http` + `fetch`, as other route tests in the repo do)
- [ ] **Step 2:** Run `node --test --import tsx src/door-auth.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/door-auth.ts` with viem `verifyMessage`.
- [ ] **Step 4:** Run the test file again. Expected: PASS.
- [ ] **Step 5:** Commit `feat: door request signing`.

---

### Task 3: Host HTTPS app with a paid tick

The host's three TOON apps become one HTTPS app. Handlers move out of `hostApps` so the new app mounts them; `hostApps` stays until Task 6 deletes it.

**Files:**
- Modify: `src/host/server.ts` (extract `openHandler(deps)`, `tickHandler(deps)`, `statusHandler(deps)`, `outputHandler(deps)`; `hostApps` mounts them at its old paths)
- Create: `src/host/http.ts`, `src/host/x402.ts`
- Test: `src/host/http.test.ts`, `src/host/x402.test.ts`

**Interfaces:**
- Consumes: `requireDoor`, `rawJson` (Task 2); `Gate`, `TestHooks`, `buildSchemes`, `X402Config`, `MAX_TIMEOUT_SECONDS` (Task 1).
- Produces:
  - `hostTickGate(cfg: X402Config, priceOf: () => Micro, schemes: Schemes, door: () => string | undefined): Gate`: route `POST /v1/leases/:id/ticks`, `accepts` = one `batch-settlement` option at `priceOf()` to `cfg.payTo`; a verified payer other than `door()` answers `403 {error:'not_door'}` and is not settled. Refuses a channel whose `withdrawDelay` > 86400 (the scheme config sets `WITHDRAW_DELAY_SECONDS`, keep 3600).
  - `hostHttpApp(deps: HostDeps & { door: () => `0x${string}` | undefined; tickGate: Gate; offerJson: () => unknown }): express.Express` with routes:
    - `GET /v1/offer` free, unauthenticated, answers `offerJson()`
    - `GET /v1/health` free, unauthenticated, `{ ok: true }`
    - `POST /v1/leases` (open, body `{ job }`), `GET /v1/leases/:id`, `GET /v1/leases/:id/output/:part`: `requireDoor`, free
    - `POST /v1/leases/:id/ticks` (body `{ index }`): `requireDoor`, then `tickGate`, then `tickHandler` with `leaseId` from the path
  - Answer bodies equal what the TOON apps answer today.

- [ ] **Step 1: Write the failing tests** in `src/host/http.test.ts`, using the in-process runner the existing `src/host/server.test.ts` uses and `stubGate` for the tick:
  - `GET /v1/offer needs no signature and returns the offer`
  - `open without a door signature is 401 not_door`
  - `open, tick 0, status, output through the signed app` (mirrors the existing server happy path)
  - `a tick for an unknown lease is 404 before the gate charges` (gate hook `onGate` not called)
- [ ] **Step 2:** In `src/host/x402.test.ts`: `hostTickGate offers batch-settlement only, to payTo, at priceOf()` (read the 402's `accepts`), and `a payer other than the door is 403 not_door and never settled` (use `TestHooks`-style injection or a fake facilitator, as `src/door/x402.test.ts` does).
- [ ] **Step 3:** Run both files. Expected: FAIL.
- [ ] **Step 4:** Implement the handler extraction, `src/host/x402.ts`, `src/host/http.ts`.
- [ ] **Step 5:** Run `npm test && npm run typecheck`. Expected: PASS, existing `server.test.ts` unchanged and green.
- [ ] **Step 6:** Commit `feat: host https app with an x402 tick`.

---

### Task 4: Door pays hosts over x402

**Files:**
- Create: `src/errors.ts` (move `DeadlinePassedError`, `SendTimeoutError`, `MIN_SEND_MS` out of `src/payer.ts`; `payer.ts` re-exports them until Task 6)
- Create: `src/door/host-http.ts`, `src/door/host-queue.ts`
- Test: `src/door/host-http.test.ts`, `src/door/host-queue.test.ts`

**Interfaces:**
- Consumes: `signDoorRequest` (Task 2); `hostHttpApp`, `hostTickGate` (Task 3); `HostApi`, `HostError`, `OpenResult`, `TickResult`, `OutputPart` from `src/tenant/host-api.ts`.
- Produces:
  - `class HostQueue { run<T>(hostId: string, deadline: number | undefined, fn: () => Promise<T>, now?: () => number): Promise<T> }`: one call in flight per `hostId`; waiting calls ordered by `deadline` (undefined last, then FIFO); a call whose `deadline - now() < MIN_SEND_MS` when its turn comes rejects with `DeadlinePassedError` without running.
  - `type DepositFor = (hostId: string) => bigint | 'over_cap'`
  - `class CapitalCapError extends Error` (thrown when `DepositFor` answers `'over_cap'`)
  - `interface DoorPayer { address: `0x${string}`; account: LocalAccount; paidFetch(offer: Offer, tickPrice: Micro): typeof fetch }` built by `doorPayer(o: { key: `0x${string}`; channelDir: string; depositFor: DepositFor; fetch?: typeof fetch }): DoorPayer`. `paidFetch` registers `BatchSettlementEvmScheme` (client, `FileClientChannelStorage` under `channelDir/<hostId>`), `depositStrategy` from `depositFor(offer.hostId)`, and a policy that keeps only requirements with scheme `batch-settlement`, network `eip155:8453`, asset `BASE_USDC`, `payTo` equal to `offer.payTo` (case-insensitive) and amount exactly `tickPrice`; anything else aborts with reason `unexpected_payment`.
  - `httpHostApi(o: Offer, d: { payer: DoorPayer; queue: HostQueue; tickPrice?: Micro; timeoutMs?: number; now?: () => number }): HostApi`. Free calls are signed fetches to `o.url` (not queued). `tick` runs inside `queue.run(o.hostId, deadline, ...)` with `paidFetch(o, d.tickPrice ?? o.tickPrice)`; `spent()` grows by the tick price on any answered tick (2xx or 4xx/5xx after payment) and on a timed-out tick (`SendTimeoutError`), matching today's loss rules. Non-2xx throws `HostError(status, error)`; `unexpected_payment` throws `HostError(402, 'unexpected_payment')`. Default `timeoutMs` 30000.
  - Note: the `Offer` fields `hostId`, `url`, `payTo` arrive in Task 6. In this task declare `type HostOffer = Offer & { hostId: string; url: string; payTo: `0x${string}` }` in `src/door/host-http.ts` and use it; Task 6 folds it into `Offer`.

- [ ] **Step 1: Write the failing tests**, `src/door/host-queue.test.ts`:
  - `one call at a time per host, two hosts in parallel`
  - `earliest deadline runs first, undefined deadlines last`
  - `a call whose deadline passed in the queue rejects DeadlinePassedError and never runs`
- [ ] **Step 2: Write the failing tests**, `src/door/host-http.test.ts`, against `hostHttpApp` started on a loopback port with `stubGate` for the tick (no chain):
  - `open, tick, status, output round-trip through httpHostApi`
  - `spent counts the tick price once per answered tick`
  - Review Focus 2: `a 402 asking more than the snapshot, another payTo, network, asset or exact is refused unexpected_payment and nothing is signed` (call the policy function directly with crafted requirements)
  - Review Focus 4: `channel state reloads from disk`: build a `FileClientChannelStorage` in a temp dir, write a channel record, build a new `doorPayer` on the same dir, assert the client reads the same cumulative amount (use the library's storage API)
  - `depositFor over_cap throws CapitalCapError before any request`
- [ ] **Step 3:** Run the two files. Expected: FAIL.
- [ ] **Step 4:** Implement `src/errors.ts`, `src/door/host-queue.ts`, `src/door/host-http.ts`.
- [ ] **Step 5:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit `feat: door pays hosts over x402 batch-settlement`.

---

### Task 5: Host registry, probes, capital

**Files:**
- Create: `src/door/hosts.ts`, `src/door/probe.ts`, `src/door/safe-fetch.ts`
- Test: `src/door/hosts.test.ts`, `src/door/probe.test.ts`, `src/door/safe-fetch.test.ts`

**Interfaces:**
- Consumes: `HostApi`, `httpHostApi`, `DepositFor` (Task 4); `pythonJob` from `src/jobs.ts`.
- Produces:
  - `normalizeHostUrl(u: string): string | null`: `https:` only, no userinfo, query or fragment, lowercase host, no trailing slash, not an IP literal in loopback, private (10/8, 172.16/12, 192.168/16), link-local, CGNAT (100.64/10), `0.0.0.0`, or IPv6 equivalents.
  - `hostIdOf(normalizedUrl: string): string` (sha256 hex, 64 chars)
  - `safeFetch(url: string, init: RequestInit & { maxBytes?: number; timeoutMs?: number }): Promise<Response>`: resolves the hostname first and refuses (`SafeFetchError('bad_url')`) when any address is in the ranges above; `redirect: 'error'`; default `maxBytes` 65536, `timeoutMs` 10000.
  - `type HostState = 'probing' | 'listed' | 'hidden' | 'dropped'`
  - `interface HostRecord { hostId; url; state: HostState; registeredAt; lastSeenAt?; offer?: Offer; offerFetchedAt?; probes: { passed: number; failed: number; consecutiveFailed: number; lastAt?: number; lastFailedAt?: number }; leases: { opened: number; finished: number; hostFailed: number; consecutiveHostFailed: number }; intervalsPaid: number; homeTested: boolean }`
  - `class HostRegistry` (file `hosts.json` in the door data dir, written atomically like `DoorLedger`):
    - `register(url: string, now: number): { hostId: string; state: HostState } | 'bad_url'` (a dropped host re-registers as `probing` with counters kept)
    - `get(hostId)`, `all()`, `listed(): HostRecord[]`
    - `setOffer(hostId, offer: Offer, now)`
    - `probeResult(hostId, passed: boolean, now)`: pass sets `listed`; a fail sets `hidden`; three consecutive fails set `dropped`
    - `leaseOpened(hostId)`, `leaseFinished(hostId, intervals: number)`, `leaseHostFailed(hostId, now)`: two consecutive host failures make the host due for a probe at once
    - `markHomeTested(hostId)`
    - `homeHost(homeId): string | undefined`, `setHomeHost(homeId, hostId)`
    - `dueProbes(now, firstProbesToday: number, perDay: number): string[]` (never two probes of one host inside 24 h; first probes beyond `perDay` wait, oldest registration first)
    - `isProven(r): boolean` = `r.probes.passed > 0`
    - `successRate(r): number` = finished / (finished + hostFailed), 1 when both 0
  - `capitalAllocator(o: { registry: HostRegistry; locked: (hostId: string) => bigint; probeDeposit; hostDeposit; probeCap; hostCap }): DepositFor`: unproven hosts get `probeDeposit` while the sum locked in unproven channels stays at or under `probeCap`; proven hosts get `hostDeposit` within `hostCap`; else `'over_cap'`.
  - `PROBE_SCRIPT(nonce)`: `import hashlib\nprint(hashlib.sha256(b"<nonce>").hexdigest())`
  - `probeHost(api: HostApi, offer: Offer, o: { nonce: string; now: () => number; sleep: (ms: number) => Promise<void> }): Promise<{ passed: boolean; reason?: string }>`: open the python job, pay tick 0, poll status every 2 s until `done` or one interval passes, read output, pass when it contains `sha256(nonce)` hex.
  - `startProbes(d: { registry; apiOf: (o: Offer) => HostApi; fetchOffer: (url: string) => Promise<Offer | 'bad_offer'>; perDay: number; now; log }): () => void` running every 10 minutes.

- [ ] **Step 1: Write the failing tests**, `src/door/safe-fetch.test.ts` (Review Focus 1): `normalizeHostUrl refuses http, userinfo, query, loopback, 10/8, 172.18.0.2, 192.168/16, 169.254/16, 100.64/10, [::1], fc00::/7`; `safeFetch refuses a hostname that resolves to 127.0.0.1` (inject a resolver); `safeFetch refuses a redirect`; `safeFetch stops at maxBytes`.
- [ ] **Step 2: Write the failing tests**, `src/door/hosts.test.ts`: register idempotent by URL; probe pass lists, fail hides, three fails drop; two consecutive host failures make the host due; `dueProbes` respects 24 h per host and `perDay`; allocator: 10 unproven hosts at 0.10 fill the 1 USDC probe cap and the 11th is `over_cap`; proven hosts at 0.50 fill 10 USDC at 20; registry survives reload from disk.
- [ ] **Step 3: Write the failing tests**, `src/door/probe.test.ts` with a fake `HostApi`: right digest passes; wrong digest fails `wrong_output`; lease `closed` with `boot_failed` fails `boot_failed`; no `done` within one interval fails `timeout`.
- [ ] **Step 4:** Run the three files. Expected: FAIL.
- [ ] **Step 5:** Implement the three modules.
- [ ] **Step 6:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 7:** Commit `feat: host registry, probes and capital caps`.

---

### Task 6: Cut the offer over and remove TOON

The switch: `Offer` loses its TOON fields, the door and host run on Tasks 3 to 5, and TOON code is deleted.

**Files:**
- Modify: `src/types.ts` (`Offer`: drop `hostPubkey`, `ilpBase`, `sealKey`, `sealUrl`; add `hostId: string`, `url: string`, `payTo: `0x${string}``), `src/offer.ts` (keep `offerToJson`, `offerFromJson` for the new fields; delete Nostr event code, `OFFER_KIND`, `latestOffers`), `src/door/ledger.ts` (`OfferSnapshot` follows), `src/door/server.ts` (`publicOffer` uses `hostId`; `api` dep now `(o: Offer) => HostApi` built from `httpHostApi`; remove `headroom`, `reopen`, `hosts`), `src/door/main.ts`, `src/door/config.ts` (delete `parseDoorHosts`), `src/host/config.ts` (drop `CHARTER_SEAL_KEY`, `CHARTER_SEAL_URL`, `CHARTER_HOST_PUBKEY`, `CHARTER_PORTS`, relay; add `CHARTER_HOST_URL`, `CHARTER_HOST_PAY_TO`, `CHARTER_HOST_PORT`, `CHARTER_DOOR_URL`, `CHARTER_CLAIM_KEY_FILE`, `X402_FACILITATOR_URL` default `https://facilitator.payai.network`), `src/host/main.ts` (serve `hostHttpApp` on `127.0.0.1:CHARTER_HOST_PORT`; start host claims with `REFUND_IDLE_HOST_MS`; read the door address from `GET {CHARTER_DOOR_URL}/v1/door` field `payer` at boot and every 10 min; register on boot and whenever `homesFree` changes via `POST {CHARTER_DOOR_URL}/v1/hosts {url}`, retry every minute until 202), `src/host/loop.ts` (delete `landAll`, `offerTick`, relay code), `src/tenant/host-api.ts` (delete the TOON `hostApi(p, o)`; keep the types and `HostError`), `src/door/host-http.ts` (drop `HostOffer`, use `Offer`)
- Delete: `src/payer.ts`, `src/payer-url.ts`, `src/payer-service.ts`, `src/payer-env.ts`, `src/toon-cli.ts`, `src/door/channel.ts`, `src/tenant/offers.ts`, their tests; `@toon-protocol/client` and `nostr-tools` from `package.json` if nothing else imports them
- Modify: `src/cli.ts` only as far as needed to compile: `rent`, `renew`, `status`, `offers` print `this command moves to the door in the next release` and exit 2; `payer` is removed. Task 9 rebuilds them.
- Test: update every test the compiler or runner names; add `src/door/server.test.ts` case `the door opens and ticks a host over httpHostApi` with an in-process `hostHttpApp` and `stubGate` on both sides.

**Interfaces:**
- Consumes: everything from Tasks 1 to 5.
- Produces:
  - `GET /v1/door` gains `payer: `0x${string}`` (the door payer address).
  - Door env: `CHARTER_DOOR_PAYER_KEY_FILE` (hex key, 0400), `CHARTER_HOST_CHANNEL_DIR` default `<data>/host-channels`; `CHARTER_PAY_TO` is removed and `payTo` = the payer address. Removed: `CHARTER_RELAY_URL`, `CHARTER_DOOR_HOSTS`, every `CHARTER_TOON_*`.
  - Door `offers()` = `registry.listed()` offers (each re-fetched through `safeFetch` at most every 60 s; a fetch failure keeps the last offer for 10 min, then hides it from `/v1/offers` until it answers).

- [ ] **Step 1:** Change `Offer` and run `npm run typecheck`; work through every error by the file list above.
- [ ] **Step 2:** Delete the TOON files and their tests; run `npm test`. Expected: only failures in tests this task names.
- [ ] **Step 3:** Write the door-over-HTTP test in `src/door/server.test.ts`; run it. Expected: FAIL until wiring is done, then PASS.
- [ ] **Step 4:** `grep -rniE "toon|nostr|ilp|seal" src web mcp/src --include='*.ts'` and confirm only copy strings remain (handled in Task 11).
- [ ] **Step 5:** Run `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 6:** Commit `feat!: door and host speak https and x402; TOON removed`.

---

### Task 7: Door host routes, ranking, homes, fee

**Files:**
- Modify: `src/door/server.ts`, `src/door/openapi.ts`, `src/door/main.ts`
- Test: `src/door/server.test.ts`, `src/door/hosts-routes.test.ts` (create)

**Interfaces:**
- Consumes: `HostRegistry`, `normalizeHostUrl`, `safeFetch` (Task 5); `homeIdOf` (wherever the host computes it today, `src/host/homes.ts` or `src/jobs.ts`; export it if needed).
- Produces:
  - `POST /v1/hosts` body `{ url }`: `202 { hostId, state }`; `400 { error: 'bad_url' }`; `400 { error: 'bad_offer', reason }` when `GET {url}/v1/offer` does not parse, `openPrice` or `statusPrice` is not 0, `tickPrice` > `MAX_TICK_PRICE`, `payTo` is not an address, or `url` in the offer differs from the registered URL; `429 rate_limited` past 10 per hour per IP or 1 per hour per URL.
  - `GET /v1/hosts`: every non-dropped host as `{ hostId, url, state, record }`.
  - `publicOffer(o, r: HostRecord, fee: Micro)` adds `record: { probesPassed, leasesFinished, successRate, new: boolean, lastProbeFailedAt? }`, `operator: 'independent'`, `tickPrice` = host tick + fee, and `home.tested` when the offer has a home.
  - `rankOffers(list: Offer[], registry: HostRegistry): Offer[]` (exported, pure): Global Constraints ranking; offers of hosts in state other than `listed` never appear; untested home offers after tested ones for home jobs.
  - Rent and open: a home job whose `homeIdOf(keys)` has `registry.homeHost` must use that host's offer; if that host is not listed, `409 { error: 'home_host_gone' }`. A successful home open calls `setHomeHost`; a home lease reaching `running` with access calls `markHomeTested`.
  - Ledger hooks: open calls `registry.leaseOpened`; a lease ending `done` or `max_intervals` calls `leaseFinished(intervals)`; `host_refused`, `boot_failed`, unreachable call `leaseHostFailed`.
  - The renter pays `tickPrice + CHARTER_DOOR_FEE`; the host is paid the `tickPrice` in the lease's `OfferSnapshot`.
  - Funding: a proven host for which the allocator answers `'over_cap'` stays in `/v1/offers` with `record.funding: 'waiting'` and `rankOffers` skips it.
  - `startChannelReaper(d: { registry; payer: DoorPayer; lastLeaseAt: (hostId) => number | undefined; now; log }): () => void` (in `src/door/hosts.ts`, hourly): asks withdrawal of the door's channel to a host idle 7 days, and at once for a `dropped` host, through the batch client's withdraw call.

- [ ] **Step 1: Write the failing tests:**
  - `register then probe pass lists the host in /v1/offers with record.new true`
  - `bad_offer when openPrice is not 0`; `bad_url for http://`; `429 on the second register of one URL inside an hour`
  - `rankOffers`: a 0.95 host beats a cheaper 0.5 host; a 0.5 host is picked when it is the only one; proven beats new; tie on price breaks by hostId
  - `a home re-open goes to the host that holds the home`; `home_host_gone when that host is hidden`
  - Review Focus 3: `a host raising tickPrice after open: the running lease still pays and charges the snapshot price; a new lease sees the new price`
  - `fee: renter pays tick + fee, host is paid tick` (inspect `stubGate` hooks on both sides)
  - `a proven host over the capital cap shows funding waiting and is never picked`
  - `the reaper withdraws a channel idle 7 days and a dropped host's channel, and leaves a 6-day-idle one` (fake payer)
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. `openapi.ts` documents `POST /v1/hosts` and `GET /v1/hosts` as free (`security: []`).
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: open host registration, ranking and home pinning`.

---

### Task 8: Daily sweep

**Files:**
- Create: `src/door/sweep.ts`
- Modify: `src/door/main.ts`
- Test: `src/door/sweep.test.ts`

**Interfaces:**
- Produces: `sweepOnce(d: { balance: () => Promise<bigint>; transfer: (to: `0x${string}`, amount: bigint) => Promise<`0x${string}`>; keep: bigint; to: `0x${string}`; log: (s: string) => void; alert: (s: string) => Promise<void> }): Promise<`0x${string}` | null>` sends `balance - keep` when positive, logs the hash, and on error calls `alert` and returns null. `startSweep(d, everyMs = 86_400_000)`. Door env `CHARTER_SWEEP_TO` (required), `CHARTER_SWEEP_KEEP` default 15000000, `BASE_RPC_URL` default `https://mainnet.base.org`. `transfer` is a viem `writeContract` USDC `transfer` from the door payer account (the payer wallet keeps a little ETH for gas: say so in `docs/ops.md`). `alert` reuses the door's existing phone alert path if one exists in `deploy/ops/`, else logs at error level.

- [ ] **Step 1: Write the failing tests:** `sends balance minus keep`; `sends nothing at or under keep`; `a failed transfer alerts and returns null`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and wire into `main.ts`.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: daily sweep of the door wallet above 15 USDC`.

---

### Task 9: CLI through the door

`runLease` and `continueLease` already drive a `HostApi`; give them one backed by the door.

**Files:**
- Create: `src/tenant/door-host-api.ts`
- Modify: `src/fund/door-client.ts` (`fundToken` optional; `fund()` throws when it is unset), `src/cli.ts`
- Test: `src/tenant/door-host-api.test.ts`, `src/cli.test.ts`

**Interfaces:**
- Consumes: `doorClient`, `DoorClient` (`src/fund/door-client.ts`); `runLease`, `continueLease` (`src/tenant/run-lease.ts`).
- Produces:
  - `doorHostApi(c: DoorClient): HostApi`: `open` = `POST /v1/leases` (body as the door takes it today), `tick` = paid `POST /v1/leases/:id/ticks {index}`, `status` = `GET /v1/leases/:id`, output = the door's output route; `spent()` sums paid tick amounts from the client's answers.
  - CLI: `charter offers [--door <url>]`, `charter rent [--offer <hostId>:<id>] (--urls | --python | --home [--image]) --max-intervals <n> [--door <url>] [--json]`, `charter renew --lease <id> [--from <index>] --max-intervals <n> [--door <url>] [--json]`, `charter status <leaseId> [--door <url>] [--json]`. Door URL default `CHARTER_DOOR_URL` env, else `https://charter.mainnet.toonprotocol.dev`. Key: `CHARTER_KEY_FILE` (hex Base key). Per-tick cap: `CHARTER_MAX_TICK` micro-USDC, default 10000. `CHARTER_PAYER`, `CHARTER_OFFER_JSON`, `--relay` and `charter payer` are gone; passing them prints the new usage and exits 2.

- [ ] **Step 1: Write the failing tests:** `doorHostApi drives runLease to done against a stub door` (in-process door from `doorApp` with `free-for-tests` and an in-process host); CLI: `rent without CHARTER_KEY_FILE exits 2 with usage`; `CHARTER_PAYER set prints that it is gone`; `renew pays from the host's paid count`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: the charter CLI pays the door over x402`.

---

### Task 10: Grant fund only on proven hosts

**Files:**
- Modify: `src/fund/paymaster.ts` (the offer pick near `fits[0]`), `src/fund/main.ts` (env `CHARTER_GRANT_MIN_LEASES`)
- Test: `src/fund/paymaster.test.ts`

**Interfaces:**
- Consumes: `/v1/offers` `record` (Task 7).
- Produces: `grantEligible(o: { record?: { leasesFinished: number; lastProbeFailedAt?: number } }, now: number, minLeases: number): boolean` = `leasesFinished >= minLeases` and no `lastProbeFailedAt` within 7 days. New grants and re-opens without a pinned offer pick only eligible offers; a pinned re-open (`g.opening`) keeps today's rule. None eligible: the grant waits with problem text `no host with a record has a free home slot; waiting`.

- [ ] **Step 1: Write the failing tests:** `a host with 4 finished leases is skipped`; `5 finished and a failed probe 3 days ago is skipped`; `5 finished, no recent failure, is picked`; `none eligible waits and opens nothing`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: grants open only on hosts with a record`.

---

### Task 11: Copy, docs and listings text

**Files:**
- Modify: `package.json` description; `src/door/x402.ts` (`BAZAAR_TAGS` drops `toon`, descriptions mention independent hosts, each at or under 500 chars); `web/` storefront (host record per offer, "Hosts are run by independent operators" line, untested-home label); `web/agents.html`, `web/llms.txt` (or wherever they live), `README.md`, `plugins/charter/` skill, `mcp/README.md` and MCP tool descriptions, `site/index.html`; new section "Run a host" in `README.md` and `docs/ops.md` (install, Caddy, env from Task 6, register, what the probe does, how to claim earnings, that the door is the only payer in v1)
- Modify: `deploy/host/install-host.sh` (Caddy for TLS on the host URL, as on hel1; env template with Task 6 names)
- Test: `src/door/x402.test.ts` `descriptions stay within DESCRIPTION_MAX` (exists or add); a copy check: `grep -rnP "\x{2014}" web site README.md plugins mcp/README.md docs/ops.md` returns nothing

- [ ] **Step 1:** Update the copy and the installer; add the description-length test if missing.
- [ ] **Step 2:** Run `npm test && npm run typecheck && npm run build` and the em dash grep. Expected: PASS, no matches.
- [ ] **Step 3:** `grep -rniE "\btoon\b|nostr|onion-only|ILP" web site README.md plugins mcp/README.md mcp/src` and confirm every match is intended (for example the door's hostname).
- [ ] **Step 4:** Commit `docs: open hosts on Base, no TOON`.

---

### Task 12: Mainnet cut-over (operator task, Drew present)

No new code. Each spend or deploy step needs Drew's go in chat. Record every id and tx in `docs/demo.md` new section "Open hosts on Base".

- [ ] **Step 1:** Push the branch; Drew reviews; merge to main.
- [ ] **Step 2:** Make the door payer key (`node scripts/new-evm-key.mjs` or the repo's equivalent) at `/root/charter-door/secrets/door-payer.key` (uid 1000, 0400). Drew funds it on Base: 12 USDC (host and probe caps plus margin) and 0.0005 ETH (sweep gas). Back up `door.env`; set Task 6 and 8 env (`CHARTER_SWEEP_TO=0xbD87E8Ff0691f0A924e5ce2A06821db818B62385`).
- [ ] **Step 3:** hel1: back up env and `/root/charter-src`; stop the toon apps; deploy (rsync `dist src deploy package.json`, `chown`, `chmod +x dist/cli.js dist/host/main.js`); set host env (`CHARTER_HOST_URL=https://37-27-86-235.sslip.io`, `CHARTER_HOST_PAY_TO` = hel1's existing EVM `0x6c7035197c2F39de03389b264c0bD3b919336f06`, claim key); Caddy to `127.0.0.1:CHARTER_HOST_PORT`; restart `charter-host`.
- [ ] **Step 4:** Deploy the door (backup `/opt/charter.bak-<date>-preopenhosts`). Check: `/v1/door` shows `payer`; hel1 registers itself; within 10 min the probe opens one channel (0.10 USDC deposit tx) and passes; `/v1/offers` lists hel1 with `record.new: true`.
- [ ] **Step 5:** Paid proof from the bazaar key: `BAZAAR_KEY_FILE=~/keys/bazaar-payer node scripts/bazaar-tick.mjs --rent`. Check renter settle tx, host voucher in the door's channel store, host claim tx after the claim timer, ledger 0 losses.
- [ ] **Step 6:** Edison: in its box, replace the `charter renew` env in `~/.charter/boot.sh` with `CHARTER_KEY_FILE=~/.charter/payer.key CHARTER_DOOR_URL=https://charter.mainnet.toonprotocol.dev` and the new CLI build; check one renewal pays.
- [ ] **Step 7:** Retire TOON infra: stop and disable the toon node on hel1; close the edge peering and channel `FEFVKrn2jAUTzQM37jJTYLcLsbSLC3CeUxpUPDc28GLW`, hel1->edge `DaZN3vmu…`, the door's Solana channel `5akKFS2L…`; sweep balances to Drew. Remove the edge routes for `g.toon.7aa291d275b05d07` and `charter-*`.
- [ ] **Step 8:** Republish: charter-mcp 0.4.0 (npm, Drew's passkey), MCP registry, ClawHub skill, plugin skill, landing page (Arweave + ANT), x402-list text. Update memory files.
