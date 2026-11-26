# Profitable Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renters pay 0.012 USDC an hour on hel1 (0.011 host + 0.001 door fee), hel1 holds 6 homes, and every 0.01 cap becomes 0.02.

**Architecture:** Mostly constants and copy. Code changes raise four caps and one default; the price itself is env on hel1 and the door. Rollout order matters: caps first, hel1's price last, so hel1 never fails a probe.

**Tech Stack:** TypeScript (node --test via tsx), charter-mcp in `mcp/`, plain `.mjs` home script.

**Spec:** `docs/superpowers/specs/2026-11-26-profitable-pricing-design.md`

## Global Constraints

- Renter price on hel1: 12000 micro-USDC an hour = host `CHARTER_TICK_PRICE=11000` + door `CHARTER_DOOR_FEE=1000`.
- Caps: 20000 micro-USDC (0.02 USDC) an hour everywhere a 10000 (0.01) cap sits today; charter-mcp day cap 0.50.
- Copy: "0.012 USDC an hour", "about 8.64 USDC for 30 days", "1 USDC is about 3.5 days". No em dashes. Site copy evergreen.
- Old specs and plans under `docs/superpowers/` are history: do not edit them.
- Leases already open keep their open-time price and fee: no migration.

## Review Focus

- A host priced exactly at the new cap (20000) must still pass the probe and be paid by the fund and biller; 20001 must not. (Tasks 1 and 2 test both edges.)
- An operator who set `CHARTER_MAX_USDC_PER_HOUR=0.01` explicitly keeps that cap; only the default moves. (Task 2.)
- An allowance approved at 7000 must still refuse a 12000 lease with `PRICE_ROSE`, not pay it. (Task 1.)
- A day of a home at 12000 (24 x 12000 = 288000) fits the new 0.50 day cap. (Task 2.)
- No "0.007" left in shipped copy after Task 3 (grep check in Task 3).

---

### Task 1: Raise the door, fund, biller and home-script caps; host default 11000

**Files:**
- Modify: `src/door/config.ts:55` (probeMaxTick default 10_000n -> 20_000n)
- Modify: `src/fund/paymaster.ts:13` (`MAX_TICK_MICRO = 20_000n`)
- Modify: `src/host/config.ts:194-197` (default `CHARTER_TICK_PRICE` 7000n -> 11000n, comment "0.011 host + 0.001 door fee = 0.012 an hour, about 8.64 USDC for 30 days")
- Modify: `jobs/home/x402-rent.mjs:16,365` (export `DEFAULT_MAX_TICK = 20000n`, use it as the `CHARTER_X402_MAX_TICK` default; update the header comment to 0.02). The pin cap (`CHARTER_X402_MAX_PIN`) stays 10000.
- Modify: `deploy/host/env.example:25-29`, `docs/env.md` rows for `CHARTER_TICK_PRICE`, `CHARTER_PROBE_MAX_TICK`, `CHARTER_DOOR_FEE` (say the live door charges 1000)
- Test: `src/door/config.test.ts`, `src/fund/paymaster.test.ts`, `src/allow/biller.test.ts`, `src/host/config.test.ts`, `jobs/home/x402-rent.test.mjs`

**Interfaces:**
- Produces: `MAX_TICK_MICRO === 20_000n` (fund and biller share it), `DEFAULT_MAX_TICK` exported from `jobs/home/x402-rent.mjs`.

