# Operating Charter

What watches the door, what backs it up, and what to do when something fires. Scripts live in
`deploy/ops/`. Amounts are micro-USDC (`1000` is 0.001 USDC). Installed 2026-10-27.

## What runs where

| what | where | schedule | alerts |
| --- | --- | --- | --- |
| door canary + door headroom + daily spend + host channel (`charter-ops-check.sh`) | the Hetzner box, `charter-ops.timer` | every 5 min | Telegram DM to Drew from the Edison bot, once down, once back |
| door data backup (`charter-backup-pull.sh`) | the Air, launchd `com.drew.charter-backup` | nightly 03:40 Air local | none yet: `~/charter-backups/pull.log` records each run |
| the host (`charter-host`, `CHARTER_MAX_LEASES=2`) | the `toon2` VM on the Air | always on | the canary sees its offer vanish |

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
every 10 minutes with a 30 minute lifetime, so under 5 minutes left means it stopped publishing). Run it by
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
- `no machines listed`: the host's relay offer is gone. Is the Air up and `toon2` running? `ssh air`, then
  `~/.local/lima/bin/limactl list` and `limactl shell toon2 -- systemctl --user status charter-host`. The host
  logs `offer published <id>` every 10 minutes; a paid write that fails shows there too. The Air is set not to
  sleep (`pmset -g` says `SleepDisabled 1`, held by caffeinate), so a missing offer is a crash or a network
  change, not a nap.
- `the only offer expires in N min`: same as above, caught a few minutes earlier. On 2026-10-28 this was the
  host's channel to the edge spent to its collateral (see "Host channel"); `charter-host` was up and logging
  `offer publish failed: ToonCliError` every 10 minutes. The journal truncates the toon error, so check
  `toon channel list` in toon2 first.

## Headroom and daily spend

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

## Host channel

The host pays the box's edge connector 1000 for every relay write, one every 10 minutes while it is up
(about 144000 a day, so 1 USDC is about a week), out of its outbound Solana channel
`8oBnwH4u…` (toon2 wallet `J6UrAZps…` to the edge's settlement key `4s2JSwCF…`). When that channel is spent
to its collateral every write fails, the offer lapses 30 minutes later and the storefront lists no machine.
That is what took the door down for 15 minutes on 2026-10-28 16:24Z: the 1 USDC from 2026-10-16 was gone.

`charter-host-channel.sh` watches it from the box. The host's wallet lives in the toon2 VM, but the edge
holds the other end of the same channel, so the script reads `GET /channels` on the edge connector with the
operator bearer token (`EDGE_CONNECTOR_URL`, `EDGE_BEARER_TOKEN_FILE`, the same read refuel's sweep makes)
and takes the row `HOST_CHANNEL_ID`. Headroom is `collateral - (watermark - landed)`: what is on chain and not
landed, minus the vouchers signed but not yet landed. It fails under `HOST_HEADROOM_MIN` (300000, about two
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

The burn is the republish cadence (a 30 minute offer rewritten every 10 minutes); stopping the host between
demos stops it, and a 20 minute cadence would halve it.

## Backup

Nightly at 03:40 Air local, `charter-backup-pull.sh` on the Air pulls `/root/charter-door/data` from the box as
`~/charter-backups/door-data-<UTC stamp>.tgz` (the ledger and its `.payments`, `.unpaid`, `.unblocks`
sidecars, `channels.json`, `channels.peers.json`, `x402-channels/`, `output/`; never `secrets/`), checks that
the tarball lists `data/channels.json`, and deletes tarballs older than 30 days. Zero cost, no account.

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

Run by hand: `~/bin/charter-backup-pull.sh` (pull now), `--list`, `--restore <tgz> <file> [dest]`.
Open question for Drew: an encrypted off-site copy (any S3-style bucket, or a second Mac) is a one-line
addition to the pull script once there is an account for it.

## Lease limit

`CHARTER_MAX_LEASES=2` on toon2 since 2026-10-27 16:17 EDT (was 1; backup `~/.config/charter/env.bak-20261027-premaxleases2`).
toon2 has 4 CPUs and 3 GiB (2898 MB, 2206 MB available with the toon node, its relay container and the host
running, no swap). Each live lease is one job container capped at 1 CPU and 1 GiB (a Python job's script is
capped at 768 MiB), so two fit with the node's own 700 MB; a third would not. Restarted with no live lease:
the host's `leases.json` had nothing in `booting`, `awaiting_first_tick` or `running` (the ledger's
`stopped` flag is not the signal: it stays `false` on leases the host closed), the door ledger's newest
lease was 2026-10-21, and the first offer republished three seconds after the restart.

Rule for the next change: a restart of `charter-host` closes every live lease as `host_restart`. Check the
host first: `limactl shell toon2 -- bash -lc 'jq "[.[] | select(.state==\"booting\" or .state==\"awaiting_first_tick\" or .state==\"running\")] | length" ~/.local/share/charter/leases.json'`
must print 0.

Proven 2026-10-27 20:51Z: two `POST /v1/leases` 16 seconds apart (`{"offerId": "<from /v1/offers>",
"python": {"script": "print(1)"}}`) both answered a `leaseId` in `awaiting_first_tick` (`dd84066f…` and
`8a7fa37f…`), where the old limit answered `busy` to the second. Left unticked, the host closed both as
`missed_tick` after the 90 second grace. Cost to the door: 2500 (two opens at 1000, five status reads at
100), visible as the day's unpaid spend. A third open would have answered `closedReason: busy`.

## A second host on the box? (investigation only, nothing installed)

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

## Still open for Drew

- The box now holds a copy of the Edison bot token. A dedicated alert bot (BotFather, two minutes) would keep
  a box compromise away from Edison's chats; swap the file in `/etc/charter-ops/` and nothing else changes.
- An encrypted off-site copy of the backups, if a second location is wanted.
