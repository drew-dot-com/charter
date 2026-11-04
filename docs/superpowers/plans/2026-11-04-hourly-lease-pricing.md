# Hourly Lease Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Charter's one offer from a 30 second interval at 5000 micro-USDC to a one hour interval at 7000, and make an hour-long paid interval safe in the door, the python job and the storefront.

**Architecture:** The lease machinery is already interval-agnostic, so the price itself is host configuration (env plus the TOON app and edge route prices). The code changes are the three places that silently assumed a short interval: the door's refund idle window, the door's free-read budget, and the storefront's poll period; plus the python wrapper's wall cap, which the host now sets from the job profile. Documents are updated to the one price line.

**Tech Stack:** TypeScript on Node 22, `node --test`, express, `@x402/*` 2.28. Host on toon2 (Lima VM on the Air), door on the Hetzner box (`/opt/charter`, compose), edge connector on the same box.

**Spec:** `docs/superpowers/specs/2026-11-04-hourly-lease-pricing-design.md`

## Global Constraints

- Price after: `intervalSeconds` 3600, `tickPrice` 7000, `openPrice` 1000, `statusPrice` 100. The one price line in every document: "0.007 USDC an hour, about 5 USDC for 30 days".
- No em dashes in anything that ships (docs, page copy, commit messages).
- Nothing in page copy steers an agent to spend without its operator knowing; the "Before you spend" section stays.
- Tests that fix a 30 s interval stay; new behaviour gets new tests. `npm test` and `npm run typecheck` green before each commit.
- Deploy order: host (toon2) first, then the edge route, then the door. Check for live leases before restarting the host.

## Review Focus

