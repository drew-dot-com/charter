# Hourly lease pricing

Status: Claude's design, 2026-11-04. Drew asked for the long-lease price to be settled and skipped the
questions ("proceed as you think best"), so every choice below is Claude's call unless it says Drew's.

## Intent

Charter's one live offer prices a sandboxed 1 CPU / 1 GiB container at 5000 micro-USDC per 30 second
interval. That is 0.60 USDC an hour and about 430 USDC a month, so no agent will ever rent a box to
live in, and the agents page has to say so ("Charter is for a job that runs for seconds or minutes,
not for a server"). The next two steps of Charter's plan, Edison paying for its own box and a
"Hermes in a box" image, both need a price a model can read in one line and judge at or below the
cheapest alternative, a 5 EUR a month VPS.

This design changes the unit of sale from a 30 second interval to a one hour interval and sets the
price so a month costs about 5 USDC. It changes nothing about how a lease works: a tick still pays
one interval, ticks are still paid in order, paying early still extends the paid time from its
current end, and a missed tick still closes the lease.

## Goals

- A price line a model can evaluate: **0.007 USDC an hour, about 5 USDC for 30 days, stop paying to stop.**
- One offer, not two. A reader never has to choose a tier.
- Nothing a short job loses: a 40 second python job still costs under a cent and still frees the
  machine the moment it exits.
- The hour-long interval must be safe end to end: the door must not refund an hourly payer's deposit
  between ticks, the python job must not be killed at 10 minutes when an hour is paid, and a renter
  must still be able to see a long job finish without the door paying for a flood of reads.
- Every place that states the price agrees: the offer, the door's 402, the Bazaar declaration, the
  agents page, llms.txt, the README, the skill, the host env example, the landing page source.

## Non-goals

- A rentable "home" image (network, persistent disk, a way in). That is the next step; this one makes
  its price possible. The two existing jobs stay the only images.
- Prepaid terms as a new primitive (a day or a month in one payment). Paying ahead already works:
  send ticks 1..N now and each extends the paid time by an hour. The agents page will say so.
- A second host, or moving the host off toon2. The 24/7 question belongs to the Edison step; this
  design notes the limit (a host restart closes every live lease).
- Changing the door's fee (still 0) or the open and status prices (1000 and 100).
- Republishing the landing page to Arweave. Its source is updated and committed; the paid write is Drew's.

## Anti-goals

- Writing anything that steers an agent to spend without its operator knowing. Price text stays
  plain, the "Before you spend" section stays.
- Claiming the hourly price is a server: an hour of a sandbox that only runs the two jobs is honest;
  "rent a VPS" is not, until the home image exists.

## Price (Claude's call)

| item | before | after |
| --- | --- | --- |
| `intervalSeconds` | 30 | 3600 |
| `tickPrice` | 5000 (0.005 USDC) | 7000 (0.007 USDC) |
| an hour | 0.60 USDC | 0.007 USDC |
| 30 days, 24/7 | about 432 USDC | 5.04 USDC |
| shortest job | 0.005 | 0.007 |
| `openPrice` / `statusPrice` | 1000 / 100 | unchanged |

Why 7000 and not 5000: 5000 an hour (3.60 a month) undercuts a 5 EUR VPS on the headline while
offering a quarter of its RAM, which a model would notice; 7000 reads as parity ("about 5 USDC a
month") and leaves the host's own costs (about 2.2 USDC a month of relay writes for the offer, at
today's 20 minute republish) covered by one tenant. Why not more: anything above the VPS and the
agent says so and leaves.

Why one hourly offer instead of a short-tick offer and a long-tick offer: the host code holds one
offer, the TOON apps on the node carry one price each, and the door, the storefront, the skill and
the docs all assume one. Two tiers would need a second set of apps or a second host process and would
double the relay writes. The hourly offer serves short jobs as well as the 30 second one did,
because a job that exits frees the machine whatever is paid; the only cost is 0.002 more on the
shortest possible job.

## What changes, by component

### Host (toon2)

- `~/.config/charter/env`: `CHARTER_INTERVAL_SECONDS=3600`, `CHARTER_TICK_PRICE=7000`. Code
  defaults in `src/host/config.ts` move to the same values so a fresh host and the docs agree.
- The `charter-tick` TOON app on toon2's node is re-priced to 7000 (it is 5000 today), and the
  edge's route for `g.toon.69b2a212547e7a9c.charter-tick` is re-priced to 7000 (it is 5000). Both,
  or the edge pays toon2 2000 more than it is paid, or the door overpays the edge. `charter-open` and
  `charter-status` stay.
- The python job's wall cap. `jobs/python/run.py` kills a script after `CHARTER_WALL_SECONDS`
  (default 600). With an hour paid that is wrong: a renter pays for 60 minutes and gets 10. The host
  passes `CHARTER_WALL_SECONDS` to the python container from the image's `JobProfile.flags`
  (`-e CHARTER_WALL_SECONDS=2592000`, 30 days), so the paid time, not the wrapper, ends the job. No
  image rebuild: the wrapper already reads the variable. A renter can still not set it: it is not in
  the profile's `args`.
- A restart of `charter-host` closes every live lease (`host_restart`), today as before. With hour
  intervals that can now mean closing a lease someone paid a day ahead on. `docs/ops.md` already
  says to check for live leases before a restart; it gains a line that a paid-ahead lease is
  refunded nothing, so the check matters more.

### Door

- Refund and claim idle time. `src/door/claims.ts` refunds a batch channel's unspent deposit, and
  claims its vouchers, once it has paid nothing for `REFUND_IDLE_MS` (10 minutes). An hourly payer
  is idle for about 30 minutes between ticks, so its deposit would be refunded mid-lease and its next
  voucher would fail. The idle threshold becomes a function of the longest `intervalSeconds` among
  the leases in the door's ledger: `max(10 min, 2 × longest interval)`. With today's one offer that
  is two hours once the first hourly lease has opened; before that, 10 minutes as now. The agents
  page says "about two hours after the lease goes quiet". The `charter-door x402 refund` command
  uses the same rule.
- Free reads. A lease gets `40 + 8 × ticks` paid host reads for free today, which at a 5 second poll
  is four minutes of watching per tick. For an hour that is not enough to see a long job finish. The
  budget becomes `40 + 8 × ticks + 1 × paid minutes` (ticks × interval / 60): 68 reads per hourly
  tick, a read a minute for the hour. Worst case that costs the door 6800 against a 7000 tick,
  which is acceptable: the door's fee is 0 and its purpose is traction. The agents page tells an
  agent to poll a long lease no more than once a minute.
- The storefront page polls a running lease every 5 seconds today. It polls every
  `max(5 s, interval / 60)` instead (a minute on an hourly lease), so a human renter's page does not
  spend its reads in the first four minutes and then show stale state for the rest of the hour.
- The Bazaar declaration's description in `src/door/x402.ts` says "One 30 second interval". It
  becomes interval-neutral: "One interval (intervalSeconds in the offer, one hour on the live host)
  of sandboxed compute…". The catalog updates only when a client pays a tick while echoing the
  extension, so after the deploy Drew reruns `scripts/bazaar-tick.mjs` (0.007 from the payer key,
  which holds about 0.045).
- The door's price maxima (`MAX_TICK_PRICE` 50 000) already admit 7000. No change.

### Storefront

- The offer card shows "0.007 USDC per 1 h" and, beside it, "0.007 an hour". The per-hour note is
  dropped when the interval is exactly an hour (it would repeat the price).
- The lease page's paid-through clock and interval bar take their length from `intervalSeconds`
  already (checked: `format.duration`, `schedule.nextTickAt`, the timeline). Only the poll period
  changes (above).

### Documents

- `web/agents.html` and `web/llms.txt`: the lede, the price table, the cost examples ("a full day
  costs about 0.17 USDC; 30 days about 5"), step 3 ("Pay a tick (0.007 USDC)"), step 4 (pay the
  next tick 30 minutes before `paidThrough`; to pay ahead, send the next indexes now), step 5 (poll
  a long lease about once a minute), the refund timing (about two hours), "What to tell your
  operator" (1 USDC runs about six days; 5 USDC a month). The VPS comparison flips from "far more
  than" to "about the same as, for a box nobody signed up for", and keeps the honest limit that only
  the two jobs run today.
- `README.md`: the v1 price line and the `toon add charter-tick … --price 7000` line.
- `plugins/charter/skills/renting-charter-compute/SKILL.md`: the interval and price table, the
  cost example (one open, one tick, two reads and one part is now about 9300), the offer lifetime
  line (it still says 30 min / every 10; it is 45 / every 20). Plugin version 0.1.0 to 0.2.0 in
  `plugin.json` and `marketplace.json`.
- `deploy/host/env.example` and `docs/env.md`: the new defaults, with one line of why.
- `docs/ops.md`: a "Changing a price" section: the three places (toon2 app, edge route, host env),
  the live-lease check first, the Bazaar rerun after.
- `site/index.html` (the landing page source): the headline "Pay per 30 seconds" and the price table
  row. Committed, not republished (Drew's paid write).
- `scripts/bazaar-tick.mjs`: its comment names 0.005.

## Deploy order (Claude runs it, Drew pays what is paid)

1. Build and test locally (`npm test`, `npm run typecheck`).
2. Door first or host first? Host first: the door lists whatever the host publishes, and its price
   snapshot is taken per lease, so leases open on the old offer keep the old price (the door
   refuses an hourly tick on a 30 second lease only by the ledger's snapshot, never by the new offer).
   On toon2: confirm no live lease (`leases.json`), back up env, set the two variables, re-price the
   `charter-tick` app, restart `charter-host`, read back the published offer.
3. Edge: re-price the `charter-tick` route to 7000; probe that the door still reaches the host.
4. Box: back up `/opt/charter`, rsync the tree, `compose up -d --build`, check health, headroom,
   `/v1/offers` (interval 3600, tickPrice 7000) and a bare `POST …/ticks` 402 whose requirements say 0.007000.
5. Proof over TOON from Edison's node (`toon` VM, cents from Edison's channel, as the 10-24 proofs
   were): a python job that sleeps 120 s, two ticks paid in a row, `paidThrough` two hours out,
   state `done`, output collected. Spend about 0.016 USDC.
6. Drew: `BAZAAR_KEY_FILE=~/keys/bazaar-payer node scripts/bazaar-tick.mjs` so the catalog shows
   0.007; then decide on the landing republish.

## Risks and what is left to the builder

- The exact `toon` command that re-prices an existing app, and the exact edge admin call that
  re-prices a route (re-POST or delete and add), are read from `toon --help` and the connector's
  `/routes` API on the box at deploy time. Both are recorded in `docs/ops.md` afterwards.
- `TICKS_PER_MINUTE` (30 per IP) bounds paying ahead to 30 hours a minute, which is fine.
- The storefront's batch deposit minimum (0.10 USDC) now covers 14 hours. Unchanged on purpose.
- Tests that fix a 30 second interval stay as they are: the lease machinery is interval-agnostic and
  those tests prove it at the old value. New tests cover the idle threshold, the read budget, the
  poll period, the config defaults and the python wall flag.
