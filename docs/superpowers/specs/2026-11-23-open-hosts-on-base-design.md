# Open hosts on Base: Charter without TOON

Date: 2026-11-23. Status: awaiting Drew's approval. Decided by Drew: approach A, anyone can join,
probe plus track record (no deposit), renter money lands in the door wallet with a daily sweep, grants
only on hosts with a record.

## Intent

Charter stops using TOON and runs on Base and USDC only. Anyone with a machine can run `charter-host`,
point it at the door, and earn USDC on Base for every interval a renter pays. hel1 becomes the first of
many hosts instead of the only one.

Why (Drew, 2026-11-23):

- Grants. "x402-native agent compute on Base, settled through CDP" is a story Base and CDP grant
  reviewers fund. A path that also runs through ILP, Solana and Nostr is harder to explain and to fund.
- TOON's edge is thin for Charter: x402 now has batch settlement, and the only TOON hop Charter uses
  today is Drew's door paying Drew's own server. That hop costs upkeep (Solana channels to refill,
  Helius, a patched toon CLI, edge upgrades) and buys nothing.
- A network of hosts is the more interesting product than one rented server.

## What success looks like

- A stranger installs `charter-host` on a public machine, sets a Base address, registers with the door,
  passes the door's probe, and appears in `/v1/offers` without Drew doing anything.
- A renter pays the door exactly as today (x402 on Base, `exact` or `batch-settlement`, CDP Bazaar
  listing unchanged) and gets a lease on whichever host the door picks or the renter names.
- The host is paid in USDC on Base through an x402 channel from the door, and claims its money on its own.
- No TOON code, node, channel or relay is in Charter's path. hel1 runs the new protocol.

## Goals

1. Remove TOON from Charter: door to host, CLI to host, host settlement, offer publishing.
2. Door to host over HTTPS, with each host's paid routes (open, tick, status) behind its own x402 gate.
3. The door pays each host through an x402 `batch-settlement` channel on Base: one voucher per paid call,
   cashed by the host in batches.
4. Permissionless hosts: register, get probed, get listed, get ranked by track record, get dropped
   when they fail. No approval step.
5. Track record per host, visible to renters, used to rank offers.
6. Hosts set their own prices. The door adds a configurable fee on top, starting at 0.

## Non-goals (this design)

- The self-paying home and the spend-permission allowance (the next two projects, built on this one).
- Renters paying hosts directly (approach B). It stays reachable later because every host is already an
  x402 seller, but the door stays the only storefront for now.
- Hosts behind NAT with no public HTTPS address. v1 requires a public address.
- Verifying what runs inside a host's machine. Not possible; disclosed instead.
- Removing TOON from Edison's other tools (relay writes, l402, its toon node). Only its Charter rent and
  renew move to the door.
- Multi-chain. Base mainnet, USDC only.

## Anti-goals (a failure even if it works)

- Drew approving hosts by hand, or the door needing Drew for any step of a host joining.
- The door holding host money beyond what sits in channels: no ledger of debts paid out later, no
  deposits or bonds held by the door.
- A new on-chain contract. Only x402's deployed contracts on Base.
- Claims in docs or listings that hosts are vetted, safe, or private. Hosts are run by strangers and the
  docs say so.
- Breaking the renter side: the CDP Bazaar listing, `/v1/rent`, the MCP's tools and the grant fund keep
  working through the change.

## Constraints

- Base mainnet only (`eip155:8453`), USDC `BASE_USDC`. No devnet or testnet infrastructure.
- x402 library already in use: `@x402/evm` 2.28.0, which has `batch-settlement/client` (used today by
  the web page in `web/wallet.ts`) and `batch-settlement/server` (used by the door). `@coinbase/cdp-sdk`
  stays pinned at 1.60.0.
- CDP's facilitator refuses resource descriptions over 500 characters (`DESCRIPTION_MAX`).
- A renter pays one interval at a time; the door never owes a host more than it was paid, and never pays a
  host before the renter's payment verifies (today's rule in `payHostTick`, kept).
- `docker build` on hel1 needs `--network host`.
- No em dashes in anything that ships.

