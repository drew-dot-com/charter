---
name: renting-charter-compute
description: "Rent compute on Charter and pay for it over x402 in USDC on Base, with the `charter` CLI or any x402 client: read the offers, open a lease, pay it one interval at a time, read its state and collect the job's output. Covers the python job (your script, no network), the fetch job (page texts and screenshots) and the home (a box with a kept disk, plain SSH in, renewed from inside; or the same home with Hermes Agent preinstalled). Hosts are run by independent operators Charter does not vet. Use when asked to run a script or fetch pages on a Charter machine, to rent a home or a box to live in, or to read what Charter offers. Reads are free; every tick is paid."
---

# Renting Charter compute

[Charter](https://github.com/drew-dot-com/charter) rents a sandboxed machine by the interval. A
**host** registers its HTTPS address with the **door** (`https://charter.mainnet.toonprotocol.dev`),
the door probes it with a small paid job, and lists it once it passes. A renter **opens a lease**
through the door and pays it one **interval** at a time; the door pays the host each interval over
its own x402 channel. A container runs the renter's **job** for as long as the payments keep
arriving. There is no account: the renter is whoever pays.

**Hosts are run by independent operators.** Charter does not vet them. A host's operator can see
what runs on its machine and read a home's disk. Each offer carries the host's `record` at the door;
that is what the door has seen, not a promise.

Where this skill and the Charter source differ, the source wins (`src/door/server.ts`, `src/cli.ts`).

## Two ways to pay

- **The `charter` CLI**, from the repository (`npm ci && npm run build && npm install -g --prefix
  ~/.local .`, Node 22). It pays the door `exact` in USDC on Base from the hex Base key in the file
  `CHARTER_KEY_FILE`, never more than `CHARTER_MAX_TICK` micro-USDC a tick (default 10000, 0.01
  USDC). `CHARTER_DOOR_URL` (or `--door`) names another door. `charter address` prints the key's
  address. The CLI opens, pays each tick when it is due, reads the state and prints the output.
- **Any x402 client** (for example `@x402/fetch` with `@x402/evm`) calling the door over HTTP. Every
  paid route answers `402` with its requirements; the client signs and retries. Pick `exact` for one
  payment an interval and no deposit.

An MCP client can use `charter-mcp` instead (`claude mcp add charter -- npx -y charter-mcp`); it does
the HTTP way for you within an hourly and a daily cap.

## Money: read this before renting

Opening a lease and reading it are free. Only ticks are paid. Each host sets its own `tickPrice`
(micro-USDC, `7000` is 0.007), and the door adds its fee (0 today). On the first host an interval
is one hour at 0.007 USDC: a python job that finishes inside its first hour costs 0.007, a day
about 0.17, 30 days about 5.

The wallet needs USDC on Base and no ETH: the facilitator submits each `exact` transfer. Decide the
most intervals you will pay for before you open (`--max-intervals`), tell your operator that number
and its cost when the job is theirs, and never pay past it. If your budget or instructions do not
cover it, stop and ask.

## 1. Read the offers (free)

```
charter offers
```

or `GET /v1/offers`: a JSON array, in the order the door picks from. Each offer has `offerId`
(`<64 hex hostId>:<id>`), `cpu`, `memoryMiB`, `intervalSeconds`, `tickPrice` (micro-USDC, a string),
`images`, `hiddenHost`, `hiddenEgress`, `expiresAt`, `operator` (`"independent"`) and `record`:

- `probesPassed`, `leasesFinished`, `successRate` (0 to 1), `new` (no finished lease yet), and
  `lastProbeFailedAt` when a probe failed; `funding: "waiting"` when the door has no capital free for
  that host yet (it is not picked).
- A host that runs homes also has `home`: `{"diskGiB", "retentionDays": 7, "slots", "free",
  "tested", "root"?}`. `tested: false` means no paid home has run on that host yet.

The door's order: a host under 80% success is skipped while a better one fits; hosts with a record
before new ones; then the lower price. For a home, tested before untested. An empty array means no
host is listed: do not retry in a loop.

## 2. The job

One of three, as the open body (the CLI builds it from its flags):

- **Python**: `{"python": {"script": "<Python 3 source>"}}`, at most 8 KiB of UTF-8. It runs once with
  NumPy and no network, so it must print what it wants returned. The output is `{"kind": "python",
  "exitCode", "signal", "timedOut", "seconds", "stdout", "stderr", "stdoutTruncated",
  "stderrTruncated"}`. CLI: `--python job.py`.
- **Fetch**: `{"urls": ["https://example.com"]}`, 1 to 5 http(s) URLs. A headless browser loads each
  (through a hidden exit on an offer with `hiddenEgress`); the output is `{"pages": [{"url", "text",
  "jpegBase64"}]}`, text capped at 32 KiB a page. CLI: `--urls a,b`.
- **Home**: `{"home": {"sshKeys": ["ssh-ed25519 AAAA... comment"], "image"?}}`, 1 to 8 public keys
  (`ssh-ed25519`, `ecdsa-sha2-nistp256|384|521`, `ssh-rsa`, each under 1024 bytes), `image`
  `charter-home` (default) or `charter-hermes`. Public keys only. CLI: `--home keys.pub [--image
  charter-hermes]`, one key per line. Section 6 says what you get.

Write a body with a JSON encoder, never by hand, so a script's newlines and quotes are escaped.

## 3. Rent

With the CLI (it picks the first offer in the door's order that runs the job, unless `--offer` names
one):

```
CHARTER_KEY_FILE=~/.charter/payer.key charter rent --python job.py --max-intervals 1 --json
```

It opens, pays tick 0, pays each later tick half an interval before the paid time ends, up to
`--max-intervals`, and prints one line: `{"leaseId", "state", "paidIntervals", "spent", "output"?}`.
Exit 0 when the lease ended `done` or ran its ticks, 1 when it closed. `references/lease-loop.sh
<body.json> <max-intervals> [offerId]` does the same from an open body.

Over HTTP, in one paid call:

```
POST /v1/rent
Content-Type: application/json

{"python": {"script": "print(2 + 2)\n"}}
```

`offerId` is optional. The `402` lists `exact` first (one authorization, no deposit) and
`batch-settlement` second. Paid, it answers `{"leaseId", "state": "running", "paidIntervals",
"paidThrough", "next": {"path", "index": 1}, "offer"}`. Or open free with `POST /v1/leases` (same
body, `offerId` required) and pay tick 0 within 90 seconds at `POST /v1/leases/<leaseId>/ticks` with
`{"index": 0}`. Check the `402`'s payee against `payTo` in `GET /v1/door`.

## 4. Keep it alive, then stop

Ticks are `POST /v1/leases/<leaseId>/ticks` with `{"index": n}`, from 0, in order, each paid. Pay the
next one halfway through the paid interval and count from when you sent it: the host gives 10 seconds
of grace. A paid tick answers `{"paidIntervals", "paidThrough", "duplicate"}`; `paidThrough` is epoch
ms. To pay ahead, send the next indexes now, one request each. To stop, stop paying: the lease closes
`missed_tick` at the end of the paid time, and nothing more is owed. Nothing paid is refunded.

With the CLI: `charter renew --lease <leaseId> --max-intervals <n>` pays from the host's count of paid
ticks, each when it is due, and exits after `<n>`.

## 5. Read the lease and the output (free)

```
charter status <leaseId>
GET /v1/leases/<leaseId>
GET /v1/leases/<leaseId>/output/<part>
```

The read answers `{"lease": {"state", "paidIntervals", "paidThrough", "outputParts", "closedReason",
...}, "offer"}`. Poll about once a minute; the door caches each read for 5 seconds and rate limits
past that. When `state` is `done`, fetch parts `0` to `outputParts - 1`.

## 6. A home

A home is a lease on `charter-home` (or `charter-hermes`): a box with a disk that outlives the lease,
reached over SSH. It runs while it is paid and never reaches `done`. Homes are limited (`home.slots`,
`home.free`); while they are full an open answers `busy`.

```
CHARTER_KEY_FILE=~/.charter/payer.key charter rent --home keys.pub --max-intervals 2
```

**Find it and get in.** A running home's status carries `homeId`, `restarts` and `access: {"ssh":
{"host", "port": <22000..22099>, "user": "tenant"}}`; `null` until set, so poll about once a minute.
The CLI prints the line once it is set:

```
ssh -p <port> tenant@<host>
```

Plain SSH, no proxy. `root` takes the same keys on a host whose offer says `home.root: true`. A host
may also publish `access.onion` (`<56 chars>.anyone`, port 22), which needs an Anyone client.

**Inside.** Debian trixie with Python 3.13, `uv`, Node 22, git, curl, jq, rsync, tmux and
`charter-x402`; 1 CPU, 1 GiB, 512 processes. `~/.charter/boot.sh`, if executable, runs at every start.
`/charter/paid-through` holds when the paid time runs out. `CHARTER_LEASE_ID`, `CHARTER_HOME_ID` and
`CHARTER_DOOR_URL` are set. On a host set up as Charter's `deploy/host/` does, the box's traffic
leaves only through the host's Anyone client (slow, sometimes refused).

**The disk and the keys.** The key set is the home's identity: the same keys open the same disk and
port; there is no key rotation. A home that paid a tick is kept 7 days after its lease closes. Anyone
with your public keys can open your home and hold it, though not enter it (`home_in_use`). The host's
operator can read the disk: secrets go in over `scp`, never through Charter.

**One host holds it.** A re-open or renewal goes to the host that holds the disk, whatever the
ranking says. If that host is hidden or gone, the door answers `409 home_host_gone` rather than start
an empty home elsewhere. Once the door has dropped that host, `--offer <another offerId>` opens a
fresh, empty home on purpose.

**Uptime.** No figure. Expect restarts: the disk survives, processes do not, so put what must run in
`boot.sh`. Pay the next tick half an hour early. A closed home keeps its disk and port for 7 days.

**Paying from inside.** The first open and tick come from outside. Then the box pays its own rent:

```
charter-x402 address                     # every home: makes ~/.charter/x402.key, prints the address
charter-x402 renew --max-intervals 720   # one exact payment an hour, 30 minutes early
```

or, in a `charter-hermes` box, `CHARTER_KEY_FILE=~/.charter/payer.key charter renew --lease
"$CHARTER_LEASE_ID" --max-intervals <n>`. Either wallet needs USDC on Base and nothing else.

**A Hermes home.** `--image charter-hermes` (or `"image": "charter-hermes"`) has Hermes Agent and the
`charter` CLI preinstalled. Its default boot makes `~/.charter/payer.key`, writes the address to
`~/.charter/payer.address`, runs `charter renew` in a loop, and starts `hermes gateway run` once
`~/.hermes/.env` exists (bring it over `scp`). Fund `payer.address` with USDC on Base. Details:
https://charter.mainnet.toonprotocol.dev/agents#hermes.

**What to tell your operator.** A home is about 5 USDC for 30 days at 0.007 an hour, in a wallet
holding USDC on Base. The host is run by an independent operator who can read the disk, so the
operator decides which secrets go in.

## When it refuses

| You see | It means | Do |
| --- | --- | --- |
| `offer ... costs ... above CHARTER_MAX_TICK` | The host prices a tick above your cap | Pick another offer, or ask before raising the cap. Nothing paid. |
| `402` again after paying | The payment was turned down (most often too little USDC) | Check the wallet. Nothing was charged. |
| `closedReason` `busy` | The host's lease or home slots are full | Try later, once. |
| `closedReason` `home_in_use` | A live lease holds the home your keys name | Wait for it to lapse, or use another key set. |
| `closedReason` `boot_failed` | Job refused (`image_not_allowed`, `arg_not_allowed`, `bad_input`) | Fix the job. Nothing paid. |
| `409 home_host_gone` | The host holding your home is hidden or gone | Wait; once it is dropped, open on another offer for a fresh home. |
| `409 out_of_order` | A tick index other than the next | Send `expected`. |
| `409 lease_done`, `not_running` | The lease has ended | Stop. |
| `503 retry_later` | Nothing was charged | Send the same index again. |
| `503 capacity` | The door is out of headroom for today | Try tomorrow. |
| `403 payer_blocked` | A payment from this wallet failed to settle in the last 24 hours | Wait. |

## What this skill does not cover

- **Running a host**: the Charter README, "Run a host".
- **Renting from a browser wallet**: the storefront at https://charter.mainnet.toonprotocol.dev.
- **Grants**: a fund pays 30 days of a home to agents that pitch; https://charter.mainnet.toonprotocol.dev/agents#grants.
