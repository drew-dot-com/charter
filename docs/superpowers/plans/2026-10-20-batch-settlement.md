# Batch Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser renter signs once per deposit, not once per tick: the door and the page speak x402 `batch-settlement` beside `exact`.

**Architecture:** The door registers a second x402 scheme on the tick route with file-backed channel storage and a claim key; its channel manager claims, settles and refunds on timers. The page keeps a session key and channel context per wallet and prefers batch, falling back to exact after a refused batch payment.

**Tech Stack:** TypeScript, Node 22, `@x402/evm` 2.25 (`batch-settlement/client|server`), viem, esbuild, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-batch-settlement-design.md`

## Global Constraints

- No em dashes in copy. Prices in micro-USDC bigints (`Micro`). Node 22, ESM, `node --test --import tsx`.
- Door keys stay in files named by env; never log key material. Facilitator default `https://facilitator.payai.network`.
- Minimum deposit 100000 micro-USDC; withdraw delay 3600 s; deposit budget 20 ticks.
- Existing `exact` behaviour and tests keep passing unchanged.

## Review Focus

1. A batch voucher re-sent for the same index after a 503 must not be refused as `payment_reused` (Task 2 test).
2. A header that mixes shapes (`type: "voucher"` plus an `authorization`) must be 'bad' (Task 2 test).
3. A claim key file with whitespace, a missing `0x`, or the wrong length must fail at boot with a message that carries no key bytes (Task 1 test).
4. Deposit sizing must never go below the facilitator floor or below what this tick needs (Task 5 test).
5. The refund selector must skip a channel with a live pending request or a running lease (Task 4 test).

---

### Task 1: Claim key config

**Files:**
- Modify: `src/door/config.ts`, `src/door/config.test.ts`, `src/door/main.ts`, `docs/env.md`, `deploy/door/docker-compose.yml`, `deploy/door/door.env.example`
- Create: `deploy/door/new-claim-key.mjs`

**Interfaces:**
- Produces: `parseClaimKey(fileText: string): `0x${string}`` (throws `CHARTER_CLAIM_KEY_FILE must hold one 0x-prefixed 64-hex private key`), `claimSigner(key): AuthorizerSigner` via viem `privateKeyToAccount` (address + signTypedData).

- [ ] Test: `parseClaimKey` accepts `0x` + 64 hex with trailing newline; refuses no prefix, 63 hex, two lines; the error message contains no hex run of 8+.
- [ ] Run: `node --test --import tsx src/door/config.test.ts`; expect FAIL (not exported).
- [ ] Implement in `config.ts`; `main.ts` reads `CHARTER_CLAIM_KEY_FILE` (required) into `x402.claimKey` and sets `x402.channelDir = join(dataDir, 'x402-channels')`.
- [ ] `new-claim-key.mjs`: like `new-payer-key.mjs`, writes `0x<64 hex>` mode 400 with `wx`, prints the address only (viem `privateKeyToAccount`).
- [ ] env.md row + compose `CHARTER_CLAIM_KEY_FILE: /secrets/claim-key`; door.env.example comment.
- [ ] Run tests, expect PASS. Commit `feat(door): claim key for x402 batch settlement`.

### Task 2: Payment identity for batch vouchers

**Files:** `src/door/x402.ts`, `src/door/server.ts:366-385`, `src/door/server.test.ts`

**Interfaces:**
- Produces: `type PaymentId = ExactPaymentId | BatchPaymentId`; `ExactPaymentId = { kind: 'exact', from, nonce, validAfter, validBefore }`; `BatchPaymentId = { kind: 'batch', from, channelId, maxClaimable }` (`from` lowercased; `channelId` 0x+64 hex; `maxClaimable` decimal string).

- [ ] Tests: a `type: "voucher"` payload with `channelConfig.payer` and `voucher.{channelId,maxClaimableAmount,signature}` → batch id; a `type: "deposit"` payload → batch id too; voucher plus `authorization` → 'bad'; existing exact tests unchanged.
- [ ] Test (route, free-for-tests): POST the same batch header twice for index 0 then 1 → neither answers 409 `payment_reused`; the exact header twice still does.
- [ ] Run, expect FAIL. Implement: `paymentIdOf` branches on `payload.type`; the route guard applies window + dedupe only when `kind === 'exact'`, and for batch sets `res.locals.deadline = now + (MAX_TIMEOUT_SECONDS - SETTLE_MARGIN_SECONDS) * 1000`; `res.locals.payer = id.from` for both.
- [ ] Run, expect PASS. Commit `feat(door): batch vouchers identified by channel payer, never deduplicated`.

### Task 3: The gate offers both schemes

**Files:** `src/door/x402.ts` (realGate, X402Config), `src/door/server.test.ts` (withRealDoor fake facilitator)

