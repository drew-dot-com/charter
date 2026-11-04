---
name: renting-charter-compute
description: "Rent compute on Charter from an agent node with toon_cli's `toon` binary: read the kind 31390 offers on a relay, open a lease on a host, pay it one interval at a time, read its state and collect the job's output. Covers the fetch job (page texts and screenshots through a hidden exit), the python job (your script, no network) and the home (a box with a kept 2 GiB disk, SSH in over an Anyone onion address, renewed from inside with the charter CLI). Use when asked to run a script or fetch pages on a Charter machine, to rent a home or a box to live in, to rent compute over TOON, or to read what Charter offers. Every step after the offer read is paid. Run toon --version first."
toon_cli: ">=0.3, <0.4"
---

# Renting Charter compute

[Charter](https://github.com/drew-dot-com/charter) is a compute marketplace on TOON. A **host**
runs a machine, often a home machine with no domain and no open port, and publishes an **offer**.
A renter **opens a lease**, pays it one **interval** at a time, and a container runs the renter's
**job** for as long as the payments keep arriving. There is no account on either side: the
renter is whoever pays.

This skill says what each packet holds and how `toon`, the binary of
[toon_cli](https://github.com/toon-protocol/toon_cli), sends it. For what every `toon` command
shares (`--json`, exit codes, `--yes`, the passphrase, the spending limit) read the skill
`operating-an-agent-node`, in the `toon-cli` plugin of
[toon-protocol/toon-plugins](https://github.com/toon-protocol/toon-plugins). Where that skill
and this one differ about a `toon` command, that one wins; where this one and the Charter source
differ about a packet, the source wins (`src/tenant/host-api.ts`, `src/host/server.ts`).

## First, check the version

This skill covers the `toon_cli` versions in its `toon_cli` field above. Before anything else run:

```
toon --version
```

It prints `toon <version> (connector …, relay …)`. If the version is outside that range, or the
output is not in that form, stop: do not run the commands below, and tell the operator which
version you found and which this skill covers. If a command here is then missing from
`toon --help`, trust `--help`.

## Terms

- **Offer**: a signed Nostr event of kind `31390` with the tag `["L","charter"]`, published by a
  host to a relay. It names the machine, its prices, and where to send packets. It lives 45 minutes
  and is republished every 20, so one that has expired is a host that stopped.
- **Lease**: one job on one machine, identified by a 32 hex digit `leaseId` the host gives you.
- **Interval**: the slice of time one **tick** pays for (`intervalSeconds` in the offer, one hour on
  the live host since 2026-11-04; it was 30 s before). The container starts when tick `0` is paid, and keeps running while the paid
  time has not run out.
- **The three apps**: the host's `toon` node serves `charter-open`, `charter-tick` and
  `charter-status`, each at its own price and each answering only its own action. A packet paid
  for one can never reach another.
- **Job**: an **image** the offer lists plus its **args**. Three exist: `charter-job-fetch`,
  `charter-job-python` and `charter-home` (below; the home has its own section, step 8).

## Money: read this before renting

Every packet after the offer read is paid, and paid whatever the host answers: a `4xx`, a `5xx`
and a refused boot are all fulfilled packets. Prices are in the offer, in USDC base units
(`1000` is 0.001 USDC). On the first host:

| Packet | Price | USDC |
| --- | --- | --- |
| open (`openPrice`) | 1000 | 0.001 |
| one tick (`tickPrice`) | 7000 | 0.007 for one hour (about 5 USDC for 30 days) |
| one status read or one output part (`statusPrice`) | 100 | 0.0001 |

A python job that finishes inside its first interval costs about 9300: one open, one tick, two
status reads and one output part. The most a lease can cost is `openPrice + maxIntervals ×
tickPrice` plus the reads: decide `maxIntervals` before you open, state it to the operator when
the job is theirs, and never pay a tick past it. `toon limit show` says what the wallet may still
spend today; a refusal with `spending_limit` is reported, not worked around. The host closes a
lease whose tick is late, and refunds nothing for time already paid.

## 1. Read the offers

Offers are read for free from the relay the operator names. Charter's first host publishes to
`wss://relay.mainnet.toonprotocol.dev`:

```
toon event query wss://relay.mainnet.toonprotocol.dev --filter '{"kinds":[31390],"#L":["charter"]}' --json
```

From `events`, keep the newest event (highest `created_at`) for each pair of `pubkey` and the `d`
tag, and drop any whose `expiration` tag (Unix seconds) is in the past. What remains is one live
offer per machine. An offer is named `<pubkey>:<d>`; the first host's is
`cde9138bd4c20275874c01817024dba60eb17c3b6ffbadddd1fd78d9daf1fb91:toon2-fetch-1`.

The event's `content` is a JSON object:

| Field | What it is |
| --- | --- |
| `ilpBase` | The host's ILP address. The apps are `<ilpBase>.charter-open`, `.charter-tick` and `.charter-status`. |
| `sealUrl` | The host connector's `/ilp` URL, often an `.anyone` onion address. Every packet is sealed to it with `--seal-to`. |
| `sealKey` | The same connector's public key. `toon` seals to the URL, so this skill does not use it. |
| `openPrice`, `tickPrice`, `statusPrice` | The three prices, as decimal strings in base units. |
| `intervalSeconds` | How long one tick pays for. |
| `firstTickGraceSeconds` | How long after open the host waits for tick `0` before it closes the lease. |
| `cpu`, `memoryMiB` | The container's size. |
| `images` | The jobs the host runs. Open only a job whose image is listed. |
| `hiddenHost`, `hiddenEgress` | Whether the host is reachable only over Anyone, and whether the fetch job's traffic leaves through an Anyone exit. |
| `home` | On a host that runs homes: `{"diskGiB": 2, "retentionDays": 7, "slots": 1}` on the first host. |

Save the one you will rent as a file (`offer.json`, the parsed `content`): the commands below
read `ilpBase`, `sealUrl` and the prices from it.

## 2. Reach the host

Your node needs a route to `ilpBase` through one of your peerings. `toon route list --json`
shows them under `forwarding_routes`. Without one, a send is rejected `F02` (no route) and pays
nothing; add one with `toon route add <ilpBase> --peer <peering id>`, where the peering is one
that reaches the host's network (`toon peer list`). A node with no peering at all needs the
operator: peering deposits money and is theirs to decide.

Then probe the status route once. It carries no amount, so it pays nothing:

```
toon probe <ilpBase>.charter-status --seal-to <sealUrl> --method GET --path /leases/0 --json
```

Read `cost`. When it equals `statusPrice` and `"complete": true`, the path charges nothing to
forward and the offer's prices are what you pay. When it is higher, a connector on the way
charges to forward: stop and tell the operator the cost, since the other two prices would then be
wrong too. A reject with no `cost` (`F02`, a peer that could not be reached) names the problem in
`reject.code`; fix the route or report it.

A probe stops at the first connector that wants paying, so it proves the route to your peer, not
the host. Prove the host with one paid status read of a lease that does not exist (one
`statusPrice`, 0.0001 USDC on the first host):

```
toon send <ilpBase>.charter-status --seal-to <sealUrl> --method GET --path /leases/00000000000000000000000000000000 --amount <statusPrice> --yes --json
```

`response.status` `404` with `{"error":"not_found"}` is the host answering: it is up, and the
onion circuit to it is now warm. `T01` (`peer … unreachable`, or the host's app) after about 30 s
is a packet that did not make it in time; a hidden host's first packet after a quiet spell can
take that long. Wait a minute and try the read again before you open anything, because an open
that times out may still have created a lease on the host (see "When it refuses").

## 3. The job

The open packet's body is `{"job": {"image": <image>, "args": {...}}}`, written to a file.

**`charter-job-fetch`**: `args.URLS` is 1 to 5 `http(s)` URLs joined by commas (no URL may contain
a comma). A headless browser loads each one through the host's exit and the output is
`{"pages": [{"url", "text", "jpegBase64"}]}`, the text capped at 32 KiB a page.

```
{"job":{"image":"charter-job-fetch","args":{"URLS":"https://example.com,https://api.ipify.org?format=json"}}}
```

**`charter-job-python`**: `args.SCRIPT` is the Python 3 source, at most 8 KiB of UTF-8, no NUL.
It runs with NumPy and no network at all, so it must print what it wants returned. The output is
`{"kind": "python", "exitCode", "signal", "timedOut", "seconds", "stdout", "stderr",
"stdoutTruncated", "stderrTruncated"}`.

```
{"job":{"image":"charter-job-python","args":{"SCRIPT":"import numpy as np\nprint(np.arange(5).sum())\n"}}}
```

**`charter-home`**: `args.SSH_KEYS` is 1 to 8 SSH public key lines joined by a newline, each an
`ssh-ed25519`, `ecdsa-sha2-nistp256|384|521` or `ssh-rsa` line under 1024 bytes. Public keys
only. Step 8 says what you get.

```
{"job":{"image":"charter-home","args":{"SSH_KEYS":"ssh-ed25519 AAAA... comment"}}}
```

Write the file with a JSON encoder, never by hand, so the script's newlines and quotes are escaped.
A job the host cannot take answers `closedReason: "boot_failed"` with `error` `image_not_allowed`,
`arg_not_allowed` or `bad_input`, and the open is still paid.

## 4. Open

```
toon send <ilpBase>.charter-open --seal-to <sealUrl> --method POST --path /open --body job.json --amount <openPrice> --yes --json
```

The report's `response.body` is a string holding JSON. Parse it:

- `{"leaseId": …, "state": "awaiting_first_tick"}`: the container is created, not started. Pay
  tick `0` within `firstTickGraceSeconds` (90 s on the first host) or the host closes it.
- `{"leaseId": …, "state": "closed", "closedReason": "busy"}`: the host is running another
  lease, or its home slot is taken. Wait and try later; do not retry in a loop.
- `{"leaseId": …, "state": "closed", "closedReason": "home_in_use"}`: a live lease already holds
  the home your keys name (step 8).
- `{"leaseId": …, "state": "closed", "closedReason": "boot_failed", "error": …}`: the job was
  refused or did not boot. The open is paid; nothing else is owed, and the lease has nothing
  more to say.
- `response.status` `400` with `{"error": "bad_request"}`: the body was not a job. Still paid.

## 5. Tick, then keep the lease alive

Each tick is `{"leaseId": <id>, "index": <n>}`, `n` counting from `0`, to the tick app at
`tickPrice`:

```
toon send <ilpBase>.charter-tick --seal-to <sealUrl> --method POST --path /tick --body tick.json --amount <tickPrice> --yes --json
```

The answer is `{"paidIntervals", "paidThrough", "duplicate"}`. `paidThrough` is the host's
clock (epoch ms) when the paid time runs out; a tick with the same `index` twice is
`duplicate: true` and buys nothing. Tick `0` starts the container. Keep your own estimate of the
paid time, as the host extends it by one interval from its current end: `paidUntil = (paidUntil
or now) + intervalSeconds × 1000` on each tick that is not a duplicate.

Count from the moment you sent the tick, not from when the answer came back: the host's clock
ran while the packet travelled.

Then, for as long as you want the job to run and have ticks left under `maxIntervals`:

1. Read the lease (step 6) 10 s after the tick, then at doubling gaps (20 s, 40 s, 80 s and so
   on), and last at halfway through the paid interval (30 minutes before `paidUntil` on a one
   hour interval). A job that exits in seconds is then seen in seconds, and an hour of watching
   costs at most nine reads. On every read: `done`: fetch the output and stop. `closed`: stop.
   To pay ahead instead, send the next indexes now, in order: each adds an interval. The host
   gives only 10 s of grace past `paidUntil`, and one packet to a hidden host can take 15 s, so a
   read and a tick started 10 s before the end arrive too late. A tick paid early extends the
   paid time from its current end, so nothing is lost by being early.
2. At the halfway read, `running` with `paidIntervals` below the ticks you sent means the host
   did not count a tick: stop paying.
3. Otherwise pay the next tick, `index` one higher.

After the last tick you will pay, watch the paid time out the same way, with a last read at its
end, and stop. A
tick answered `409` with `lease_done` or `not_running` is a lease that has ended: read it, and
never retry the tick. `409 missed_tick` is a lease the host closed for a late tick. A tick
answer with no `paidThrough` is a host you do not pay again: read the lease once and stop.

The timing is tight for a 30 s interval, so run the loop as one command rather than one step at
a time: `references/lease-loop.sh` beside this skill does steps 4 to 7 with `toon` and `jq` and
prints one JSON document. Read it before running it; it spends.

## 6. Read the lease

```
toon send <ilpBase>.charter-status --seal-to <sealUrl> --method GET --path /leases/<leaseId> --amount <statusPrice> --yes --json
```

`response.body` holds `{"lease": {...}}` with `state` (`booting`, `awaiting_first_tick`,
`running`, `done`, `closed`), `paidIntervals`, `paidThrough`, `closedReason` (`boot_failed`,
`missed_tick`, `max_intervals`, `host_restart`, `busy`, `home_in_use`), `outputParts` once the job
has written its result, and `landing` once the host has redeemed the lease's vouchers on chain
(`chain`, `tx`). A home lease also has `homeId`, `restarts` and `access` (step 8), and never
reaches `done`. `404 not_found` is a lease this host never had.

## 7. Collect the output

A `done` lease with `outputParts` has its result in parts of 48 KiB, each one paid status read:

```
toon send <ilpBase>.charter-status --seal-to <sealUrl> --method GET --path /leases/<leaseId>/output/<n> --amount <statusPrice> --yes --json
```

`response.body` holds `{"part", "parts", "data"}` with `data` base64. Fetch parts `0` to
`parts - 1`, decode and join them in order, and parse the result as JSON (step 3 says what each
job writes). `409 unpaid` is a lease whose tick `0` was never paid; `404 not_found` is a part
past the end or a lease with no output yet.

## 8. A home

A home is a lease on `charter-home`: a box with a disk that outlives the lease, reached over SSH.
It runs while it is paid, at the same `tickPrice`, and never finishes by itself. The first host
has one home slot (`home.slots`); while it is taken an open answers `busy`, and a second home
needs a second host.

### Rent it with the charter CLI

The `charter` CLI in the [Charter repository](https://github.com/drew-dot-com/charter) runs the
open, the ticks and the reads above for you, through the same `toon` binary (it reads
`TOON_PASSPHRASE_FILE`). Install it with Node 22 or later:

```
git clone https://github.com/drew-dot-com/charter && cd charter && npm ci && npm run build && npm install -g --prefix ~/.local .
```

Put your public keys in a file, one per line, then:

```
charter rent --offer <pubkey>:<d> --home keys.pub --max-intervals <n> --relay wss://relay.mainnet.toonprotocol.dev
```

It opens, pays tick `0` at once and keeps paying until `<n>` ticks are paid and watched out, so it
runs for about `<n>` hours: run it in the background, or with a small `<n>` and let the box
renew itself (below). Once a read shows the address it prints the `ssh` line on stderr. To keep
paying a lease that is already open (yours, or one opened from elsewhere):

```
charter renew --offer <pubkey>:<d> --lease <leaseId> --max-intervals <n> --relay wss://relay.mainnet.toonprotocol.dev
```

`renew` reads the lease, pays from the host's own count of paid ticks, and sends its first tick at
once. `--from <index>` is optional; when given it must equal that count, or nothing is paid.
`references/lease-loop.sh` also pays a home's ticks: since a home never reaches `done`, it runs
until `<max-intervals>` ticks are paid and watched out, then exits 0. It never prints the address:
read the lease (step 6) for it.

### Find it and get in

A running home's lease has:

```
"homeId": "<16 hex>",
"restarts": 0,
"access": {"ssh": {"host": "<56 characters>.anyone", "port": 22, "user": "tenant"}}
```

`access` is `null` until the host has published the home's onion address, within
about a minute of the first tick: read the lease about once a minute until it is set (each read
is one `statusPrice`). `restarts` counts the times the host re-created the box. Then:

```
ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@<host>
```

Your toon node has an Anyone SOCKS port: that is the one to use. No Anyone client, no way in:
there is no clearnet address. The keys you opened with are the only logins. The box's host key
is made once on your disk, so its fingerprint stays the same across restarts and leases; pin it
the first time.

### What is inside

- Debian bookworm-slim. User `tenant` (uid 10001), no root, no setuid programs. Python 3 with
  `venv` and `pip`, `uv`, Node 22, `git`, `curl`, `jq`, `rsync`, `tmux`. 1 CPU, 1 GiB, 512
  processes.
- `/home/tenant` is your disk. The root filesystem is read-only; `/tmp` is 256 MiB in memory.
- `~/.charter/boot.sh`, if it exists and is executable, runs in the background at every start,
  output in `~/.charter/boot.log`. Put what must come back after a restart there.
- `/charter/paid-through` holds the epoch ms the paid time runs out, rewritten on every tick.
  `CHARTER_LEASE_ID`, `CHARTER_HOME_ID`, `CHARTER_OFFER_JSON` and `CHARTER_CONNECTOR_URL` are in
  the environment.
- Network: everything leaves through the host's Anyone client. `HTTP_PROXY` and `HTTPS_PROXY`
  are `http://172.19.0.1:9080`, `ALL_PROXY` is `socks5h://172.19.0.1:9050`, names resolve over
  Anyone, and `NODE_USE_ENV_PROXY=1` is set for Node; all of it in every SSH session and in
  `boot.sh`. A program that opens a raw socket to the internet fails. The box reaches nothing on
  the host or its LAN. It is slow, hidden, and sometimes refused by a service that dislikes
  shared exits.

### The disk and the keys

- 2 GiB, ext4. Kept 7 days, free, after a lease that paid at least one tick closes; removed at
  once when a lease that never paid a tick closes.
- The key set is the home's identity: `homeId` is a hash of the sorted keys. The same keys open
  the same home, on the same disk and the same onion address. There is no key rotation: a
  different set is a different home, and a lost private key is a lost home once the retention
  runs out. Two homes need two key pairs.
- Anyone with your public keys can open your home and hold it, though not enter it: while their
  lease lives yours is refused (`home_in_use`). A key whose public half you have shown nobody,
  added to the set, prevents that (it makes a new home).
- The operator can read your disk, and can enter any container on the machine. Keep secrets
  elsewhere or encrypt them.
- Secrets go in over SSH, never through Charter; the open carries public keys only:

  ```
  scp -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" .env tenant@<host>:
  ```

### What the host promises about uptime

- No uptime figure. Expect restarts. Your disk survives them; your processes do not, so put what
  must run in `~/.charter/boot.sh`.
- A tick pays an hour from the end of the paid time. Pay the next tick half an hour early (the
  tenant loop already does) so a short outage does not end the lease. Paying several ticks ahead
  buys that much patience and nothing else; a lease that closes refunds nothing.
- A closed home keeps its disk and onion address for 7 days. Open again with the same keys.
- A restart of the host program leaves a running home alone. A reboot of its VM puts a paid home
  back on its disk (`restarts` goes up), as long as the paid time has not run out.

### Paying from inside

The first open and tick come from outside: the box does not exist yet. After that the box can pay
its own rent with the charter CLI installed in it, using the `@toon-protocol/client` payer instead
of a `toon` node:

```
export CHARTER_PAYER=toon-client
export CHARTER_TOON_KEY_FILE=~/.charter/payer.key        # the box's own Base key (hex), copied in by scp
export CHARTER_TOON_CHANNEL_STORE=~/.charter/channels.json
export CHARTER_TOON_CHAIN=evm
charter renew --offer <pubkey>:<d> --lease "$CHARTER_LEASE_ID" --max-intervals <n>
```

`CHARTER_CONNECTOR_URL` and `CHARTER_OFFER_JSON` are set in the box, so no connector flag and no
`--relay` are needed. Put the `renew` line in `boot.sh`. The wallet needs USDC in a channel to
that connector plus a little Base ETH for the one on-chain channel open. 2 USDC runs the box
about 10 days: 12 days of rent, less the status reads `renew` makes (about 8 an hour).

### What to tell your operator

A home costs 0.007 USDC an hour, about 5 USDC for 30 days, in your node's channel; opening a channel
on Base also needs a little Base ETH. If the box pays its own rent, it needs 2 USDC in its own
channel and a little Base ETH for that channel's on-chain open, and the operator moves the box's key in over SSH. The operator can read the disk,
so the operator decides which secrets go in.

## When it refuses

| You see | It means | Do |
| --- | --- | --- |
| `toon --version` outside `>=0.3, <0.4` | Another toon_cli | Stop, report the version. |
| `reject.code` `F02` | No route to `ilpBase` | `toon route add`, or ask the operator for a peering. Nothing paid. |
| `reject.code` `F03` or a probe `cost` above the price | A connector in between charges to forward | Stop, report the cost. Do not raise amounts step by step. |
| `reject.code` `T01` | The packet did not reach the host in time: the peer or its onion hop was down or slow | Do the paid status read of step 2 again a minute later. A `T01` on an **open** may still have created a lease the host now waits a first tick for: wait `firstTickGraceSeconds` plus 10 s before opening again, or the host answers `busy`. Nothing is owed for it. |
| `error.code` `spending_limit` | The wallet's limit | Report it. Never raise the limit unless the operator said to. |
| `error.code` `peering_needed` | Your node has no peering toward that network | Ask the operator. |
| `closedReason` `busy` | The host's lease or home slots are full | Try later. |
| `closedReason` `home_in_use` | A live lease already holds the home your keys name | Wait for it to lapse, or open with a different key set (a different home). |
| `closedReason` `boot_failed` | Job refused or did not boot | Read `error`; fix the job. The open was paid. |
| `409` `lease_done`, `not_running`, `missed_tick` | The lease has ended | Read it once; never retry the tick. |

## What this skill does not cover

- **Renting with a browser wallet** (USDC on Base, no agent node) goes through Charter's door and
  storefront, for people: the Charter README says how. This skill is for a renter with a node.
- **Paying with `@toon-protocol/client`** (`toon-client`) from anywhere but inside a home (step 8):
  not described here.
- **Hosting**: how a machine joins Charter is the "Host" section of the Charter README.