## Approaches considered

**A. The door pays hosts over x402. Picked (Drew, 2026-11-23).** Renter pays door as today; each host's
open, tick and status routes are x402-paid; the door pays them through one `batch-settlement` channel per
host. The door sees every lease, so the track record falls out of its ledger; Charter stays one Bazaar
entry; a host's risk is bounded by its channel; most of the payment code exists. Costs: the door funds a
small channel per host, so locked capital grows with host count; hosts need public HTTPS.

**B. Renters pay hosts directly; the door is only a directory and prober.** Most decentralized and the
door holds no money, but the door never sees real leases (track record only from probes), no per-tick
fee, every host is its own Bazaar entry, and the MCP and CLI must talk to many hosts.

**C. The door owes hosts and pays weekly from a ledger.** Least code, but hosts extend a week of credit to
Drew and the door runs a hot wallet paying strangers. Dropped: it fights "anyone can join".

Bad-host defense, picked (Drew): **probe plus track record**, no host deposit. A deposit needs either
custody of strangers' money or a new audited contract, and a cheat inside a host's machine cannot be
proven anyway.

## The design

### Parts

```
renter --x402 (exact | batch)--> door --x402 batch voucher--> host (charter-host + Caddy)
                                  |  probes, ledger, ranking      |  claims its vouchers via facilitator
                                  '-- /v1/offers, /v1/hosts       '-- GET /v1/offer, POST open/tick/status
```

### Host protocol (HTTPS, replaces the three TOON apps)

The host's three Express apps (`src/host/server.ts`: open, tick, status) are served over the host's own
public HTTPS address behind an x402 gate, instead of through the toon CLI's ILP apps.

- `GET /v1/offer` (free): the host's current offer as JSON. Replaces the kind 31390 relay event. The
  `Offer` type loses `ilpBase`, `sealKey`, `sealUrl` and `hostPubkey`; it gains `url` (the host's HTTPS
  base) and `payTo` (its Base address). A host's identity is its `url`; `payTo` may change.
- `POST /v1/leases/:id/ticks` (tick): paid at the offer's `tickPrice`, x402 `batch-settlement` only,
  `payTo` = the host's address. `POST /v1/leases` (open), `GET /v1/leases/:id` and output parts (status):
  free to the door. A registered offer must have `openPrice` and `statusPrice` of 0; the door refuses one
  that does not. Reason: today the door pays opens and reads out of its own pocket, and a stranger who
  priced them could rent from itself with a throwaway wallet and keep the open price, or use up the
  door-wide `DAILY_UNPAID_CAP` for every host. With only ticks paid, renting from yourself nets nothing.
  Request and answer bodies are what the TOON apps take and give today.