- [ ] **Step 1: Write the failing tests**
  - `config.test.ts`: the defaults case expects `probeMaxTick: 20_000n` (line 49).
  - `paymaster.test.ts`: `MAX_TICK_MICRO is 0.02 USDC` asserts `MAX_TICK_MICRO === 20_000n`.
  - `biller.test.ts`: an allowance with `tickMicro: '20000'` activates; `'20001'` is refused as "not a price the biller pays"; an allowance approved at `'7000'` facing a lease that asks 12000 backs off with `PRICE_ROSE` and pays nothing (follow the file's existing activation and price-rose cases).
  - `host/config.test.ts`: lines 29 and 51 expect `11000n`; line 211 bound becomes `<= 20_000n`.
  - `x402-rent.test.mjs`: `assert.equal(DEFAULT_MAX_TICK, 20000n)`; a 402 offering 20000 passes `onlyDoorExact(PAYEE, DEFAULT_MAX_TICK)` and 20001 does not.
- [ ] **Step 2: Run `npm test` and confirm exactly these fail**
- [ ] **Step 3: Change the constants and defaults listed under Files**
- [ ] **Step 4: Run `npm test && npm run typecheck`; expected all pass**
- [ ] **Step 5: Commit** `caps: 0.02 an hour for probe, fund, biller and home script; host default 0.011`

### Task 2: charter-mcp caps 0.02 an hour and 0.50 a day; release 0.8.0

**Files:**
- Modify: `mcp/src/server.ts:71-72` (defaults `'0.02'` and `'0.50'`), `mcp/src/server.ts:372,435,442,535` (tool text: 0.012 an hour; "1 USDC is about 3.5 days of a home")
- Modify: `mcp/src/cli.ts:25,28` (0.012 today; caps 0.02 and 0.50)
- Modify: `mcp/README.md` (price and cap lines), `mcp/package.json` version `0.8.0`, `mcp/server.json` version if present
- Modify: `mcp/scripts/smoke.mjs` if it pins 0.007
- Test: `mcp/src/server.test.ts`, `mcp/src/core.test.ts`

- [ ] **Step 1: Write the failing tests** in `server.test.ts`:
  - `default caps are 0.02 an hour and 0.50 a day`: options built with no env give `maxHour === 20_000n`, `maxDay === 500_000n` (beside line 333).
  - `an explicit hour cap is kept`: env `CHARTER_MAX_USDC_PER_HOUR=0.01` gives `maxHour === 10_000n`.
  - `a day of a home fits the default day cap`: 24 payments of 12000 against the file spend book at `maxDay` 500_000n all succeed; a 25th at 250000 more is refused with `CapError`.
  - line 243 expects `maxUsdcPerDay: '0.50'` if it reads defaults (keep it if the fixture pins 250_000n).
- [ ] **Step 2: Run `cd mcp && npm test`; confirm these fail**
- [ ] **Step 3: Change the defaults and copy**
- [ ] **Step 4: Run `cd mcp && npm run typecheck && npm test`; expected all pass**
- [ ] **Step 5: Commit** `charter-mcp 0.8.0: caps 0.02 an hour and 0.50 a day, price 0.012`

### Task 3: Price copy everywhere that ships

**Files:**
- Modify: `README.md`, `web/index.html`, `web/llms.txt`, `web/home.html`, `web/grants.html`, `web/agents.html`, `web/openhuman/SKILL.md`, `site/index.html`, `src/door/x402.ts:57,59`, `clawhub/charter-compute/SKILL.md` (version 0.7.0), `plugins/charter/skills/renting-charter-compute/SKILL.md` and `plugins/charter/.claude-plugin/plugin.json` (version 0.5.2), `docs/ops.md`
- Do not touch: `web/dist/` (built by `npm run build:web`), `docs/superpowers/`, `docs/demo.md` (record of past runs)
- Test: `web/*.test.ts` that pin copy (`allow-copy.test.ts`, `grants.test.ts`, `format.test.ts` if they assert 0.007)

- [ ] **Step 1: Update copy tests** that assert "0.007" to the new wording (grant copy: a month is about 8.64 USDC)
- [ ] **Step 2: Run `npm test`; confirm they fail**
- [ ] **Step 3: Replace the copy** per Global Constraints. Where a page says how many home slots hel1 has, say 6 only if it is not evergreen-safe to point at `/v1/offers` instead; prefer pointing at `/v1/offers`.
- [ ] **Step 4: Verify** `grep -rn -E "0\.007|about 5 USDC|about 6 days" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=superpowers . | grep -v -E "\.test\.|demo\.md"` prints nothing; `npm run build && npm test && npm run typecheck` pass.
- [ ] **Step 5: Commit** `copy: 0.012 USDC an hour; ClawHub 0.7.0, plugin 0.5.2`

### Task 4: Rollout (Drew present)

No code. Each step is checked before the next. Backups named `*.bak-20261126-prepricing`.

- [ ] **Step 1: Door.** Back up `/opt/charter` and door.env. Check door.env for an explicit `CHARTER_PROBE_MAX_TICK`: remove it or set 20000. Add `CHARTER_DOOR_FEE=1000`. Sync main, `compose up -d --build`. Check: `/v1/offers` lists hel1 at `tickPrice` 8000 (7000 + fee) and `referralShare` 800, door healthy.
- [ ] **Step 2: Fund and biller** (same box): restart from the new tree. Check their boot logs show no cap refusal; the bots' allowance 45b94233 keeps paying its open lease at 7000 + its open-time fee 0.
- [ ] **Step 3: charter-mcp 0.8.0** to npm (`npx -y npm@latest stage publish` in `mcp/`, Drew approves with his passkey in his terminal tab), then the MCP registry, ClawHub 0.7.0, push the plugin. Check `npm view charter-mcp version` = 0.8.0.
- [ ] **Step 4: hel1.** Back up its env. Set `CHARTER_TICK_PRICE=11000`, `CHARTER_MAX_HOMES=6`, keep `CHARTER_MAX_LEASES=6`, restart `charter-host`. Check: `/v1/offers` shows `tickPrice` 12000, `home.slots` 6, record not `new`, probe passed; `free -m` on hel1 still above 1 GB available.
- [ ] **Step 5: X bot facts.** On toonbox, grep the installed `facts.md` for `0.007` and update it to 0.012 if present.
- [ ] **Step 6: Push charter main.** Record the rollout in `docs/demo.md` as a new section (date, offer, settle tx of the first 12000 tick if one lands).
