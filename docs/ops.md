# Operating Charter

What watches the door, what backs it up, and what to do when something fires. Scripts live in
`deploy/ops/`. Amounts are micro-USDC (`1000` is 0.001 USDC). Installed 2026-10-27.

Since the open-hosts change (2026-11-23) nothing in Charter's path is TOON: renters pay the door over x402
on Base, and the door pays each host over its own x402 `batch-settlement` channel on Base. Hosts register
themselves and are run by independent operators. Sections marked "TOON era" describe the setup before that
change (the toon2 host, the door's Solana channel, the payer service) and stay as history.

## What runs where

| what | where | schedule | alerts |
| --- | --- | --- | --- |
| door canary + door headroom + daily spend + host channel + grant fund + homes' outside SSH (`charter-ops-check.sh`) | the Hetzner box, `charter-ops.timer` | every 5 min | Telegram DM to Drew from the Edison bot, once down, once back |
| door data backup (`charter-backup-pull.sh`) | the Air, launchd `com.drew.charter-backup` | nightly 03:40 Air local | none yet: `~/charter-backups/pull.log` records each run |
| the first host (`charter-host`) | hel1 since the open-hosts cut-over, registered like any host (the `toon2` VM on the Air before) | always on | the canary sees its offer vanish |
| the grant fund (`charter-fund`, container) | the Hetzner box, beside `charter-door` | loop, one cycle every 60 s | `charter-fund-check.sh`, in the 5 minute check |
| outside usage (`charter-usage-check.sh`) | the Hetzner box, in `charter-ops.timer` | every 5 min | Telegram DM to Drew, one per event |
| Charter's X account (`charter-social`, container) | the Hetzner box, beside `charter-door` | loops every 5 and 10 min, Telegram bot always on | its own Telegram bot to Drew: every post, reply, drop and loop error |
| home watch (`charter-home-watch.sh`) | the `toon2` VM, user timer `charter-home-watch.timer` | every 5 min | Telegram DM to Drew: a late tick, a lapse, a recovery |

Box side: `/usr/local/bin/charter-*.sh`, config `/etc/charter-ops/env` (template `deploy/ops/env.example`),
bot token `/etc/charter-ops/telegram.token` (root, 600, a copy of the Air's Hermes bot token), state and logs
in `/var/lib/charter-ops/` (`check.log` every run, `alerts.log` every send, `<key>.state` = ok or fail).
Install or update with `bash deploy/ops/install-box.sh` as root from a copy of `deploy/ops` on the box
(`rsync -a deploy/ops/ root@box:/root/charter-ops-src/` first).

Air side: `~/bin/charter-backup-pull.sh` (copy of `deploy/ops/charter-backup-pull.sh`), key
`~/.ssh/charter-backup`, tarballs in `~/charter-backups/`, plist `~/Library/LaunchAgents/com.drew.charter-backup.plist`
(copy of `deploy/ops/com.drew.charter-backup.plist`).

## Canary

`charter-canary.sh` fetches `GET /v1/door` and `GET /v1/offers` on the live door and fails when either is not
200, when the offers list is empty, or when the newest offer expires within 5 minutes (the host republishes
every 20 minutes with a 45 minute lifetime, so under 5 minutes left means it missed two publishes). Run it by
hand anywhere: `deploy/ops/charter-canary.sh` prints one line and exits 0 or 1. To see the failure path point
it at a wrong path: `CHARTER_DOOR_URL=https://charter.167-233-221-236.sslip.io/nope deploy/ops/charter-canary.sh`.

Proven 2026-10-27 20:50Z with the installed copy: `CHARTER_DOOR_URL=…/nope charter-canary.sh --alert` on the box
sent "🔴 Charter door down / GET /v1/door answered 404 (…/nope)" to Drew's Telegram at 20:50:21Z, a second
run stayed silent, and the timer's own command sent "🟢 recovered: Charter door down / door ok: 1 offer(s),
newest expires in 26 min / was down 0 min" at 20:50:47Z. A variable set on the command line wins over
`/etc/charter-ops/env`, which is what makes that test possible.

Alerting is `charter-alert.sh`: one message when a condition goes from ok to fail, one when it comes back, a
reminder once a day while it stays down (`REALERT_MINUTES`), nothing else. Each condition has its own key
(`door`, `headroom`, `unpaid`, `hostchannel`) so they never mask each other. Channels come from `/etc/charter-ops/env`:
Telegram (`TELEGRAM_BOT_TOKEN_FILE` + `TELEGRAM_CHAT_ID`) and, if set, `NTFY_URL` like the box's other
alerts (refuel, node-record, slop). With no channel set the state still changes and the send is only logged.

When "Charter door down" arrives:

- `GET /v1/door answered 000` or a 5xx: the door container or Caddy. On the box `docker ps`, `docker logs
  --since 10m charter-door`. A crashloop with "could not reach the connector client edge" means the box's
  connector is down (see the Helius notes in memory: never restart the connectors while the Solana RPC 429s).
- `no machines listed`: no host is listed. `GET /v1/hosts` on the door says each host's state (`probing`,
  `listed`, `hidden`, `dropped`) and record. A host the door cannot fetch stays listed 10 minutes, then is
  hidden until it answers; a failed probe, or two failed leases in a row, hide it until a probe passes. On
  the host: `systemctl --user status charter-host` and `curl -sS <CHARTER_HOST_URL>/v1/offer`.
- `the only offer expires in N min`: same as above, caught a few minutes earlier: the door has not read a
  fresh offer from the host for a while. (TOON era: on 2026-10-28 this was the host's channel to the edge
  spent to its collateral, see "Host channel".)

## Who reaches the door

The door appends one JSON line per request to `/root/charter-door/data/requests.jsonl`: time, method, path, status,
milliseconds, user agent, the referrer's host, and whether a payment header came with it. It never records the client
IP, the query string or the body. Past 5 MiB the file rolls to `requests.jsonl.1`, one old file kept.
`CHARTER_REQUEST_LOG=off` in door.env turns it off. The canary's own requests are in there too. On the box:

```bash
jq -r '.ua // "(none)"' /root/charter-door/data/requests.jsonl | sort | uniq -c | sort -rn | head -20
```

```bash
jq -r 'select(.paid or .p == "/v1/rent" or .p == "/openapi.json" or .p == "/llms.txt") | [.t,.m,.p,.s,.paid,.ua] | @tsv' /root/charter-door/data/requests.jsonl | tail -40
```

## Headroom and daily spend (TOON era)

The headroom half reads the door's Solana channel, which the open-hosts change retired: the door now pays
hosts from Base channels it funds itself ("The door's wallet" below). The daily spend half still holds.


`charter-headroom.sh` reads the same files the door reads, with no TOON client and no chain read:
`channels.peers.json` (the open x402 channel and its `depositTotal`), `channels.json` (`signedCeiling`, what
the door has signed on it) and `door-ledger.json.unpaid` (`{day, micro}`, today's door-paid spend). Headroom
is `depositTotal - signedCeiling`, the number the door logs at boot (`channel ready, headroom N`). It fails
under `HEADROOM_MIN` (300000) and when today's unpaid spend reaches `UNPAID_MAX` (400000 of the door's fixed
500000 cap). Run it by hand on the box: `charter-headroom.sh`.

"Charter door headroom low": a Solana channel cannot be topped up, so rotate it (docs/demo.md, "Channel
rotation"): Drew sends 2 USDC to the payer `DRSB3XhJ…` first, then `channel rotate` with the door stopped.
At 300000 the door still pays about 45 more leases of one tick, so there is time. The door itself refuses
opens under open + tick + 10000 (16000) and ticks under tick + 10000, so the alert comes long before renters
see 503 `capacity`.

"Charter door daily spend high": someone is running up what no renter pays for (opens, free reads, the
status read before each tick, losses). `jq` the ledger for the day's leases and `losses`; a payer who caused a
loss is already blocked by the door. At 500000 the door answers 503 `capacity` until 00:00 UTC. Nothing to
do unless it is abuse; the cap resets.

## Host channel (TOON era)

The toon2 host's Solana channel to the edge, for its relay writes. A host no longer writes to a relay and
holds no channel of its own; the door funds a channel to it.


The host pays the box's edge connector 1000 for every relay write, one every 20 minutes while it is up
(about 72000 a day, so 1 USDC is about two weeks), out of its outbound Solana channel
`8oBnwH4u…` (toon2 wallet `J6UrAZps…` to the edge's settlement key `4s2JSwCF…`). When that channel is spent
to its collateral every write fails, the offer lapses 45 minutes later and the storefront lists no machine.
That is what took the door down for 15 minutes on 2026-10-28 16:24Z: the 1 USDC from 2026-10-16 was gone.

`charter-host-channel.sh` watches it from the box. The host's wallet lives in the toon2 VM, but the edge
holds the other end of the same channel, so the script reads `GET /channels` on the edge connector with the
operator bearer token (`EDGE_CONNECTOR_URL`, `EDGE_BEARER_TOKEN_FILE`, the same read refuel's sweep makes)
and takes the row `HOST_CHANNEL_ID`. Headroom is `collateral - (watermark - landed)`: what is on chain and not
landed, minus the vouchers signed but not yet landed. It fails under `HOST_HEADROOM_MIN` (300000, about four
days) and when the row is missing or not `open`. A failed read (edge down, token unreadable) exits 1 without
touching the alert state, so one 5xx does not read as an empty channel. Run it by hand on the box:
`charter-host-channel.sh`; to see the failure path, `HOST_HEADROOM_MIN=2000000 charter-host-channel.sh`.

"Charter host channel low": top the channel up from toon2. On the Air:

```
~/.local/lima/bin/limactl shell toon2 -- bash -lc 'set -a; . ~/.config/charter/env; set +a; toon channel list; toon channel fund 8oBnwH4uFQNuuGH5tRKB36jCQ86MFgyvJwNfYpAPoJg5 --amount 1000000'
```

`toon channel fund` deposits into the open channel in place (proven 2026-10-28: funded, the next scheduled
republish went through, the alert recovered). The toon2 wallet must hold the USDC first (`toon wallet
balances`); after the 10-28 top-up it holds about 0.02 USDC, so the next one starts with a USDC transfer to
`J6UrAZpsnCJREvdp4V4JojfNP5TgCsv5Qkq6oURGo1mM` from Drew's wallet. If the channel was rotated, change
`HOST_CHANNEL_ID` in `/etc/charter-ops/env` to the new id from `toon channel list`.

The burn is the republish cadence: a 45 minute offer rewritten every 20 minutes since 2026-11-02 (it was 30
and 10 until then, 1 USDC a week). The 45 minutes lets one failed write pass without the storefront going
empty. Stopping the host between demos stops the burn.

## The door's wallet

The door's payer key (`CHARTER_DOOR_PAYER_KEY_FILE`, mode 0400) is one Base key. Its address is the renters'
`payTo` and what funds every host channel. It must hold:

- USDC on Base for host deposits: an unproven host's probe channel gets `CHARTER_PROBE_DEPOSIT` (0.10 USDC),
  all of them together at most `CHARTER_PROBE_CAPITAL_CAP` (1 USDC); a proven host's channel is topped up to
  `CHARTER_HOST_DEPOSIT` (0.50 USDC) when it is first picked for a lease, all of them together at most
  `CHARTER_HOST_CAPITAL_CAP` (10 USDC). Past the cap a proven host shows `funding: "waiting"` and is not
  picked. So keep at least the two caps plus a margin.
- A little ETH on Base: the sweep's transfer and the reaper's channel withdrawals pay gas from it.

The door starts at most `CHARTER_PROBES_PER_DAY` (10) first probes a UTC day, and a probe pays at most
`CHARTER_PROBE_MAX_TICK` (10000) for its tick. It withdraws a channel idle 7 days, and at once for a dropped
host (after its live leases end). Each host's channel config is pinned at its first deposit; a host whose 402
names another config is refused while the door has capital at risk with it, and the door withdraws its old
config's channels. No host holds more than about one deposit at risk. To drop a host by hand:
`docker compose -f deploy/door/docker-compose.yml run --rm charter-door node dist/door/main.js hosts drop <hostId>`. `CHARTER_DOOR_SELF_ADDRS` lists the box's own IPs so a registered URL
cannot point the door at itself; loopback and private addresses are refused anyway. `BASE_RPC_URL` is
where it reads channels and sends withdrawals. Capital in use: `capital.json` in the data dir; hosts and
their records: `hosts.json`, or `GET /v1/hosts`.

## Daily sweep

The door's payer wallet is the renters' payTo and funds host channels. Once a day (and at boot) the door sends
every USDC above `CHARTER_SWEEP_KEEP` (micro-USDC, default 15000000) to `CHARTER_SWEEP_TO`, which is required.
Channel deposits are already out of the wallet, so only the free balance is swept. The transfer is a Base USDC
`transfer` from the payer key, so the payer wallet must keep a little ETH for gas. A failed sweep logs at error
level with the prefix `charter-door sweep failed:`; the ops check can grep for it. A success logs the amount and
the transaction hash, never the key. With referrals on, the payouts run just before the sweep and the sweep keeps
what referrers are owed (see Referrals).

## Referrals

A rent request can name a referral address, and that address earns a share of every hour the renter pays for.
The door adds up what each address earned and pays it in USDC on Base from the door's own wallet. Design:
`docs/superpowers/specs/2026-11-25-referral-payouts-design.md`. For agents: README "Referrals".

**Config** (`door.env`; all five are in `docs/env.md`):

| variable | default | meaning |
| --- | --- | --- |
| `CHARTER_REFERRAL_BPS` | `0` | share in basis points; 0 turns accrual and payout off; at most 5000. The live door uses 1000. |
| `CHARTER_REFERRAL_MIN_PAYOUT` | `100000` | micro-USDC an address must be owed before it is paid (0.10 USDC) |
| `CHARTER_REFERRAL_DAILY_CAP` | `5000000` | micro-USDC all payouts together may total in a UTC day (5 USDC) |
| `CHARTER_REFERRAL_KEEP` | `5000000` | micro-USDC of free balance a payout must leave in the wallet (5 USDC) |
| `CHARTER_REFERRAL_HOSTS` | empty | comma list of host ids (64 hex) where the full share is earned; elsewhere it is capped at the door's fee on that lease, which is 0 today |

With the rate above 0 and the grant fund on (`CHARTER_FUND_TOKEN_FILE`), the door will not start unless
`CHARTER_FUND_ADDRESS` is set: without it the door cannot refuse the fund's own wallet as a referral, and hours
the fund pays earn nothing. Lowering the rate applies to the next hour paid, not to leases already open; at 0
nothing accrues or is paid, but `GET /v1/referrals/<address>` still answers and what was owed stays owed.

**Who pays.** The door's wallet. At the current price the wallet has no income of its own (a renter's hour comes
in and the same amount goes out to the host), so referral pay is funded by you topping up the payer address with
USDC on Base. Top it up at the current price: each hour paid on a listed host owes the referrer 10% of it, so a
rate of 1000 at 0.007 USDC an hour is 0.0007 USDC an hour owed, on top of the host deposits. The sweep leaves
what is owed in the wallet (it keeps `CHARTER_SWEEP_KEEP` plus the total owed), and a payout never takes the
free balance below `CHARTER_REFERRAL_KEEP`.

**The daily run.** At start and then once a day the door runs the payouts, and always before that day's sweep
(they share the timer; with the rate at 0 no run happens). For each address owed at least the minimum, oldest
first, it writes an `intent` line to `referral-payouts.jsonl` in the data dir, sends one USDC transfer, waits for
the receipt, and writes a `sent` line with the transaction hash. When the day's cap has less left than an address
is owed, the door pays what is left, if that is at least the minimum; the rest stays owed. Every payout started
that day counts against the day's cap, including ones that failed or are unresolved. Before each send the door
reads the wallet balance again (host channel deposits leave the same wallet during a run). A payout that is not
sent, or whose outcome is unknown, never lowers anything in the books by itself. The door never resends on its
own. A run stops at the first unresolved payout: a stuck transaction would make every later send from the key
fail the same way, so the addresses after it wait for the next run. On shutdown (a deploy restart, SIGTERM or
SIGINT) the door waits up to 130 seconds for an in-flight payout run before it stops, so a send is not cut off
mid-flight; if the run is still going after that, it stops anyway and the open intent is held at the next start. The files: `referrals.json` (per address earned, paid, hours; per home the bound address),
`referral-payouts.jsonl` (the payout log), `referral-ops.jsonl` (the operator's commands).

**Alerts** (the door prints `charter-door <text>` at error level, so the ops check can grep for
`charter-door referral`):

- `referral payout skipped: wallet short for <address>`: paying it would leave the free balance under
  `CHARTER_REFERRAL_KEEP`. Nothing was written for it. Top up the wallet; the next run pays it.
- `referral payout skipped: balance unreadable`: the wallet balance could not be read (RPC), at the start of the
  run or before a send. The run stopped there; nothing was written for the address it was about to pay. It
  retries at the next run.
- `referral payout reverted: <amount> micro-USDC to <address>; address held`: either the transfer was mined and
  failed, or the pre-send simulation reverted and nothing was broadcast.
  The amount stays owed and the address is held: it keeps earning but is not paid. Find out why (a USDC-blocked
  recipient is the usual cause), then `release` it.
- `referral payout not sent: <amount> micro-USDC to <address>: <reason>; retried next run`: the door could not
  even send it, so it closed the intent as failed. Nothing to do unless it repeats.
- `referral payout unresolved: <payoutId>, <amount> micro-USDC to <address>: <reason>; address held`: the send
  went out and the door could not learn the result (an RPC error, no receipt in time, or the transaction was
  replaced by another at the same nonce: `<hash> replaced by <hash>`). The money may have moved. The door holds
  the address, does not resend, and ends the run. The same alert is raised at start for an intent left open by
  a crash, without the reason: `referral payout unresolved: <payoutId>, <amount> micro-USDC to <address>;
  address held`. Grep for the common prefix `referral payout unresolved: <payoutId>`. Resolve it by hand
  (below). Until then the amount counts against the day's cap.
- `referral payout run failed: <reason>`: an unexpected error stopped the run. Read the log.
- `charter-door referral accrual failed: <reason>`: a store write failed on a renter's request. The request
  went through; the hour was not counted. Check the data dir (disk, permissions).

**The command.** `charter-door referrals ...` reads `CHARTER_DATA_DIR` only. Run it as the other door commands,
for example `docker compose -f deploy/door/docker-compose.yml run --rm charter-door node dist/door/main.js referrals`.
The writing forms append a line to `referral-ops.jsonl`; the running door applies it within a minute, and waits
while a payout send is in flight, so a command may take longer than a minute while one is. Exit codes: 0 ok, 1
nothing there, 2 usage.

```
charter-door referrals [list]
charter-door referrals resolve <payoutId> sent <0x tx hash (64 hex)>
charter-door referrals resolve <payoutId> failed
charter-door referrals release <0x address>
charter-door referrals bind <homeId (64 hex)> <0x address>
charter-door referrals unbind <homeId (64 hex)>
```

- `list` prints one line per address (`<address> earned <n> paid <n> owed <n>`, with `held: <reason>` when held)
  and one `open <payoutId> <amount> micro-USDC to <address>, written <time>` line per open intent. An intent
  still in flight (a send is waiting for its receipt) lists as open too, exactly like a stuck one.
  Example: `charter-door referrals`.
- `resolve <payoutId> sent <txhash>` counts that payout as paid in that transaction and closes the intent.
  Example: `charter-door referrals resolve 3f9c0a5e7d1b4c2a8e6f0b1d2c3a4e5f sent 0x<64 hex>`.
- `resolve <payoutId> failed` closes the intent as failed; the amount stays owed. Example:
  `charter-door referrals resolve 3f9c0a5e7d1b4c2a8e6f0b1d2c3a4e5f failed`.
- `release <address>` clears a hold, so the next run pays what is owed. It exits 1 for an address the store has
  never seen. Example: `charter-door referrals release 0xabc...` (the full 40 hex address).
- `bind <homeId> <address>` sets a home's referrer by hand, replacing any it had; `unbind <homeId>` removes it.
  Example: `charter-door referrals bind <64 hex home id> 0x<40 hex address>`.

**An unresolved payout.** Only resolve an intent that has raised a `referral payout unresolved` alert: an intent
that is merely in flight also lists as open, and it closes by itself when the send ends. For one that has, look the address up on a Base explorer first (basescan.org, the USDC contract's
transfers to that address, around the intent's written time), then choose:

- a USDC transfer of that amount from the door's wallet to that address is there: `resolve <payoutId> sent
  <txhash>`. The amount is counted paid once per payout id.
- no such transfer is there, and you are sure it will not land: `resolve <payoutId> failed`, then `release
  <address>`. The amount stays owed and the next run pays it. Never choose `failed` for a transfer that is
  still pending: it would be sent a second time.

Resolving does not release the hold; run `release <address>` after it.

**Restoring referral files from a backup.** Restoring an older `referrals.json` or `referral-payouts.jsonl`
makes money that was paid look owed, and the next run would pay it again. Before restoring either, set
`CHARTER_REFERRAL_BPS=0` (no run happens at 0), restore, reconcile every address's paid total against the
door wallet's USDC transfers on Base, and only then turn payouts back on.

## Backup

Nightly at 03:40 Air local, `charter-backup-pull.sh` on the Air pulls `/root/charter-door/data` from the box as
`~/charter-backups/door-data-<UTC stamp>.tgz` (the ledger and its `.payments`, `.unpaid`, `.unblocks`
sidecars, `hosts.json`, `capital.json`, `host-channels/`, `x402-channels/`, `output/`, and from the TOON era
`channels.json` and `channels.peers.json`; never `secrets/`), checks that
the tarball lists `data/channels.json`, and deletes tarballs older than 30 days. Zero cost, no account.
The same tarball carries the grant fund's `data/state.json` and `data/stops.json` (under
`charter-fund/data/`, only when they exist; never the fund's `secrets/`), and `pull.log` says `fund state.json
included` or `no fund state` on each run. `charter-backup-stream.sh` on the box is what adds them, so after
this change re-run `deploy/ops/install-box.sh` (it copies the script to `/usr/local/bin/`), and copy the new
`charter-backup-pull.sh` to `~/bin/` on the Air. Before restoring `referrals.json` or `referral-payouts.jsonl`,
read "Restoring referral files from a backup" under Referrals: an older copy makes paid money look owed. Restore one with
`charter-backup-pull.sh --restore <tgz> charter-fund/data/state.json`; stop the fund first, copy it to
`/root/charter-fund/data/state.json` owned by uid 1000, mode 600, then start it.

Access is a dedicated key, not the `toon_node` key: the Air did not have that key, and a forced command is
safer than a root shell on the box. The box's `authorized_keys` carries
`restrict,command="/usr/local/bin/charter-backup-stream.sh" ssh-ed25519 … charter-backup@air`, so that key
can only receive the tar (proven: `ssh -i ~/.ssh/charter-backup root@box id` returns the tarball, not `id`).
Backup of the old file: `/root/.ssh/authorized_keys.bak-20261027-prebackupkey`.

Proven 2026-10-27: first pull `door-data-20261027-201732.tgz` (103431 bytes, 23 entries), and
`charter-backup-pull.sh --restore <tgz> channels.json` put the live store (channel `5akKFS2L…`, signed 36000)
in `~/charter-backups/restore/data/channels.json`, byte for byte the box's file.

To restore for real (the door's deposit lives in `channels.json`): stop the door, copy the restored file to
`/root/charter-door/data/channels.json` owned by uid 1000, start the door, check `docker logs charter-door`
says `channel ready, headroom N`. A restored store older than the last signed voucher under-reports what was
signed, and the connector refuses a voucher below its watermark, so restore the newest tarball.

The files under `host-channels/<host>/config/` matter most since the open-hosts change: they name each of
the door's host channels on chain, cannot be rebuilt from chain, and the reaper needs them to withdraw the
door's deposits. Restore them before the door's first withdrawal round after a data loss. The check for
`data/channels.json` dates from the TOON era.

Run by hand: `~/bin/charter-backup-pull.sh` (pull now), `--list`, `--restore <tgz> <file> [dest]`.
Open question for Drew: an encrypted off-site copy (any S3-style bucket, or a second Mac) is a one-line
addition to the pull script once there is an account for it.

## Run a host

Anyone can run a host; hel1 is set up the same way as a stranger's. The steps are in README.md, "Run a
host"; every variable is in `docs/env.md`. In short:

1. `sudo HOST_NAME=<name> bash deploy/host/install-host.sh` on Ubuntu 24.04 amd64: docker, gVisor, Node 22,
   anon, the `charter` user, Caddy (pinned `caddy:2.10.2` image on the host network, unit
   `charter-caddy.service`, config `/etc/charter-caddy/Caddyfile`) terminating TLS for `https://<name>` in
   front of `127.0.0.1:7401`, and `~charter/.config/charter/env` from `deploy/host/env.example` when there is
   none. Ports 80 and 443 must be open for the certificate.
2. As `charter`, in its own checkout: the build (`npm ci && npm run build`), the images, the claim key
   (`node deploy/door/new-claim-key.mjs ~/.config/charter/claim-key`, which needs the build's dependencies),
   the env (`CHARTER_HOST_URL`, `CHARTER_HOST_PAY_TO`, `CHARTER_CLAIM_KEY_FILE`, `CHARTER_DOOR_URL`,
   `CHARTER_HOST_PORT`, and `charter-job-python` in `CHARTER_ALLOW_IMAGES`), then
   `systemctl --user enable --now charter-host`.

What happens next, and where to look:

- **Register.** The host posts its URL to the door (`POST /v1/hosts`) at boot, every minute until accepted,
  and when its free home slots change. The door fetches `GET <url>/v1/offer` (refusing a URL that resolves
  to a loopback, private or the door's own address) and answers `202 { "state": "probing" }`. The host logs only
  a refusal (`register with <door> answered <status>`, then a retry; `400 bad_url` or `bad_offer` names the
  problem).
- **Probe.** The door opens a `charter-job-python` lease whose script hashes a nonce, deposits the probe
  channel (0.10 USDC) if there is none, pays tick 0, and passes the host when the output carries the hash
  within one interval. At most one probe per host per day; first probes are limited per day across all
  hosts, so a new host may wait a day. A probe tick above 0.01 USDC fails (`price_too_high`).
- **Listed.** `GET <door>/v1/hosts` shows the state (`probing`, `listed`, `hidden`, `dropped`) and the
  record. Listed hosts are re-probed daily. Two host-side lease failures in a row (`boot_failed`, refused,
  unreachable) or a failed probe hide the host until a probe passes; three failed probes in a row drop it,
  and it must register again (a restart of `charter-host` does).
- **Earnings.** Vouchers land in `<CHARTER_DATA_DIR>/x402-channels/`; `charter-host` claims them through the
  facilitator when the door's channel has been quiet two intervals (10 minutes at least) or the door starts a
  withdrawal, and settles to `CHARTER_HOST_PAY_TO` every 10 minutes (log lines `x402 claimed`, `x402 settled`);
  it refunds the door's unspent deposit after a quiet week. `charter-host x402 status` lists the channel,
  `charter-host x402 claim` claims and settles now. Back that directory up.
- **Limits in v1.** The door is the only payer: the host refuses any request not signed by the door's payer
  address, which it reads from `GET <door>/v1/door`. A host needs a public HTTPS address; hosts behind NAT
  come later. Homes stay on the host that holds their disks, so a host that goes away strands its tenants'
  homes (`home_host_gone`) until the door drops it.

## Lease limit

`CHARTER_MAX_LEASES=2` on toon2 since 2026-10-27 16:17 EDT (was 1; backup `~/.config/charter/env.bak-20261027-premaxleases2`).
toon2 has 4 CPUs and 3 GiB (2898 MB, 2206 MB available with the toon node, its relay container and the host
running, no swap). Each live lease is one job container capped at 1 CPU and 1 GiB (a Python job's script is
capped at 768 MiB), so two fit with the node's own 700 MB; a third would not. Restarted with no live lease:
the host's `leases.json` had nothing in `booting`, `awaiting_first_tick` or `running` (the ledger's
`stopped` flag is not the signal: it stays `false` on leases the host closed), the door ledger's newest
lease was 2026-10-21, and the first offer republished three seconds after the restart.

Rule for the next change: a restart of the host program leaves running containers alone (jobs and
homes); only a lease whose container is not running at host start is closed, and a home in that state is
re-created when its paid time has not run out. A lease that is only created, not started (`booting` or
`awaiting_first_tick`), has no running container, so a restart closes it as `host_restart`. Check the
host first: `limactl shell toon2 -- bash -lc 'jq "[.[] | select(.state==\"booting\" or .state==\"awaiting_first_tick\")] | length" ~/.local/share/charter/leases.json'`
must print 0.

Proven 2026-10-27 20:51Z: two `POST /v1/leases` 16 seconds apart (`{"offerId": "<from /v1/offers>",
"python": {"script": "print(1)"}}`) both answered a `leaseId` in `awaiting_first_tick` (`dd84066f…` and
`8a7fa37f…`), where the old limit answered `busy` to the second. Left unticked, the host closed both as
`missed_tick` after the 90 second grace. Cost to the door: 2500 (two opens at 1000, five status reads at
100), visible as the day's unpaid spend. A third open would have answered `closedReason: busy`.

## A second host on the box? (TOON era, investigation only, nothing installed)

Since the open-hosts change a host needs no toon node: any machine with a public HTTPS address runs one
("Run a host" below). The measurements stay as history.


Measured 2026-10-27 on the Hetzner box (`ubuntu-4gb-fsn1-1`): 2 vCPUs (x86_64), 3809 MB RAM with 1762 MB
available and no swap, load 0.33, 24 GB free of 75 GB, Docker 29.9.2 with `runc` only (no `runsc`), 14
containers using about 1.4 GB together (lading-kubo alone 555 MiB of a 768 MiB cap; the connector, relay,
store, Caddy, Lading, L402 door, gas, anonfetch and the Charter door are the rest).

A second `charter-host` there would need a `toon` CLI node of its own (about 200 to 400 MB with its relay
container, judging by toon2), `charter-host` (40 MB, 170 MB peak), gVisor `runsc` (an apt package for
x86_64, fine), and 1 CPU plus 1 GiB per live lease. Memory allows exactly one live lease with about 300 MB to
spare, and the two vCPUs would be shared between the lease, the node that routes its payments, and everything
else on the box; a Python job at full tilt takes one of them for the whole interval. There is no room for
two leases and no room for growth, and a job that leaks would take the connector down with it. A clear host
on the box would also drop the hidden-host badge the toon2 offer carries, which is part of the pitch.

Honest answer: a separate small VPS. A Hetzner CX23 or CPX21 class machine (2 vCPUs, 4 GB) runs a toon node
plus two leases for about 4 to 6 EUR a month, with the same `deploy/host/` units, `runsc`, and a peering
from its node to the box's connector (`POST /peers` on both sides, one 2 USDC channel each way). It can be a
clear host (public IP, no Anyone, offer without `hiddenHost`), which is also the first non-home host in the
listing. The other path with no new box is Jonathan's node as the second host (memory, 10-25), which needs
his `max_packet_amount` raised past one tick. Neither is started; Drew picks.

## Changing a price

A host's price is its own env: set `CHARTER_TICK_PRICE` (and `CHARTER_INTERVAL_SECONDS` beside it) and
restart `charter-host`, after checking no lease is only created, not started ("Lease limit"). The door reads
the new offer within a minute or two; leases already open keep the price they opened with for both renter and
host, and new leases take the new one. A price above the door's probe cap (0.01 USDC a tick) fails the next
probe. Then read `/v1/offers` on the door, and rerun `scripts/bazaar-tick.mjs` once (a paid tick) so PayAI's
catalog shows the new price.

TOON era, kept as history: the tick price lived in three places, and all three must agree or one hop pays the difference: the host's
env (`CHARTER_TICK_PRICE`, with `CHARTER_INTERVAL_SECONDS` beside it), the `charter-tick` app on toon2's
`toon` node (what the edge pays toon2), and the edge's route for `g.toon.69b2a212547e7a9c.charter-tick`
(what the door, or any toon-node renter, pays the edge). The door needs no change: it snapshots each
lease's offer at open, so leases opened on the old price keep it, and new leases take the new offer.

Order: check for leases only created, not started, first (a `charter-host` restart closes those; running
containers, jobs and homes, are left alone), then toon2 env and app, then the edge route, then read `/v1/offers` on the door. After that, rerun
`scripts/bazaar-tick.mjs` once (a paid tick) so PayAI's catalog shows the new price; its entry only changes
on a payment.

Done 2026-11-04 (TOON era), 30 s at 5000 to one hour at 7000, no live lease, in this order:

1. toon2 (`ssh air`, `~/.local/lima/bin/limactl shell toon2`): back up `~/.config/charter/env`, set
   `CHARTER_INTERVAL_SECONDS=3600` and `CHARTER_TICK_PRICE=7000`. `toon change` has no `--price`, so the app is
   re-added: `sg docker -c "toon remove charter-tick --yes"` then
   `sg docker -c "toon add charter-tick --to relay --url http://127.0.0.1:7402/ --price 7000 --yes"` (each
   restarts the connector). `toon status` then lists the route at 7000. New code goes in as a tarball of
   `dist`, `src` and `package.json` built on the Mac (`scp` to the Air, `limactl copy` into the VM, untar over
   `~/src/charter`, which `~/.local/lib/node_modules/charter` links to); `chmod +x dist/host/main.js` after,
   or the unit loops on `Permission denied`. Then `systemctl --user restart charter-host` and
   `charter-host offer --print` shows the new interval and price.
2. Edge (the box): one signed operator write, which overwrites the route in place:
   `/opt/refuel/deploy/sign-write.sh -k /root/keys-refuel/operator-write.key -X POST -p /routes/peers -b '{"prefix":"g.toon.69b2a212547e7a9c.charter-tick","peer_id":"toon2","price":7000}' -u http://172.18.0.2:4000`
   (172.18.0.2 is `deploy-connector-rust-1`; the answer echoes the route with `"source":"runtime"`). Read back
   at `https://connector.mainnet.toonprotocol.dev/ilp` under `routes`.
3. Door: `cp -a /opt/charter /opt/charter.bak-<date>`, rsync the tree from the Mac (no `node_modules`, `dist`,
   `web/dist`, `.git`, `.superpowers`), `docker compose -f /opt/charter/deploy/door/docker-compose.yml up -d --build charter-door`
   (always name the service: the compose file also holds `charter-social`).
   `GET /v1/offers` shows the new offer once the host has published it; a bare `POST /v1/leases/<id>/ticks`
   answers 402 with the new amount on both schemes.
4. Proof over TOON from the `toon` VM (Edison's node): lease `d5668d8cc9a9c79a646d1c29a79c4063`, a 120 s python
   job, ticks 0 and 1 paid three seconds apart (`paidThrough` two hours out), `done`, stdout `hourly`, 15,400
   units in all.

## Homes

A home is a lease on `charter-home`: the renter's own box, with a 10 GiB disk kept between leases and
plain SSH in at the host's public address (`access.ssh`; an onion is optional). toon2 carries one (`CHARTER_MAX_HOMES=1`, counted inside
`CHARTER_MAX_LEASES=2`), so a home and one job can run at once. Design:
`docs/superpowers/specs/2026-11-04-home-image-design.md`; variables: `docs/env.md`.

**The Hermes image.** `charter-hermes` is `charter-home` plus Hermes Agent 0.22.7, the `charter` CLI and a default boot (design: `docs/superpowers/specs/2026-11-05-hermes-in-a-box-design.md`). Build order, in the VM: `docker build -t charter-home jobs/home` first, then from the repo root after `npm run build`: `docker build -f jobs/hermes/Dockerfile -t charter-hermes .`. Add `charter-hermes` to `CHARTER_ALLOW_IMAGES`. It is one moving tag, and the Hermes version is pinned in the Dockerfile (`HERMES_VERSION`, with the tarball's SHA-256). A rebuild reaches a running box only at its next re-create, never in place. Size: 1.94 GB on toon2 on the trixie base (842 MB shared `charter-home`; it was 1.73 GB on the 709 MB bookworm base), with Hermes app 186 MB, venv 360 MB, Python 92 MB, charter 136 MB. Memory in a live box: gateway 348 MB, payer 153 MB, renew 140 MB of the 1 GiB. The one home slot is Edison's while Edison lives there; a second home needs a grown VM or a second host.

**The base, and `charter-x402`.** Since the 2026-11-16 build `charter-home` is Debian trixie (glibc 2.41, Python 3.13, OpenSSH 10), 842 MB; it was bookworm (glibc 2.36), on which a binary built on a current distribution does not start (`GLIBC_2.39 not found`, OpenHuman's aarch64 release). `--build-arg BASE=debian:bookworm-slim` builds the old box. A disk outlives the image, so what a tenant built against the old base can break at its next re-create: a venv made with Debian's `python3` (3.11 then, 3.13 now) must be made again; a `uv` Python, Node modules and static binaries are untouched. The image also carries `charter-x402` (`/opt/x402`, 93 MB; source `jobs/home/x402-rent.mjs`): a tenant with only a Base wallet opens and renews through the door with it, `exact` only. The sshd now answers the SFTP subsystem, so a plain `scp` works; before, only `scp -O` did.

**A home paid through the door (TOON era).** Each tick a tenant pays the door by x402, the door pays the host 7000 out of its own Solana channel: about 0.17 USDC a day for one home. On 2026-11-16 that channel had 1.82 USDC of headroom, so one x402 home brings "Charter door headroom low" (under 0.30) in about 9 days, and a second halves that. The door earns the same amount on Base meanwhile; the outbound side still has to be rotated by hand (docs/demo.md, "Channel rotation"), with the door stopped. Rotate before a long-lived tenant arrives, not when the alert fires.

**Home watch.** `deploy/host/charter-home-watch.sh` reads the host's own `leases.json` and `homes.json` and says, for each home's newest paid lease: `fail` when it is running with under 20 minutes of paid time left (a tenant pays 30 minutes early, so the tick is at least 10 minutes late), `fail` once when it closed `missed_tick` with its disk still kept, `ok` otherwise. With `--alert` it sends through `charter-alert.sh` (keys `home-<homeId>` and `lapsed-<homeId>`): one message when a tick is late, one when the home lapses, one when a tick lands again. It runs in the host's VM, where the leases are, so it covers a home paid over TOON as well as one paid through the door. Run by hand: `charter-home-watch.sh` prints one line a home and changes nothing. To keep a test lease from paging, put its homeId (or the first 8 characters) in `HOME_WATCH_SKIP` in `ops.env`, space or comma separated; the watch then prints `skip` for it and drops its alert state without a "recovered". Installed on toon2 2026-11-16 18:19Z with the box's alert bot token (`~/.config/charter/telegram.token`, a third copy of the Edison bot token: see "Still open for Drew"). To install elsewhere: copy `charter-home-watch.sh` and `deploy/ops/charter-alert.sh` to `~/.local/bin/` in toon2, write `~/.config/charter/ops.env` from `deploy/host/ops.env.example` (a bot token file, or an `NTFY_URL`), copy the `.service` and `.timer` to `~/.config/systemd/user/` and `systemctl --user enable --now charter-home-watch.timer`. State and `alerts.log` are in `~/.local/state/charter-ops/`. Why: on 2026-11-16 Edison's home lapsed at 02:48Z and nobody knew for 14 hours. A tenant sees its own clock in the box: `/charter/paid-through`, or `charter-x402 status`.

A reload of Charter's anon (a new home's first publish, or a home's retire) resets every onion's circuits, so a tenant with an open SSH session on another home may have to reconnect, and a client whose Anyone circuit went stale needs a minute or two before the onion answers again.

The `charter-host` unit's `PATH` must include `/usr/sbin`, where `mkfs.ext4` for home disks lives; without it every home open answers `boot_failed` (the first deploy's failure), and the host log now says why.

**Opening or renewing from Edison's node (the `toon` VM, TOON era).** A paying `charter` command there needs the bridge env
first: `set -a; . ~/.config/charter/bridge.env; set +a` (`TOON_PASSPHRASE_FILE`, `CHARTER_OFFER_ID`,
`CHARTER_RELAY_URL`); a login shell has none of it and the CLI refuses with its usage text before paying, which
on 2026-11-05 left Edison's home closed for four hours. Dry-check a scripted open with a bogus offer id first
(it fails at "no live offer" after the free relay read). To move a home between images, do it inside one lapse
window: stop the box's `renew` right after a tick lands, and have the replacement open ready to run at the close.

**One payer per box (TOON era).** Since the open-hosts change a box pays the door with `charter renew` from
`CHARTER_KEY_FILE` (or `charter-x402 renew`), one `exact` payment a tick, so there is no channel to share and
no payer service. Before it: a tenant's channel store has exactly one writer: a voucher names a running total, so two processes signing on `~/.charter/channels.json` race it and the connector refuses the lower one. A box that pays for more than its rent (an agent's paid fetches, relay posts, its own Charter jobs) runs one `charter payer` (the service, `docs/env.md`) and every other payer in it uses `CHARTER_PAYER=url`. Edison's home does this since 2026-11-05: `~/.charter/boot.sh` starts the payer, then `renew` through it, then the Hermes gateway, whose plugins point at the same `http://127.0.0.1:3510`. To move a running `renew` onto the service without a missed tick: check `/charter/paid-through` (the next tick goes out 30 minutes before it), stop the old `renew`, start `charter payer`, start `renew` with `CHARTER_PAYER=url`, all inside a minute. Restart the payer only in that same window, and never `pkill -f` it from a command line that itself contains the pattern.

**What install-home.sh adds to a host (toon2, hel1).** Run from `deploy/host/` with sudo, as the
host user: `sudo ./install-home.sh` (or as root, `SUDO_USER=<host user> ./install-home.sh`). Where anon
comes from: with `ANON_BIN`, `ANON_GEOIP` and `ANON_GEOIP6` set, those files (hel1, below); unset, the
toon node's own anon and GeoIP files (toon2; the node must be up). Either way they are copied, so a
`toon` or package upgrade never touches the running one. Every step changes only what differs. It
installs:

- `charter-anon.service`: Charter's own Anyone client (`~/.config/charter/anon/anonrc` from
  `deploy/host/anonrc`, the anon copy at `~/.local/bin/anon`, the GeoIP copies under
  `~/.local/share/charter/anon/geoip/`). For homes it listens on the bridge gateway only: SOCKS
  `172.19.0.1:9050`, HTTP tunnel `172.19.0.1:9080`, DNS `172.19.0.1:53`, and with the onion on it
  serves one onion service per home from `~/.config/charter/anon/hs.d/` (charter-host writes
  `<homeId>.conf` there and sends a `SIGHUP`). For the host itself it also has SOCKS
  `127.0.0.1:9152`, loopback only, out of the homes' reach. Log: `~/.local/share/charter/anon/anon.log`.
- `charter-home-net.service` (after docker, every boot): runs `/usr/local/bin/charter-home-net.sh`,
  which makes the `charter-home` bridge (`172.19.0.0/24`, gateway `.1`, `enable_icc=false`, so home
  to home is refused by the network itself) and its full firewall, records the bridge name in
  `/var/lib/charter-home-net/bridge`, and cuts any conntrack flow a home started before the rules
  were in place (a backstop; needs the `conntrack` tool).
- `charter-home-fw.service` (before docker, every boot): `charter-home-net.sh --early`, the
  subnet rules only (the bridge has no interface yet), so docker's own restart of a home at boot
  never runs unfirewalled. docker `Requires=` it, so it fails closed: if it fails, docker does not
  start. It orders itself after `nftables`, `netfilter-persistent`, `ufw` and `firewalld`, so their
  ruleset load cannot flush it. Never restart it (that restarts docker and every container); to
  reapply the rules, run `sudo /usr/local/bin/charter-home-net.sh`.
- `/etc/sudoers.d/charter-home`: the host user may run `/usr/sbin/losetup` as root, nothing else;
  charter-host attaches each disk image with it.
- With `ANON_BIN` set only (hel1): a user drop-in,
  `~/.config/systemd/user/charter-socks.service.d/upstream.conf`, setting
  `CHARTER_SOCKS_UPSTREAM=127.0.0.1:9152` (see "Job egress" below). toon2's path writes none.

**Do not rerun install-home.sh on toon2.** The current anonrc adds `127.0.0.1:9152`, so a rerun
restarts charter-anon (every home's egress drops for a moment) and opens 9152 in the VM, which Lima
forwards to the Air's localhost. toon2 keeps the anonrc and firewall it has, so the checks below describe a host installed from the current scripts (hel1).

**hel1's install path.** On the fresh Ubuntu 24.04 box, as root from `deploy/host/`: `bash
install-host.sh` (docker, gVisor's `runsc` registered with docker, Node 22, Anyone's anon pinned by
version and sha256 and held, the package's own anon service masked, the `charter` user with linger),
then the line it prints: `SUDO_USER=charter ANON_BIN=/usr/bin/anon ANON_GEOIP=... ANON_GEOIP6=...
./install-home.sh`. Both are safe to rerun.

**The firewall, rule by rule** (from `charter-home-net.sh`; `br-...` is the bridge, the subnet is
`172.19.0.0/24`, the gateway `172.19.0.1`):

- `DOCKER-USER` (forwarded traffic), four lines: from the bridge, tcp from port 2222 in an
  `ESTABLISHED` flow in its reply direction is accepted (a home answers SSH that a client opened to
  its published port), then everything else from the bridge is dropped; then the same pair for
  `-s 172.19.0.0/24` (the early rules, kept under the bridge ones). A home never starts a
  connection: to the internet, the host's public address, another home or another bridge, its
  first packet is `NEW` and dropped. IPv6 gets the bridge pair in `DOCKER-USER` if that chain exists.
- `INPUT` (traffic to the host), eleven lines, in order:
  1. drop tcp 9050,9080 to `172.19.0.1` from anything but the bridge (job containers on docker0, the LAN);
  2. drop udp 53 to `172.19.0.1` from anything but the bridge;
  3. from the bridge, accept `ESTABLISHED,RELATED`;
  4. from the bridge, accept tcp 9050,9080 to the gateway (anon SOCKS and HTTP tunnel);
  5. from the bridge, accept udp 53 to the gateway (anon DNS);
  6. from the bridge, accept tcp 53 to the gateway;
  7. drop everything else from the bridge;
  8. the early rules, `-s 172.19.0.0/24 -i br-+`: accept tcp 9050,9080,53 to the gateway;
  9. accept udp 53 to the gateway;
  10. accept tcp from port 2222 in an `ESTABLISHED` reply flow (the host's own SSH to a home:
      docker-proxy, the home watch's probe);
  11. drop everything else from the subnet that is not on `lo` (loopback is the host's own traffic).
- `ip6tables INPUT`: drop everything from the bridge.

**Job egress, `CHARTER_SOCKS_UPSTREAM`.** `charter-socks.service` (a user unit, `deploy/host/`)
listens on `172.17.0.1:9150` (`CHARTER_PROXY=socks5://172.17.0.1:9150`) and runs
`charter-socks-connect` per connection: with `CHARTER_SOCKS_UPSTREAM` set (hel1, by the drop-in) it
joins `127.0.0.1:9152`, charter-anon's loopback port, since hel1's node is clearnet and runs no anon;
unset (toon2) it reads the toon node's current SOCKS port from the node's anonrc.

**Root homes, `CHARTER_HOME_ROOT`.** With `CHARTER_HOME_ROOT=1` (refused unless `CHARTER_RUNTIME=runsc`) every home made from then on is a root home: recorded with `layout: 2` in `homes.json`, its disk formatted for root, and its box run as root with eight capabilities (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, `KILL`, `SYS_CHROOT`) on five folders of that disk: `home/` at `/home/tenant`, `root/` at `/root`, and `sys/<image>/usr`, `etc`, `var` at `/usr`, `/etc`, `/var` (docker `volume-subpath` mounts, docker 26 or later). The tenant logs in as `root` or `tenant` with the lease's keys and `apt-get install` works; the offer carries `home.root: true`. A home whose record has no `layout` runs as before, whatever the setting. Design: `docs/superpowers/specs/2026-11-22-root-homes-design.md`.

Before the first box of an image on a root home the host runs `/app/seed.sh` from that image once (`docker run --rm --network none --user 0 ... --entrypoint /app/seed.sh <image> <image>`, on docker's own runtime), which copies the image's `/usr`, `/etc` and `/var` to `sys/<image>` on the disk, about 0.5 GiB in 3 s; the record's `sys` list names the images done. A failed seed answers `boot_failed` and is tried again at the next open. From then on a rebuilt image changes `/app` and `/opt` in that home and nothing else, so `home.sh`, `seed.sh` and the sshd configs (all under `/app`) still update, while packages do not.

Checked on hel1, 2026-11-22, in a paid home (lease 4960a1a5): `apt-get update` and an install take about 12 s through the Anyone proxy; root cannot open a raw socket, mount, or reach anything but the proxy; `tenant` cannot write `/usr`; packages, both logins and the host key survive a container restart and a reboot of the host. `sudo` does not work in the box (gVisor ignores the setuid bit on mounted volumes), so the docs tell tenants to log in as `root`.

**Building images on a host with `charter-job-egress`.** That unit drops everything docker0 forwards, and `docker build` runs its steps on docker0, so a build step that needs the network (apt, a download) fails with `Temporary failure resolving`. Build with the host's network: `docker build --network host -t charter-home jobs/home`, and the same flag for `charter-hermes`. Tag the old images first (`docker tag charter-home:latest charter-home:pre-<date>`) so a bad build can be undone.

**Home disk size, `CHARTER_HOME_DISK_GIB`.** Each new home gets a sparse ext4 image of that many GiB (default 2; hel1 runs 10 since 2026-11-22, on a 150 GB disk) and the offer advertises it as `home.diskGiB`. A home that already has a disk keeps it at the size it was made with. Before making a disk the host checks that free space, less what every existing image may still grow by (its full size less the blocks it holds), less the new disk, leaves 3 GiB; otherwise the open answers `boot_failed` (`no disk`). So the worst case, every disk full, never fills the host. What that costs: a renter who fills a disk and lets the lease lapse holds that space for the 7 days of retention, and enough of those refuse new homes until the sweep removes them. `du -sh --apparent-size <homes>/*/disk.img` against `du -sh` of the same shows committed against used.

**Job DNS, `CHARTER_JOB_DNS`.** The fetch job looks each name up itself before it lets a request go
(its guard against private addresses), so a job container needs a resolver. Docker's default hands it
the host's resolvers, and the names a renter fetches then leave from the host's own address. On hel1
they resolve over the Anyone network instead: `install-home.sh` run with `JOB_DNS_ADDR=172.17.0.1`
renders a second `DNSPort 172.17.0.1:53` into charter-anon's config, and `CHARTER_JOB_DNS=172.17.0.1`
in charter-host's env makes every proxied job start with `--dns 172.17.0.1`. With that in place
`charter-job-egress.service` forwards nothing from docker0 at all, port 53 included. Check from a
job-like container: `docker run --rm --runtime runsc --dns 172.17.0.1 busybox nslookup example.com`
answers, and the same with `--dns 1.1.1.1` times out. A lookup through anon takes about a second.

**The box's SSH check.** `deploy/ops/charter-home-ssh-check.sh`, installed on the box by
`deploy/ops/install-box.sh` and run every 5 minutes by `charter-ops-check.sh` (`charter-ops.timer`),
reads the door's ledger for leases still paid, asks the door once per lease whether it is a home
(cached in `/var/lib/charter-ops/home-ssh-<leaseId>.cache`), and probes each public `host:port` from
outside with `nc`: the banner must start `SSH-`. Three misses in a row alert under
`home-ssh-<homeId>`; one `recovered` when it answers again. Onion-only access is skipped (the home
watch in the host covers that). Run it by hand without `--alert` for one line a home.

Check, on the host:

```
systemctl status charter-anon charter-home-net charter-home-fw
systemctl list-dependencies --reverse charter-home-fw.service | grep docker   # docker requires it
ss -ltunp | grep 172.19.0.1            # anon on tcp 9050 and 9080, udp 53
ss -ltnp | grep 127.0.0.1:9152         # anon's SOCKS port for the host itself (not on toon2)
sudo iptables -S DOCKER-USER           # the four lines above
sudo iptables -S INPUT | grep -e br- -e 172.19.0.0/24   # the eleven lines above, in that order
sudo ip6tables -S INPUT | grep br-     # the IPv6 DROP
systemctl --user cat charter-socks.service   # as the host user, hel1: the upstream.conf drop-in
losetup -a                             # one line per attached home disk
```

The box's `/etc/resolv.conf` is the host's file (`<homesDir>/<homeId>/charter/resolv.conf`) pointing at anon's DNS port, because gVisor cannot use docker's embedded resolver.

**Testing the proxies.** They answer only from the home bridge, not from the VM shell, so test from
a container on it: `docker run --rm --network charter-home --dns 172.19.0.1 curlimages/curl -sS -m 10
https://example.com` must fail, and the same with `-x http://172.19.0.1:9080` must print the page.

**Restarts are now safe for homes.** A `charter-host` restart leaves a running home's container
alone and picks it up again. After a VM reboot docker's own auto-start of a home fails, because the
disk image is no longer attached: that is expected, one failed start in the docker log. charter-host
then re-attaches the disk with `losetup`, re-creates the container and starts it, and the lease's
`restarts` goes up by one, as long as the paid time has not run out. A home whose paid time ran out
while the host was down is closed `missed_tick`.

**`homes.json`.** `<CHARTER_DATA_DIR>/homes.json` (`~/.local/share/charter/homes.json` on toon2)
holds one record per home: `homeId` (the first 16 hex of the SHA-256 of the sorted keys), `port`
(the loopback port its sshd is published on, 22000 upward), `createdAt`, `paidOnce` (a lease on it
paid at least one tick) and `lastClosedAt` (when its last lease closed). Per home the files are
under `<CHARTER_DATA_DIR>/homes/<homeId>/`: `disk.img`, `hs/` (the onion keys) and `charter/`
(the `paid-through` file the box sees at `/charter`).

```
limactl shell toon2 -- jq . ~/.local/share/charter/homes.json
```

**The sweep.** Once an hour charter-host removes every home with no live lease whose `lastClosedAt`
is more than 7 days old: the docker volume, the disk image, the onion keys and the record. A home
whose lease closed without ever paying a tick is removed at close instead. Nothing else deletes a
home. Before creating a disk the host refuses the open (`boot_failed`, no disk) when less than 3 GiB
of the VM's disk would stay free.

**What the operator can see.** The disk is plaintext and any container can be entered with `docker
exec`; the agent-facing docs say so. Do neither without the tenant's say.

**Growing the Lima disk.** toon2's disk is a Lima setting: stop the VM on the Air (`limactl stop
toon2`), raise `disk` with `limactl edit toon2`, and start it again. Stopping the VM closes every
live job lease, and a home comes back only if its paid time outlasts the stop, so do it on a day
with no live lease (the `jq` line under "Lease limit" prints 0). Drew runs it. Done 2026-11-06: `limactl edit toon2
--disk 40 --memory 4` between the stop and the start (Lima 2.2.1); the root filesystem grew on boot by itself
(38G, 22G free), the whole stop-edit-start took 22 s, and Edison's home, paid an hour ahead, came back on its disk.

**After any VM restart: the node's start check.** `toon up` (toon CLI 0.3.0) refuses to start the connector unless
the settlement wallet `J6UrAZps…` itself holds 1 USDC and 0.01 SOL; USDC already in the open channel does not count.
With the node down the host cannot publish its offer or sell a tick, so every lease lapses at its paid-through time.
Keep at least 1 USDC idle in that wallet: a host-channel top-up must not drain it below 1. Check:
`journalctl --user -u toon-agent-node -b | grep -m1 "not funded"`; after funding,
`systemctl --user reset-failed toon-agent-node && systemctl --user start toon-agent-node`.

## Outside usage

`charter-usage-check.sh` (in the 5 minute check) sends Drew one Telegram message per event, never a
reminder: a new lease from a wallet not in `FIRST_PARTY_PAYERS` (`/etc/charter-ops/env`), such a lease
paying its second hour (a one-tick probe never does, so this is the signal of a real renter), a new grant
pitch, and the judge's decision on it. The open message (👀) never says "renter": paying x402 crawlers open
one-hour leases, and it notes when a wallet's earlier leases each paid one hour. Wallets in `PROBE_PAYERS`
(known crawlers) get no open message; their second hour (🟢) is still sent. It reads `door-ledger.json` and `grants.jsonl` in
`CHARTER_DOOR_DATA` and keeps the ids it has reported in `/var/lib/charter-ops/usage-seen.json`; delete
that file and the next run records everything as seen again without sending. The ledger records the offer,
not the image, so the message cannot say whether a lease is a home or a job. Dry run:
`USAGE_SHOW_ALL=1 charter-usage-check.sh` prints every message it would ever send and changes nothing.
Sends go through `charter-alert.sh usage event`, which always sends and keeps no state. Installed 2026-11-22.

## Grant fund

The fund gives a free month (720 hours) of a home to a pitch its judge approves. Pitches arrive free at the
door (`POST /v1/grants`); the fund process judges them, opens the home and pays each hour with plain x402
`exact` USDC on Base from its own wallet, to the door only, never more than 10000 micro-USDC a tick.

**What runs where.** The container `charter-fund` on the Hetzner box, beside `charter-door` (compose
`deploy/fund/docker-compose.yml`, image built from the repo root, no ports, `stop_grace_period: 90s` so a
stop lets a paid call of up to 60 s finish). Files under `/root/charter-fund` (uid 1000, mode 700):

- `fund.env`: `CHARTER_FUND_DOOR_URL` only, optional (`deploy/fund/fund.env.example`).
- `secrets/fund-key` (the fund's Base wallet key, from `node deploy/fund/new-fund-key.mjs <file>`, which prints
  the address to fund with USDC), `secrets/fund-token` (the same token the door reads as
  `CHARTER_FUND_TOKEN_FILE`), `secrets/judge-key` (a Gemini API key from AI Studio, billed to Drew's prepay; the judge is `gemini-pro-latest`), `secrets/rpc-url` (a Base RPC URL).
  The door's `door.env` also needs `CHARTER_FUND_ADDRESS` set to the fund's address.
- `new-fund-key.mjs` imports `viem`, so it runs only where the repo's `node_modules` is installed: either on
  the box from the repo checkout after `npm ci` (`cd <checkout> && node deploy/fund/new-fund-key.mjs
  /root/charter-fund/secrets/fund-key`), or on the Mac from the repo, then copy the key file to
  `/root/charter-fund/secrets/fund-key` over SSH and delete the Mac's copy. It writes the key 0400 and refuses
  to overwrite one.
- After creating the files, give them to the container's user and lock the directory:
  `chown -R 1000:1000 /root/charter-fund && chmod 700 /root/charter-fund`. The container runs as uid 1000
  (`node`) and each secret is 0400, so a key left owned by root cannot be read and the fund stops at boot.
- `data/state.json`: what the fund paid. Back it up; if it is lost the fund can pay a grant twice, and a file
  that does not parse stops the fund at boot instead of starting fresh. The nightly backup carries it (below).
- `data/stops.json`: what Drew stopped. Only the stop commands write it; the loop reads it at the start of
  every cycle, so a stop issued while the fund runs is never overwritten.
- `data/health.json`: `{ at, problems: [{ key, msg, at }] }`, written every cycle. A problem is dropped an
  hour after it was last reported.
- `data/public.json`: the last pot report sent to the door (address, balance, grants left, open).

**The loop.** Every 60 seconds: judge one queued pitch, open the oldest approved grant when a home is free and
the balance covers it, pay each live home its next hour (never further ahead than half an interval), then
report the pot to the door (`PUT /v1/fund/public`). The fund is `open` while it is not stopped and
`floor(balance / (720 x tick x 1.1))` minus the live grants is above zero; while it is not open it reports 0
grants left. With no report, or a last report more than 10 minutes old (the door stamps each one with its own
clock as `reportedAt`), the door shows the fund closed and answers `503 fund_closed` to new pitches, so a dead
fund never leaves intake open. Each grant has its own day cap of 24 x tick x 1.5 per UTC day. A pitch the
judge fails on 3 times (an unreachable API is not counted) is declined with `The judge could not read this
pitch.` A cycle that fails is a problem in `health.json`; the process keeps going.

**Stopping.** From the box:

```
docker exec charter-fund node dist/fund/main.js stop <grantId>   # one grant: nothing more is paid, its lease is left to lapse
docker exec charter-fund node dist/fund/main.js stop-all         # no new pitch is judged, no new grant opened, no tick paid
docker exec charter-fund node dist/fund/main.js status           # JSON, never the key
```

A stop takes effect at the start of the next cycle (within a minute). `grantId` is the 32 hex characters
`status` lists. Removing `stopAll` means editing `data/stops.json` by hand. A stop on a pitch still queued
declines it as unreadable when it reaches the front of the queue, with no model call.

**Judge problems.** A judge call that fails leaves the pitch queued and names the full grant id in the
problem. An unavailable API (no connection, 429, 5xx) and an operator fault (every other 4xx but 413: an
account out of credit, a bad key, a retired model) are never counted against the pitch, so they alert every
cycle and decline nothing: top up the AI Studio prepay or fix the key, and judging resumes. A call that runs past 120 s counts as unavailable. Any other failure
counts, and the third declines the pitch as unreadable. A pitch that keeps failing without being counted is
cleared with `stop <grantId>`.

**Reading status.** `address` and `balanceMicro` are the last report; `grantsLeft` and `open` are what the door
shows. Each grant lists its `id`, `state` (waiting, active, completed, ended), `fundTicks` (hours paid, at most
720), `opening` (an open sent and not yet answered), `openUnknown` and the first 8 characters of its lease.
`problems` repeats `health.json`.

**`open-unknown`.** The fund sent an open, never got the answer, and the retry came back `home_in_use`: a home
on that grant's keys may already be running and paid for, but the fund cannot see it. It pays nothing more on
that grant. Drew checks the host (toon2: `jq . ~/.local/share/charter/homes.json`, and `docker ps`) for a home on that
grant's keys, then stops the grant. The grant keeps producing a problem every cycle, so the ops check keeps
alerting until it is stopped; that is intended.

**Alerts.** `charter-fund-check.sh` (in `charter-ops-check.sh`) alerts under key `fund` when `problems` is not
empty or `health.json` is older than 10 minutes (the process is down: `docker logs charter-fund`). Run it by
hand: `charter-fund-check.sh` prints the state and alerts nothing; `--alert` alerts.

## Allowances

A person approves a Base spend permission once (on `https://charterhome.dev/allow?id=<allowanceId>`) and the
biller keeps one home paid from it: it pulls up to 24 ticks of USDC at a time into its own wallet and pays
the home's hourly tick through the door, exactly as the grant fund does. Design:
`docs/superpowers/specs/2026-11-24-spend-permission-allowance-design.md`.

**What runs where.** The container `charter-allow` on the Hetzner box, beside `charter-door` and
`charter-fund` (compose `deploy/allow/docker-compose.yml`, image built from the repo root, no ports,
`stop_grace_period: 90s`). Files under `/root/charter-allow` (uid 1000, mode 700):

- `allow.env`: `CHARTER_ALLOW_DOOR_URL` only, optional (`deploy/allow/allow.env.example`).
- `secrets/allow-key` (the spender key, from `node deploy/allow/new-allow-key.mjs <file>`, which prints the
  address; same rules as `new-fund-key.mjs` above), `secrets/allow-token` (the same token the door reads as
  `CHARTER_ALLOW_TOKEN_FILE`), `secrets/rpc-url` (a Base RPC URL). Each 0400, owned by 1000.
- The door's `door.env` needs BOTH `CHARTER_ALLOW_TOKEN_FILE` and `CHARTER_ALLOW_ADDRESS` (the address
  `new-allow-key.mjs` printed). Without either, no allowance route exists. With an address that is not the
  biller's key, the biller does nothing and reports `spender_mismatch` (below).
- `data/state.json`: what the biller pulled, paid and refunded, per allowance. Back it up (the nightly backup
  carries it); a file that does not parse stops the biller at boot instead of starting fresh.
- `data/stops.json`, `data/resolutions.json`: written only by the commands below; the loop reads them at
  the start of every cycle.
- `data/health.json`: `{ at, problems: [{ key, msg, at }], ethWei, usdcMicro }`, written every cycle. A
  problem is dropped an hour after it was last reported.
- `data/loop.lock`: the running loop's lock. A second loop on the same data dir (a `docker compose run`,
  a stray `node dist/allow/main.js` with no arguments) refuses to run and exits. The commands below never
  take it. A lock left by a crash is taken over by the next start: at once in the same container, after 5
  minutes from another one. Remove it by hand only when no loop runs anywhere.

**Alerts.** `charter-allow-check.sh` (in `charter-ops-check.sh`) alerts under key `allow` when `problems` is
not empty or `health.json` is older than 10 minutes (the process is down: `docker logs charter-allow`). Run
it by hand: no argument prints the state and alerts nothing; `--alert` alerts.

**The commands.** From the box; each takes effect at the start of the next cycle (within a minute):

```
docker exec charter-allow node dist/allow/main.js status                              # JSON: entries, stops, resolutions, problems; never the key
docker exec charter-allow node dist/allow/main.js stop <allowanceId>                  # revoke on chain, refund the credit, end as operator
docker exec charter-allow node dist/allow/main.js resolve-refund <allowanceId> sent    # the lost refund landed: credit 0, the end completes
docker exec charter-allow node dist/allow/main.js resolve-refund <allowanceId> unsent  # it did not land: the next cycle refunds again
docker exec charter-allow node dist/allow/main.js resolve-refund <allowanceId> abandon # it can never land: end as operator, no refund
```

`allowanceId` is the 32 hex characters `status` lists. `stop` is for a person who writes in; an agent stops
its own with its owner token (`POST /v1/allowances/<id>/stop`).

**A refund with no answer** (problem key `refund`). The biller sent the credit back to the person's account
and the answer was lost. It is never sent again blind, and the allowance does not end until Drew decides.
Look on Basescan for a USDC transfer from the biller's address to the account the problem names, of the
amount it names, after the time it names. Found: `resolve-refund <id> sent`. Not found (and the nonce has
moved on, so it is not pending): `resolve-refund <id> unsent`.

**A refund that can never land.** A refund that fails before it is sent (`the refund ... was not sent`) is
tried again every cycle. When it cannot succeed (the person's account is USDC-blacklisted, or the biller's
wallet holds less USDC than the credit), run `resolve-refund <id> abandon`: the credit is written off to the
entry's `abandonedMicro`, the allowance ends as `operator`, and the loop logs it (`docker logs
charter-allow`), not as a problem. The USDC stays in the biller's wallet; Drew settles with the person by
hand. `abandon` only applies to an allowance whose end is already decided (stop it first).

**Editing state.json by hand.** Only with the container stopped: the running loop rewrites the file every
cycle and would overwrite the edit. `docker compose -f deploy/allow/docker-compose.yml stop charter-allow`,
copy `data/state.json` aside, edit, check it parses (`jq . data/state.json`), then `start`. The one problem
that asks for this: a pull lost across a period reset (key `pull`, "the permission's period has reset
since"): if Basescan shows the pull landed, add its amount to that allowance's `creditMicro`.

**ETH for gas.** The biller pays gas for every pull, revoke and refund (on the spike an approve, two pulls and
a revoke used about 0.0000022 ETH together). Below 0.0001 ETH it reports `low_eth` with its
address: send ETH on Base to that address. About 0.0005 ETH lasts on the order of a thousand pulls.

**Other problem keys.**

- `spender_mismatch`: the door's `CHARTER_ALLOW_ADDRESS` is not the biller key's address. The biller does
  nothing at all until they agree. Fix `door.env` (and redeploy the door) or mount the right key.
- `price`: a lease asks more an hour than the price the person approved (the allowance's `tickMicro`).
  Nothing is paid or re-opened; the allowance's `reason` reads "price rose above what was approved". It
  resumes by itself if the price comes back down; otherwise the agent asks for a new link at the new price.
- `pull`: a pull would not go through for a reason the biller does not know (an unreadable revert). An
  approved allowance stays approved and is tried every cycle; stop it if it never clears.
- `tick`, `open`: a tick or re-open got no answer and its lease cannot be read. It is kept for an hour (or
  until an end is pending), then booked as spent: the person bears at most that one tick.
- `allowance`: one allowance could not be acted on this cycle; the message names it. "carries the same
  permission as another live allowance": look at both with `status` and stop the wrong one.
- `door`, `balance`, `cycle`, `stops`: the door, the RPC or a data file did not answer or read; the next
  cycle tries again.

**Task 9 deploy checks** (the mainnet proof, with Drew):

1. Docker was not run on the Mac: build the image on the box (`docker compose -f deploy/allow/docker-compose.yml
   build`) and check it starts.
2. `door.env` backup first (`.bak-<date>-preallow`), then set `CHARTER_ALLOW_TOKEN_FILE` and
   `CHARTER_ALLOW_ADDRESS`; deploy the door, then `charter-allow`.
3. `curl -sI https://charterhome.dev/allow | grep -ic content-security-policy` prints 1, and a real browser
   run shows the Coinbase dialog not blocked by `style-src` or `font-src` (widen for `/allow` only if so).
4. `charter-allow status` is clean and `charter-allow-check.sh` prints ok, with no `spender_mismatch`.
5. The smallest allowance the door takes is 720 ticks (30 days of the home): 5.04 USDC at 0.007.
6. The person-side cancel (`requestRevoke`) is proven before `CANCEL_TESTED` is set true in `web/allow.ts`;
   until then the page tells the person to ask the agent or the operator to stop it.

## charter-social

Charter's own X account: it posts when something real happens on Charter and replies to mentions, with no
human approval. Design: `docs/superpowers/specs/2026-11-24-charter-x-account-design.md`. Code: `src/social/`.

**What runs where.** The container `charter-social` on the Hetzner box, beside `charter-door`, from the same
image (`charter-door:local`, entry `dist/social/main.js`; compose `deploy/door/docker-compose.yml`). No ports,
no healthcheck. It reads the door's `data/` read-only, never sees the door's `secrets/`, and calls only the
door's free `GET /v1/offers`. One process: the Telegram bot (always polling, the kill switch), the event loop
(every 5 minutes), the mention loop (every 10 minutes) and the weekly loop (every 5 minutes, acts on
Mondays: a report to Drew at 13:00 UTC, the summary post at 15:00 UTC; a week with no outside hours paid gets
the report but no public summary). The loops start a minute after boot.

**Files.** Under `/root/charter-social`, owned by uid 1000 (the image's `node` user), mode 700:

- `social.env` (mode 600): from `deploy/social/social.env.example`. The X keys, the Gemini key and models,
  `TELEGRAM_CHAT_ID`, `CHARTER_SITE_URL`, `FIRST_PARTY_PAYERS` and `PROBE_PAYERS` (copy both from
  `/etc/charter-ops/env`), `DRY_RUN`, the caps. Startup refuses, and the loops stay idle with `/status` saying
  why: an empty `FIRST_PARTY_PAYERS`; any payer entry that is not `0x` and 40 hex digits; a
  `SPEND_CAP_USD_DAY` below 0.20 (one post with a link); a `CHARTER_SITE_URL` whose host contains a default
  banned word (token, airdrop, presale, guarantee, escape, jailbreak, unfenced, toon), so the old storefront
  name is refused; set it to `https://charterhome.dev`.
- `secrets/telegram.token` (0400): the token of a bot made for this service alone (BotFather). A token another
  process also polls breaks both.
- `config/` (read-only in the container, re-read every tick, so an edit applies within 5 minutes):
  `facts.md` (one fact per non-empty line, no comments: every line can be published; never a price, those
  come from `/v1/offers`), `rules.json` (extra banned words; the defaults always stay), `optins.json` (who may be
  named), `blocklist.json` (handles never replied to). Start from `deploy/social/*.example`. A file that does
  not parse stops all posting, with one Telegram alert an hour, until it is fixed; an absent file takes its
  default.
- `state/state.json`: what was posted and seen, the mention cursor, today's counters and spend, the pause
  flag, the heartbeat. A state file that does not parse is kept as `state.json.corrupt-<ms>` and the service
  starts paused.

Set up (as root on the box, with the repo tree at `/opt/charter` as for the door):

```
mkdir -p /root/charter-social/{state,config,secrets}
cp /opt/charter/deploy/social/social.env.example /root/charter-social/social.env        # then fill it
for f in facts.md rules.json optins.json blocklist.json; do cp /opt/charter/deploy/social/$f.example /root/charter-social/config/$f; done
read -rs TOKEN && printf '%s' "$TOKEN" > /root/charter-social/secrets/telegram.token && unset TOKEN   # paste the token, nothing echoes or lands in history
chown -R 1000:1000 /root/charter-social && chmod 700 /root/charter-social
chmod 600 /root/charter-social/social.env && chmod 400 /root/charter-social/secrets/telegram.token
```

**Build the image first.** `charter-social` has no `build:` of its own: it runs the door's image
`charter-door:local`, and an image built before this service existed has no `dist/social/main.js`, so the
container would crash-loop. With Drew's go, after the tree in `/opt/charter` is updated:
`docker compose -f /opt/charter/deploy/door/docker-compose.yml build charter-door`. That rebuilds the image
the door runs too, so the door picks up whatever code is in the tree the next time its container is
re-created. Only build; do not run a bare `up -d` or `up -d --build` here, which would re-create the door now.
`charter-social` is in the compose profile `social`, so a command without `--profile social` never sees it
and never needs `social.env`; door commands still name `charter-door`.

**First start, dry run.** Leave `DRY_RUN=1`, then
`docker compose -f /opt/charter/deploy/door/docker-compose.yml --profile social up -d charter-social` (naming the
service leaves the door alone). Telegram says `charter-social started: DRY_RUN on`. The first event tick records
everything already in the ledger as seen and posts nothing; the first mention read stores the newest mention
id and replies to nothing. From then on every post or reply it would make arrives as `would post: ...` or
`would reply: ...`. A dry-run event is marked seen and a dry-run reply reserves its conversation, the same
as a live one, so nothing from the dry run is posted after going live. Without a readable token file or
`TELEGRAM_CHAT_ID` the process exits (no kill switch, no service); any other missing setting leaves the loops
idle and `/status` lists it.

**`/status`.** Paused or live, `DRY_RUN on|off`, the last post and reply, today's counts, spend against
`SPEND_CAP_USD_DAY`, Gemini calls against `GEMINI_CALLS_CAP_DAY`, the heartbeat's age and any missing
setting. Other commands: `/pause`, `/resume`, `/delete <post id or x.com status URL>`. Only Drew's chat is
answered; a command other than `/pause` older than 10 minutes is refused.

**Going live.** Set `DRY_RUN=0` in `social.env`, then
`docker compose -f /opt/charter/deploy/door/docker-compose.yml --profile social up -d charter-social` (re-creating the container
is what re-reads the env file). Telegram says `DRY_RUN off`.

**Pausing.** `/pause` from Drew's chat stops every post and reply within one tick; it is honored however old.
`/resume` starts them again. While paused nothing is read from X and no Gemini call is made: events wait
(those older than 6 hours when resumed are marked seen, never posted) and mentions wait (older than 24 hours
are skipped). `docker stop charter-social` also stops it, without losing state.

**Adding an opt-in.** Only an id in `config/optins.json` is ever named, @-mentioned or given a wallet's
transaction link. Keys are lowercased on load:

```
{
  "renters": { "0x<payer wallet>": { "name": "Teeny", "handle": "teeny_agent" } },
  "grants":  { "<grantId>": { "name": "Some agent" } },
  "hosts":   { "<hostId>": { "name": "A host", "handle": "hostops" } }
}
```

The handle has no `@` and is optional. Posts from the next tick use it; nothing already posted changes.

**Limits it keeps by itself.** At most 4 event posts a UTC day (past that, events roll into the weekly
totals); 20 replies a day, 2 per author a day, 1 per X conversation ever; mentions older than 24 hours
skipped. `SPEND_CAP_USD_DAY` (default 2) counts X's per-call prices (`X_PRICE_USD` in `src/social/x.ts`) for
posts and mention reads. The loops stop for the rest of the UTC day once the day's spend could not cover one
more post with a link (0.20), and alert once. `GEMINI_CALLS_CAP_DAY` (default 200) stops them the same way: an
event or mention left by a refused Gemini call waits for the next day, it is not dropped. A Telegram
heartbeat older than 15 minutes blocks every post and reply and alerts `kill switch offline` once an hour.

**Alerts and failures.** Every post and reply, every dropped draft set (`post dropped: <event id>: <why>`),
`loop error: <loop>: <message>` at most once an hour per loop, unreadable door data or config once an hour.
A failed X post is retried on later ticks, at most 3 attempts, then given up with a message. A Gemini call that
throws (a 5xx, a timeout, a blocked or unparsable answer) is not a verdict: the event or mention waits for the
next tick, counted under the same 3 attempts, then `post dropped: <id>: gave up after 3 attempts` or
`reply dropped: gave up after 3 attempts`. Unreadable config files or door data keep the mention cursor where
it is, so nothing is lost (the 24 hour age limit still applies). Hours in every post are whole hours paid
(ticks times the lease's interval), not ticks. A host is announced only while it is listed. A post whose call
timed out or failed after X accepted it can be posted again on the next attempt; X refuses an exact
duplicate text, so at worst a reworded second post goes out: `/delete` it. The Monday report lists posts,
replies, mentions seen and skipped by reason, and spend; the state keeps only today's spend, not the week's.

## Still open for Drew

- The box now holds a copy of the Edison bot token. A dedicated alert bot (BotFather, two minutes) would keep
  a box compromise away from Edison's chats; swap the file in `/etc/charter-ops/` and nothing else changes.
- An encrypted off-site copy of the backups, if a second location is wanted.