**Interfaces:**
- Consumes: `claimSigner` (Task 1).
- Produces: `X402Config { payTo, network, facilitatorUrl, claimKey, channelDir }`; `buildSchemes(cfg): { server: x402ResourceServer, batch: BatchSettlementEvmScheme, facilitator: HTTPFacilitatorClient }` exported for Task 4.

- [ ] Fake facilitator `/supported` adds `{ scheme: 'batch-settlement', network: 'eip155:8453', extra: { batchPolicy: { minInitialDeposit: '100000' } } }`.
- [ ] Test: the 402 lists two accepts, `[0].scheme === 'batch-settlement'` with `extra.receiverAuthorizer` = the claim key's address and `extra.withdrawDelay === 3600`, `[1].scheme === 'exact'`; both `amount '5000'`, payTo.
- [ ] Run, expect FAIL. Implement: `accepts: [batchOption, exactOption]` sharing the `price` function; `FileChannelStorage({ root: cfg.channelDir })`.
- [ ] Run, expect PASS. Commit `feat(door): tick route accepts batch-settlement beside exact`.

### Task 4: Claims: manager on boot, one-shot command

**Files:** Create `src/door/claims.ts`, `src/door/claims.test.ts`; modify `src/door/main.ts`, `docs/env.md`

**Interfaces:**
- Consumes: `buildSchemes` (Task 3).
- Produces: `selectRefundable(channels: Channel[], now: number, idleMs = 600_000): Channel[]` (balance > chargedCumulativeAmount, no live pending, idle); `startClaims(m: BatchSettlementChannelManager, log): void` (claim 3600 s idle 600, settle 3600 s, refund 600 s with `selectRefundable`); `x402Command(args, m, storage, out): Promise<number>` for `status | claim | refund` (`claim` = `claimAndSettle({ idleSecs: 0 })`, `refund` = `refund(selectRefundable(...))`).

- [ ] Tests: `selectRefundable` keeps idle+unspent, drops zero-unspent, drops live pending (`expiresAt > now`), drops recent (`lastRequestTimestamp` within idleMs). `x402Command(['status'])` prints one line per channel: `<channelId> balance <b> charged <c> claimed <t>`; unknown arg prints usage and returns 2.
- [ ] Run, expect FAIL. Implement; `main.ts`: build manager `{ scheme: batch, facilitator, receiver: payTo, token: USDC, network }`, `startClaims` after listen, `stop({ flush: false })` on signal; `charter-door x402 …` subcommand like `channel`.
- [ ] Run, expect PASS. Commit `feat(door): claim, settle and refund x402 channels on timers; charter-door x402 command`.

### Task 5: The page pays with a session key

**Files:** Create `web/channel.ts`, `web/channel.test.ts`; modify `web/wallet.ts`, `web/wallet.test.ts`, `web/pay.ts`, `web/pay.test.ts`, `web/app.ts` (copy), `README.md:33-34`

**Interfaces:**
- Produces: `sessionSigner(address, store: Storage): ClientEvmSigner` (viem `generatePrivateKey`/`privateKeyToAccount`, persisted at `charter.x402.<address>.key`); `channelStorage(address, store: Storage): ClientChannelStorage` (`charter.x402.<address>.ch.<channelId>`); `depositFor(tickPrice: bigint, minimum: bigint): bigint` = max(100000n, 20n * tickPrice, minimum); `payFetchFor(address, eth, expected, fetchImpl, opts: { session: ClientEvmSigner; storage: ClientChannelStorage; batch: boolean })`; `matches` accepts scheme `'batch-settlement' | 'exact'`; `pay.ts`: module flag `batchDisabled`, set when a 402 answers a batch-paid tick.

- [ ] Tests: `depositFor(5000n, 0n) === 100000n`; `depositFor(10000n, 0n) === 200000n`; `depositFor(5000n, 250000n) === 250000n`. `sessionSigner` returns the same address on a second call with the same store, a different one for another wallet address. `channelStorage` round-trips get/set/delete. Policy puts batch first when both match; with `batch: false` only exact remains. `makePost`: a 402 after a batch payment flips `batchDisabled` so the next post registers exact only.
- [ ] Run, expect FAIL. Implement. Lease page copy per spec; README lines 33-34.
- [ ] `npm run typecheck && npm test && npm run build`, expect PASS. Commit `feat(page): batch-settlement channel with a session key; exact as fallback`.

### Task 6: Deploy and prove on mainnet

**Files:** `docs/demo.md` (new section 8), `deploy/door/*` as needed

- [ ] On the box: `node deploy/door/new-claim-key.mjs /root/charter-door/secrets/claim-key`; add the env; `docker compose … build && up -d`; `/v1/door` 200; a 402 on a tick shows two accepts.
- [ ] Drew rents from his browser: one prompt (deposit), 3+ intervals, done. Record lease id, deposit tx, `charter-door x402 claim` tx, refund tx in demo.md.
- [ ] Commit `docs: first batch-settled browser lease`.