- A lease opened before the deploy on the 30 s / 5000 snapshot: the door keeps pricing its ticks from the ledger snapshot (5000) and the new 7000 offer never changes it. Pinned in Task 2 (budget uses the snapshot's interval) and existing snapshot tests.
- A door ledger with no leases yet, or only 30 s leases: the refund idle window must stay exactly 10 minutes. Pinned in Task 1.
- A renter who pays 24 ticks in a row: `paidThrough` 24 hours out, each tick accepted in order, the 30-per-minute tick limit not hit. Existing lease tests cover the extension; the TOON proof in Task 7 sends two in a row.
- A python script that runs past 10 minutes on a paid hour: must not be killed by the wrapper. Pinned in Task 4 (the flag is on the container) and proven live in Task 7 with a 120 s sleep (the old cap was never near; the flag's presence on `docker create` is the test).
- The storefront page on an hourly lease: must still show `done` within about a minute of the job exiting. Pinned in Task 5 (`pollMs(3600)` is 60 000).

---

### Task 1: Door refund idle window follows the longest interval

**Files:**
- Modify: `src/door/claims.ts`
- Modify: `src/door/main.ts:55-125`
- Test: `src/door/claims.test.ts`

**Interfaces:**
- Produces: `export function idleMsFor(intervalSeconds: Iterable<number>): number` in `claims.ts`: `max(REFUND_IDLE_MS, 2 × 1000 × max(intervalSeconds))`, `REFUND_IDLE_MS` for an empty iterable.
- Produces: `startClaims(m, log, schedule = setTimeout, idleMs: () => number = () => REFUND_IDLE_MS)`; `selectClaimChannels` and `selectRefundChannels` call `idleMs()` per round.
- Produces: `x402Command(args, m, storage, now, out, idleMs: () => number = () => REFUND_IDLE_MS)`; the `refund` command uses it.

- [ ] **Step 1: Write the failing tests** in `claims.test.ts`

```ts
test('idleMsFor: 10 minutes with no leases or 30 s leases, twice the longest interval otherwise', () => {
  assert.equal(idleMsFor([]), REFUND_IDLE_MS);
  assert.equal(idleMsFor([30, 30]), REFUND_IDLE_MS);
  assert.equal(idleMsFor([30, 3600]), 7_200_000);
});
test('startClaims refunds and claims by the idle window it is given, read on each round', () => {
  // capture the selectors from m.start's options; a channel idle 11 min is refundable at the default
  // window and not at idleMsFor([3600]); the same for selectClaimChannels with unclaimed vouchers.
});
test('x402Command refund uses the idle window it is given', async () => {
  // a channel idle 11 min: refunded with the default, "nothing to refund" with () => 7_200_000.
});
```

- [ ] **Step 2: Run** `node --test src/door/claims.test.ts` → FAIL (`idleMsFor` not exported).
- [ ] **Step 3: Implement** `idleMsFor`, thread `idleMs` through `startClaims` and `x402Command`. In `main.ts`, `startClaims(claims, log, setTimeout, () => idleMsFor(ledger.all().map((l) => l.offer.intervalSeconds)))`; in `x402Main`, open `new DoorLedger(join(dataDir, LEDGER_FILE))` the same way the door does and pass the same closure (the ledger constructor only reads; confirm before relying on it).
- [ ] **Step 4: Run** `npm test` → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `door: the refund idle window is twice the longest interval the ledger has seen, never under 10 min`

### Task 2: Door free-read budget scales with paid time

**Files:**
- Modify: `src/door/server.ts` (the `spendRead` closure and the constants near `READS_BASE`)
- Test: `src/door/server.test.ts`

**Interfaces:**
- Produces: `export const READS_PER_PAID_MINUTE = 1` and `export function readBudget(ticks: number, intervalSeconds: number): number` = `READS_BASE + READS_PER_TICK * ticks + Math.floor((ticks * intervalSeconds) / 60) * READS_PER_PAID_MINUTE`.

- [ ] **Step 1: Write the failing test**

```ts
test('readBudget: 40 free reads, 8 more per tick, and one per paid minute', () => {
  assert.equal(readBudget(0, 30), 40);
  assert.equal(readBudget(1, 30), 48);
  assert.equal(readBudget(2, 30), 57);     // one paid minute across two 30 s ticks
  assert.equal(readBudget(1, 3600), 108);
});
```

- [ ] **Step 2: Run** `node --test src/door/server.test.ts` → FAIL.
- [ ] **Step 3: Implement** `readBudget`; `spendRead` compares `rec.hostReads` against `readBudget(rec.ticksPaidByRenter, offerOfSnapshot(rec.offer).intervalSeconds)`.
- [ ] **Step 4: Run** `npm test` → PASS (the existing 48-read assertion still holds at 30 s).
- [ ] **Step 5: Commit** `door: a lease's free reads grow with its paid minutes, so an hour-long lease can be watched`

### Task 3: Bazaar description is interval-neutral

**Files:**
- Modify: `src/door/x402.ts` (the `description` string in `realGate`)
- Test: `src/door/x402.test.ts` (only if a test asserts the text; `grep -n "30 second" src/door/x402.test.ts`)

- [ ] **Step 1:** Replace the description with: `One paid interval of sandboxed compute on Charter: intervalSeconds in the offer, one hour at 0.007 USDC on the live host (Python with NumPy, or a headless-browser fetch). Open a lease first, free: POST /v1/leases. The whole procedure is at https://charter.mainnet.toonprotocol.dev/agents`
- [ ] **Step 2: Run** `npm test` → PASS.
- [ ] **Step 3: Commit** `door: the Bazaar description names the interval from the offer, one hour on the live host`

### Task 4: Host defaults and the python wall cap

**Files:**
- Modify: `src/host/config.ts:86-88`, `src/host/runner.ts:46-55` (the `JOB_PROFILES[PYTHON_IMAGE].flags`)
- Modify: `deploy/host/env.example`, `docs/env.md:25-26`
- Test: `src/host/config.test.ts:18-22`, `src/host/runner.test.ts` (near line 185)

**Interfaces:**
- Produces: `export const PYTHON_WALL_SECONDS = 2_592_000` in `runner.ts`; the python profile's `flags` gain `'-e', \`CHARTER_WALL_SECONDS=${PYTHON_WALL_SECONDS}\``.

- [ ] **Step 1: Write the failing tests**: in `config.test.ts` change the defaults test to `intervalSeconds 3600`, `tickPrice 7000n`; in `runner.test.ts` next to the `--tmpfs /tmp:size=64m` assertion add `has('-e', 'CHARTER_WALL_SECONDS=2592000')`, and assert the fetch job's argv has no `CHARTER_WALL_SECONDS`.
- [ ] **Step 2: Run** `node --test src/host/config.test.ts src/host/runner.test.ts` → FAIL.
- [ ] **Step 3: Implement**: defaults `3600` and `7000n`; the profile flag with a one-line comment (the wrapper's own cap is 600 s, built for 30 s intervals; the paid time ends the job now).
- [ ] **Step 4:** `deploy/host/env.example`: add `CHARTER_INTERVAL_SECONDS=3600` and `CHARTER_TICK_PRICE=7000` with the one price line as a comment. `docs/env.md`: defaults `3600` and `7000`.
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `host: one hour at 7000 is the default interval; the python job's wall cap no longer ends a paid hour`

### Task 5: Storefront poll period and offer card

**Files:**
- Modify: `web/schedule.ts`, `web/app.ts:14,675,701,326`, `web/format.ts`
- Test: `web/schedule.test.ts`, `web/format.test.ts`

**Interfaces:**
- Produces: `export const POLL_MS = 5_000` moves into `schedule.ts`; `export function pollMs(intervalSeconds?: number): number` = `Math.max(POLL_MS, (intervalSeconds ?? 0) * 1000 / 60)`.
- Produces: `export function perHourNote(tickPrice: string, intervalSeconds: number): string | undefined` in `format.ts`: `undefined` when `intervalSeconds === 3600`, else `` `${formatUsdc(pricePerHour(tickPrice, intervalSeconds))} an hour` ``.

- [ ] **Step 1: Write the failing tests**

```ts
// schedule.test.ts
test('pollMs: every 5 s on a short or unknown interval, a sixtieth of the interval past 5 minutes', () => {
  assert.equal(pollMs(undefined), 5_000);
  assert.equal(pollMs(30), 5_000);
  assert.equal(pollMs(300), 5_000);
  assert.equal(pollMs(3600), 60_000);
});
// format.test.ts
test('perHourNote is dropped when the interval is an hour (it would repeat the price)', () => {
  assert.equal(perHourNote('5000', 30), '$0.60 an hour');
  assert.equal(perHourNote('7000', 3600), undefined);
});
```

- [ ] **Step 2: Run** `node --test web/schedule.test.ts web/format.test.ts` → FAIL.
- [ ] **Step 3: Implement**; in `app.ts` the two `POLL_MS` reads on a running lease become `pollMs(p.offer?.intervalSeconds)` (`POLL_FINAL_MS` stays), and the offer card appends the `per` span only when `perHourNote` returns a string.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build` → PASS (the web build runs in `build`; confirm with `npm run` if not).
- [ ] **Step 5: Commit** `web: a long lease is polled once a minute; the per-hour note is dropped when the interval is an hour`

### Task 6: Documents say one price

**Files:**
- Modify: `web/agents.html`, `web/llms.txt`, `README.md:23,31,76`, `site/index.html:8,61,81,92`, `scripts/bazaar-tick.mjs:4`
- Modify: `plugins/charter/skills/renting-charter-compute/SKILL.md:38-66`, `plugins/charter/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (version 0.2.0 where a version exists)
- Modify: `docs/ops.md` (new section "Changing a price")

- [ ] **Step 1:** `agents.html` and `llms.txt` per the spec's Documents section: lede, price table (one hour 0.007), examples ("a python job that finishes in its first hour costs 0.007; a day about 0.17; 30 days about 5"), step 3 heading, step 4 (pay the next tick 30 minutes before `paidThrough`; to pay ahead send the next indexes now, each adds an hour), step 5 (poll a long lease about once a minute: 40 free reads plus 68 per paid hour), refund "about two hours after the lease goes quiet", operator paragraph ("1 USDC runs about six days; about 5 USDC a month"), VPS sentence ("about the price of the cheapest VPS, for a box nobody signed up for; only the two jobs below run today").
- [ ] **Step 2:** README, landing source, bazaar script comment, SKILL.md (interval, price table, example total about 9300, offer lifetime 45 min / every 20), plugin versions.
- [ ] **Step 3:** `docs/ops.md` "Changing a price": the three places (toon2 `charter-tick` app, edge route `g.toon.69b2a212547e7a9c.charter-tick`, host env), check live leases first, restart, then rerun `scripts/bazaar-tick.mjs` so the catalog shows the new price. Fill in the exact commands after Task 7 finds them.
- [ ] **Step 4:** `grep -rn "30 second\|0\.005\|5000" web/agents.html web/llms.txt README.md plugins site/index.html | grep -v receipts` → only historical receipt rows remain.
- [ ] **Step 5: Commit** `docs: one price line everywhere, 0.007 USDC an hour`

### Task 7: Deploy, prove, record

**Files:** none in the repo except `docs/ops.md` (exact commands) and the memory file.

- [ ] **Step 1 (toon2):** `ssh air` then `limactl shell toon2`. `jq '[.[] | select(.state=="booting" or .state=="awaiting_first_tick" or .state=="running")] | length' ~/.local/share/charter/leases.json` → 0. Back up `~/.config/charter/env` to `env.bak-20261104-prehourly`; set the two variables. Find the re-price command (`toon --help`, `toon add --help`; likely `toon add charter-tick … --price 7000 --yes` again or a remove and add); apply; confirm with `toon status --json`. Pull and build the new tree in `~/src/charter` (or `sg docker -c` as the 11-02 note says), `systemctl --user restart charter-host`, then `journalctl --user -u charter-host -n 20` shows `offer published`, and the relay offer carries `intervalSeconds 3600`, `tickPrice "7000"`.
- [ ] **Step 2 (edge):** on the box, read the connector's routes (`GET /routes` or the admin API `docs/demo.md:52` used), re-price `g.toon.69b2a212547e7a9c.charter-tick` to 7000, read back. Record both commands in `docs/ops.md`.
- [ ] **Step 3 (door):** `cp -a /opt/charter /opt/charter.bak-20261104-prehourly`; rsync the tree as the 11-03 deploy did; `docker compose -f /opt/charter/deploy/door/docker-compose.yml up -d --build`; `docker logs charter-door --tail 20` shows `channel ready, headroom`; `curl https://charter.mainnet.toonprotocol.dev/v1/offers` shows 3600 / "7000"; a bare `POST /v1/leases/<fresh lease>/ticks` answers 402 with `0.007000` in its requirements (open a lease for it with the storefront's free open, then let it lapse: cost 1000 to the door).
- [ ] **Step 4 (proof over TOON):** from the `toon` VM with the skill's `lease-loop.sh` or `charter rent --max-intervals 2`: python `import time; time.sleep(120); print("hourly")`, two ticks paid in a row, `paidThrough` about two hours out, state `done`, output `hourly`. Record lease id, spend and the landing when it appears.
- [ ] **Step 5:** Commit the `docs/ops.md` commands; push main. Hand Drew the two commands that are his: the Bazaar rerun and the landing republish.
- [ ] **Step 6:** Update `project_charter.md` in memory: RESUME (11-04) with the new price, what was deployed, the proof, and the two open items.
