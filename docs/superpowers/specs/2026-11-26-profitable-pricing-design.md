# Profitable pricing: hel1 pays for itself, the door takes a fee

Date: 2026-11-26. Status: design, awaiting Drew's approval.

## Why

Drew: "I want to make a bit of money via growth. Can be very low but slightly above breaking even." He also
does not want a surprise bill if agents find Charter all at once. The grant fund (about 100 USDC) is a one-off
marketing cost and is left out of the sums.

Today hel1 costs $36.09 a month and earns at most about 20 USDC (4 homes at 0.007 USDC an hour, every hour
rented), and the door takes nothing on other operators' hosts. So more renters means a bigger loss.

A rush cannot create a debt: every wallet is prepaid and capped (door float, referral daily cap, host capital
cap, grant fund balance, X credit cap). This design fixes the margin, not the exposure.

## Goals

- Every paid hour on hel1 earns more than it costs once hel1 is a bit over half full.
- Every paid hour on any host leaves the door a small fee to cover its on-chain costs.
- A referred hour still leaves Drew ahead.

## Non-goals

- Grant fund economics (it gets dearer per grant; accepted).
- A percentage door fee, tiers, or per-renter pricing.
- More servers.

## Anti-goals

- hel1 dropping off the door during the change.
- Your bots' home being stopped by the change.
- Any client signing a payment above a cap its operator set.

## Approaches considered

1. **0.012 USDC an hour, 6 home slots, caps raised to 0.02 (picked by Drew).** Break-even at 58% full, about
   $16 a month if full, about $10 with every hour referred. Costs a release round, and charter-mcp installs
   from before the release refuse to rent until they update.
2. 0.015 an hour, 4 slots. Break-even at 84% full, about $7 if full; referrals wipe the margin out.
3. 0.0099 an hour, 6 slots, no cap changes. Break-even at 84% full, same referral problem.

## The design

**Prices (renter pays 0.012 USDC an hour on hel1):**
- hel1 `CHARTER_TICK_PRICE=11000` (0.011).
- Door `CHARTER_DOOR_FEE=1000` (0.001), on every host. The renter pays host price plus fee; the fee lands in
  the door wallet and is swept to Drew daily. *(Claude's call: splitting 0.012 as 0.011 + 0.001 keeps hel1's
  renter price at what Drew picked and gives the door the same fee on third-party hosts.)*
- Referral share stays 10% of what the renter paid (0.0012 on hel1). On unlisted hosts it is already capped
  at the door fee, so a host renting from itself still cannot farm it.

**Slots:** hel1 `CHARTER_MAX_HOMES=6`, `CHARTER_MAX_LEASES` stays 6 (jobs and homes together), so the box
never holds more than six 1 GiB containers. Checked 11-26: 6.5 GB free with one home running.

**Caps raised from 0.01 to 0.02 an hour:**
- Door `CHARTER_PROBE_MAX_TICK` default 20000 (the probe pays the host price, 11000 here).
- `MAX_TICK_MICRO` in `src/fund/paymaster.ts` to 20000 (grant fund and allowance biller).
- charter-mcp `CHARTER_MAX_USDC_PER_HOUR` default 0.02, and `CHARTER_MAX_USDC_PER_DAY` default 0.25 to 0.50
  (a home at 0.012 costs 0.288 a day, above the old day cap).
- Home rent script `jobs/home/x402-rent.mjs` `CHARTER_X402_MAX_TICK` default 20000.
- `charter` CLI (`src/cli.ts`) `CHARTER_MAX_TICK` default 20000: every `charter-hermes` home renews through it.
- Door `MAX_TICK_PRICE` (50000) is already above.

**Copy:** every "0.007 USDC an hour" and what is derived from it ("about 5 USDC for 30 days", "1 USDC is about
6 days") becomes 0.012, about 8.64 USDC for 30 days, and about 3.5 days. This covers the README, web pages,
llms.txt, skills (plugin, ClawHub, OpenHuman), the MCP tool text, env docs and examples. Site copy stays
evergreen. Old specs and plans are history and are not edited.

**Rollout order (hel1's price moves last, so it never fails a probe):**
1. Door: new code with the 0.02 probe cap, plus `CHARTER_DOOR_FEE=1000`. Check the live door.env for an
   explicit `CHARTER_PROBE_MAX_TICK` and drop or raise it.
2. Grant fund and allowance biller on the box: redeploy with the new cap.
3. charter-mcp: npm release (Drew's passkey), then the MCP registry, ClawHub, plugin.
4. hel1 home images (`charter-home`, `charter-hermes`): rebuild from the new tree. They carry `charter-x402`
   and the `charter` CLI, whose old 0.01 default would refuse a home's own 0.012 renewals.
5. hel1: `CHARTER_TICK_PRICE=11000`, `CHARTER_MAX_HOMES=6`, restart the host, wait for the door to list
   0.012 with 6 slots and a passed probe.
6. Push charter main.

**Leases already open keep their open-time price and fee.** Your bots' home (allowance 45b94233, approved at
7000) keeps running as long as its lease does not lapse. If it ever re-opens, the biller refuses 12000 and backs
off, so that home needs a new allowance at 12000 first. *(Claude's call: leave the running lease alone rather
than move it now.)*

## Left to the builder

- Test updates where they pin 7000 or the 0.01 caps.
- Exact wording of each copy change.