- A host serves only the door: its routes refuse a request not signed by the door's payer address
  (`CHARTER_DOOR_PAYER`, read from the door's `GET /v1/door`). Free routes are authenticated the same way
  (a signature over method, path, body hash and a timestamp). Direct renter payment stays out of v1, so
  every lease on a host is one the door sees and records.
- The host runs the same batch-settlement server code the door runs (`src/door/x402.ts`, `claims.ts`):
  its own claim key, channel records on disk, and timers that claim and settle through the facilitator.
  This code moves to a shared module both sides use.
- `charter-host` setup gains: `CHARTER_HOST_URL`, `CHARTER_HOST_PAY_TO`, `CHARTER_CLAIM_KEY_FILE`,
  `CHARTER_DOOR_URL` (the door to register with), facilitator URL (PayAI by default; needs no key).
  `install-host.sh` adds Caddy for TLS, as on hel1 today.
- On boot, and whenever its offer changes (free home slots), the host calls the door's register route.

### Door as payer

- The door holds a Base key (`CHARTER_DOOR_PAYER_KEY_FILE`) and runs the `batch-settlement` client with
  file storage. `HostApi` (`src/tenant/host-api.ts`) keeps its interface; a new HTTP implementation
  replaces the TOON payer behind it: each call is an x402-paid HTTPS request to the host.
- One channel per host. `@x402/evm` 2.28.0's batch server handles one request per channel at a time
  ("Channel is already processing a request") and needs each voucher to equal the amount charged so far
  plus this price. Only ticks are paid, so only ticks use the channel: the door keeps a per-host queue of
  paid calls, one in flight, oldest deadline first; a tick whose deadline passes in the queue is skipped
  unpaid on both sides (today's `DeadlinePassedError` path). Opens and status reads are free and do not
  wait in it.
- Channel funding, two tiers:
  - Unproven hosts (never passed a probe): the probe's channel gets the smallest deposit the facilitator
    accepts (0.10 USDC at PayAI today). All unproven channels together are capped at
    `CHARTER_PROBE_CAPITAL_CAP` (default 1 USDC), and the door starts at most `CHARTER_PROBES_PER_DAY`
    (default 10) first probes a day, first come first served. A URL waits in the queue past that. This
    bounds what junk registrations can lock up, however many URLs one operator makes.
  - Proven hosts: deposit topped up to `CHARTER_HOST_DEPOSIT` (default 0.50 USDC) when the host is first
    picked for a real lease. Total capped at `CHARTER_HOST_CAPITAL_CAP` (default 10 USDC); past it, a
    proven host stays listed as "waiting for funding" and is not picked. Ranking decides who is funded
    first when capital frees up.
- The door tops a channel up when a lease opens, never inside a tick's window, so an on-chain deposit
  never races a renter's deadline.
- The door accepts a host's channel terms only if `withdrawDelay` is at most 1 day. Idle refunds: hosts
  run the shared claims code with refund idle set to 7 days for the door's channel; a host that refunds
  sooner costs only a fresh deposit at the next open. The door withdraws a channel itself after 7 days
  with no lease, and at once for a dropped host.
- Keep today's money rules: verify the renter's payment, pay the host, settle the renter. A host that
  answers but fails is recorded as a loss against the host (today's `host_refused`).
- The door's x402 `payTo` becomes the door payer address, so renter money funds host channels (Drew,
  2026-11-23). Once a day the door sends everything above `CHARTER_SWEEP_KEEP` (default 15 USDC) to
  `CHARTER_SWEEP_TO` (Drew's EOA `0xbD87…2385`), so the key on the server never holds much more than the
  host capital cap. The sweep logs its transaction hash; a failed sweep alerts and retries next day.

### Joining, probing, ranking

- `POST /v1/hosts` `{ url }` (free, rate limited per IP and per URL): the door fetches `GET {url}/v1/offer`,
  checks it parses and its prices are under the door's caps (`MAX_OPEN_PRICE`, `MAX_TICK_PRICE`,
  `MAX_STATUS_PRICE`), and queues a probe. Answers `202 { state: "probing" }`.
- Probe: the door opens a paid `charter-job-python` lease on the host whose script hashes a random nonce
  the door picked; pays the open, one tick and the status reads; passes if the output carries the right
  hash within the interval. One probe per host per day at most, so a fake host cannot farm probe
  payments. A host that has never passed a probe is not listed.
- Re-probe: daily while listed, and at once after two failed real leases in a row. A failed probe hides
  the host until a later probe passes. Three failed probes in a row drop the host; it must register again.
- Track record (door ledger, per host url): probes passed and failed; leases opened; leases that ended
  `done` or `max_intervals` versus host-side failures (`boot_failed`, host refused, unreachable);
  intervals paid; last seen. Exposed as `record` on each offer in `/v1/offers`.
- Ranking: `pickRentOffer` picks among offers that serve the image by record first (hosts under a minimum
  success rate are skipped when a better one exists), then price. A renter may still name an offer.
  New hosts (no real leases yet) are picked only when nothing with a record fits, or by name.
- Homes: the probe checks a host runs jobs, not that its homes work. A host's home offer is marked
  "untested" until its first paid home lease reaches `running` with access published. An untested home
  offer is picked only when no tested one fits, or by name.
- A home's disk lives on one host. The door records which host holds each `homeId` (from the open's
  answer) and routes a re-open or renewal with the same keys to that host, whatever the ranking says. If
  that host is gone, the door answers `home_host_gone` rather than starting an empty home elsewhere; the
  client may then open fresh on purpose.

### Renter side

- Grant fund (Drew, 2026-11-23): the paymaster (`src/fund/paymaster.ts`, today `fits[0]`) picks only
  hosts with a record of at least `CHARTER_GRANT_MIN_LEASES` (default 5) finished paid leases and no failed
  probe in the last 7 days. If none fits, the grant waits rather than going to an unproven host.
- `/v1/rent`, `/v1/leases*`, `/v1/offers`, the grant fund, the CDP Bazaar entry: unchanged in shape.
  Prices are host price plus `CHARTER_DOOR_FEE` (micro-USDC per tick, default 0).
- The CLI (`src/cli.ts`) drops `CHARTER_PAYER=toon` and `toon-client` and pays the door over x402, the
  way the MCP does. `payer-service` keeps only what Hermes boxes still need for Charter (an x402 payer
  for the door); its TOON relay and extract routes leave Charter.
- Storefront and docs (`agents.html`, `llms.txt`, README, plugin skill, MCP text) say hosts are run by
  independent operators, show each host's record, and drop every TOON mention.

### Removed

`src/toon-cli.ts`, the TOON `Payer` implementations and `src/door/channel.ts`, `src/offer.ts`'s Nostr
event code, `src/tenant/offers.ts`'s relay fetch, host `landAll` and `offerTick` relay publishing,
`CHARTER_RELAY_URL`, `CHARTER_DOOR_HOSTS` (replaced by registration), the `toon` tag in `BAZAAR_TAGS`.

### Cut-over

1. Build behind the existing door; hel1 runs the new host beside nothing else (the old TOON apps stop).
2. Door switches; hel1 registers like any stranger and must pass the probe.
3. Live leases at cut-over: let them end or lapse; homes keep their disks and ports through the 7-day
   retention, so a tenant re-opens on the new path with the same keys.
4. Edison's box renews through the door over x402 from its Base key `0xB8C6…`.
5. Retire: toon node on hel1, edge peering and Solana channel `FEFVKrn2…`, the door's Solana channel
   `5akKFS2L…` and toon payer. Drain balances back to Drew. Republish landing, ClawHub skill, MCP
   (0.4.0), plugin skill.

## Calls made (Claude's, for Drew to check)

- Door fee starts at 0 and is per tick, not a percentage.
- Host channel deposit 0.50 USDC, total cap 10 USDC (20 hosts at once), idle withdraw after 7 days.
- Unproven hosts: 0.10 USDC probe channels, 1 USDC total, 10 first probes a day, first come first served.
- Host `withdrawDelay` accepted up to 1 day.
- Only ticks are paid between door and host; opens and status reads are free, which closes the
  rent-from-yourself trick.
- A host serves only the door in v1.
- Re-opens go to the host holding the home; the door never quietly starts an empty home elsewhere.
- Probe = python nonce-hash job, at most once a day per host; three failed probes drop a host.
- Host identity = its URL. One operator may run many hosts; nothing stops that.
- v1 hosts need a public HTTPS address; hosts behind NAT come later.
- `batch-settlement` only between door and host (no `exact`): the door is a repeat buyer.

## Left to the builder

- Module layout for the shared x402 server code between door and host.
- Storage format for host records and the probe queue (a JSON file beside the ledger is fine).
- Exact rate limits on `POST /v1/hosts`.
- How the host's register call retries.
- Test strategy, beyond: the door's HTTP `HostApi` against a real host app in-process with the
  `free-for-tests` gate, and one paid mainnet proof with hel1 registered as a stranger.

## Risks

- A host can lie inside its own machine (log tenants, skip the sandbox). Disclosed, not solved.
- A host can take a tick and stall: a renter loses one interval (about $0.007), the host's record drops.
- Probe farming: bounded to one probe per host per day, about one cent each.
- Facilitator costs: CDP's free tier is 1,000 on-chain transactions a month; deposits and claims count,
  vouchers do not. PayAI's terms for batch claims to be checked before launch.
- Capital: up to `CHARTER_HOST_CAPITAL_CAP` locked in host channels, recoverable by withdraw.
