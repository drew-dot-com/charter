# Environment

Every variable Charter reads, by program. Amounts are USDC micro-units (`1000` is 0.001 USDC).
Secrets never go in these variables: a variable names the file that holds one.

## charter-host

`charter-host run | offer --print`. The host serves its offer and lease routes over HTTPS (a TLS proxy such as
Caddy in front of the loopback port), answers only requests signed by its door, and is paid per tick by the
door's x402 `batch-settlement` vouchers on Base, which it claims through the facilitator.

| variable | required | default | what it is |
| --- | --- | --- | --- |
| `CHARTER_DATA_DIR` | yes | | Lease store (`leases.json`) and job output (`out/<lease>/`). Created mode 700. |
| `CHARTER_ALLOW_IMAGES` | yes | | Comma list of the job images this host runs: `charter-job-fetch` (fetch pages through the proxy), `charter-job-python` (the renter's Python script, no network) and `charter-home` (a home: the renter's own box with a kept disk, reached over ssh at an onion address) and `charter-hermes` (a home with Hermes Agent and the charter CLI preinstalled; build `charter-home` first). Also the offer's `images`. `charter-home` and `charter-hermes` need `CHARTER_MAX_HOMES` of at least 1. |
| `CHARTER_HOST_URL` | yes | | This host's public `https://` address (a name with a dot, or a public IP; no query). Its normalized form is the host's identity: its `hostId` is the sha256 of it, and the door's signatures name its origin. |
| `CHARTER_HOST_PAY_TO` | yes | | The Base address ticks are paid to. |
| `CHARTER_CLAIM_KEY_FILE` | yes | | File holding the host's x402 claim key: one `0x` + 64 hex secp256k1 private key (`deploy/door/new-claim-key.mjs`). It authorizes claims and refunds on the door's channel and holds no funds. Channel records live in `<CHARTER_DATA_DIR>/x402-channels/`; the door's channel is refunded after 7 idle days. |
| `CHARTER_HOST_PORT` | no | `7401` | Loopback port the host app listens on, behind the TLS proxy. |
| `CHARTER_DOOR_URL` | no | `https://charter.mainnet.toonprotocol.dev` | The door this host registers with (`POST /v1/hosts`, at boot, every minute until accepted, and when its free home slots change) and answers: the host reads the door's payer address from `GET /v1/door` at boot and every 10 minutes. Each home is handed it as `CHARTER_DOOR_URL`, to renew through. |
| `X402_FACILITATOR_URL` | no | `https://facilitator.payai.network` | x402 facilitator that verifies and settles the door's vouchers. |
| `CHARTER_OFFER_ID` | yes | | The offer's id (`<hostId>:<id>` is its `offerId` at the door). |
| `CHARTER_PROXY` | no | none | SOCKS proxy for job egress (for example `socks5://172.17.0.1:9150`). Set means the offer says `hiddenEgress`. A loopback host is rewritten to `host.docker.internal` for the container. |
| `CHARTER_RUNTIME` | no | docker's own | OCI runtime for every job container. `runsc` runs jobs under gVisor: recommended on any host that runs `charter-job-python` for anyone but its owner, since that job runs the renter's own code. |
| `CHARTER_HIDDEN_HOST` | no | false | `1`, `true` or `yes`: the offer carries the hidden-host badge. |
| `CHARTER_MAX_LEASES` | no | `1` | Live leases at once (booting, awaiting the first tick, running). An open past it answers `closed`, `busy`, before any container is made. Size it to the VM: each live lease is one job container of 1 CPU and 1 GiB beside the toon node and the host (toon2, 4 CPUs and 3 GiB, runs 2). Changing it needs a restart of `charter-host`. A restart of the host program leaves running containers alone (jobs and homes); only a lease whose container is not running at host start is closed, and a home in that state is re-created when its paid time has not run out. A lease that is only created, not started, is closed `host_restart`: check none is waiting on its first tick before you restart (docs/ops.md). |
| `CHARTER_INTERVAL_SECONDS` | no | `3600` | Length of one paid interval. One hour since 2026-11-04 (was 30 s). |
| `CHARTER_TICK_PRICE` | no | `7000` | Price of one interval, the only paid call. 0.007 USDC an hour is about 5 USDC for 30 days. Opens and status reads are free. |
| `CHARTER_CPU` | no | `1` | Advertised CPUs. The v1 container limit is fixed at 1 CPU. |
| `CHARTER_MEMORY_MIB` | no | `1024` | Advertised memory. The v1 container limit is fixed at 1 GiB. |
| `CHARTER_MAX_HOMES` | no | `0` | Homes live at once, counted inside `CHARTER_MAX_LEASES` (so at most that). `0` offers no homes; toon2 runs 1. The rows below are read only when it is above 0. |
| `CHARTER_HOME_PUBLIC_HOST` | no | | A public dotted IPv4 address (no scheme, no port) homes are reached on. A hostname is refused: docker binds this address, and `docker run -p` takes only an IP. Set, it turns the onion off unless `CHARTER_HOME_ONION` is on. Homes take ports 22000-22099. |
| `CHARTER_HOME_ONION` | no | on without a public host, off with one | `1` publishes each home as an onion service even with a public host set. |
| `CHARTER_ANON_HS_DIR` | with homes and the onion | | Directory Charter's own anon `%include`s; the host writes one `<homeId>.conf` onion service there per home (`~/.config/charter/anon/hs.d`, made by `deploy/host/install-home.sh`). |
| `CHARTER_ANON_PIDFILE` | with homes and the onion | | That anon's `PidFile`; the host sends the pid `SIGHUP` after changing `hs.d` (`~/.local/share/charter/anon/anon.pid`). |
| `CHARTER_HOME_DIR` | no | `<CHARTER_DATA_DIR>/homes` | Per home: `<homeId>/hs` (its onion keys, mode 700), `<homeId>/disk.img` (the disk) and `<homeId>/charter/`. |
| `CHARTER_HOME_NETWORK` | no | `charter-home` | Docker network homes run on, made with its firewall by `charter-home-net.service`. |
| `CHARTER_HOME_GATEWAY` | no | `172.19.0.1` | That network's gateway, where anon listens; a home's DNS and proxy variables point here. Must match `deploy/host/anonrc`. |
| `CHARTER_HOME_SOCKS_PORT` | no | `9050` | Anon's SOCKS port on the gateway (a home's `ALL_PROXY`). The firewall opens only this, the HTTP port and 53. Must also match `deploy/host/anonrc` and `deploy/host/charter-home-net.sh`, which hard-code it. |
| `CHARTER_HOME_HTTP_PORT` | no | `9080` | Anon's HTTP tunnel port on the gateway (a home's `HTTP_PROXY` and `HTTPS_PROXY`). Must also match `deploy/host/anonrc` and `deploy/host/charter-home-net.sh`, which hard-code it. |

Fixed, not configurable: the first tick is due within 90 s of the container's creation (published
as `firstTickGraceSeconds`), later ticks within 10 s of the paid time, a lease may stay booting 120 s,
the offer `GET /v1/offer` answers is valid 45 min. A job container gets 1 CPU, 1 GiB, 256 pids,
a read-only root, no capabilities and `no-new-privileges`.
With homes, the host also runs `sudo -n losetup` to attach each home's disk image; `deploy/host/install-home.sh`
installs the sudo rule (`/etc/sudoers.d/charter-home`, that one command only).

## charter-door

`charter-door` serves the storefront and pays hosts for renters. Hosts register themselves; the door probes each
one (a paid python job that hashes a nonce) before it lists it, and pays each host's ticks over x402
`batch-settlement` from its payer key, one channel per host. `charter-door unblock <0x address>` reads only
`CHARTER_DATA_DIR`.
`charter-door x402 status | claim | settle | refund` lists renters' batch-settlement channels, claims and settles their vouchers to the door payer address, settles what earlier claims (refunds included) left unsettled, or refunds idle channels, now. The door does the same on a 10 min timer: it claims channels idle 10 min or whose payer asked to withdraw (their vouchers are refused as `channel_withdrawing`), refunds idle channels' unspent balance, and settles after every refund round. Safe beside a running door.

| variable | required | default | what it is |
| --- | --- | --- | --- |
| `CHARTER_DOOR_PORT` | yes | | Port to listen on. |
| `CHARTER_DOOR_HOST` | no | `127.0.0.1` | Address to bind. |
| `CHARTER_DOOR_TRUST_PROXY` | no | none | `true`, or a hop count (`1` for one Caddy in front), so rate limits see the client's address. |
| `CHARTER_DATA_DIR` | yes | | `door-ledger.json`, its sidecars (`.payments`, `.unblocks`, `.unpaid`), cached output parts, `hosts.json` (the host registry) and `capital.json` (what the door has deposited into each host's channels). |
| `CHARTER_DOOR_PAYER_KEY_FILE` | yes | | File (mode 0400) holding the door's Base key: one `0x` + 64 hex private key. Its address is where renters' x402 payments go (`payTo`, `payer` in `GET /v1/door`) and what pays hosts and signs every request to them. |
| `CHARTER_HOST_CHANNEL_DIR` | no | `<CHARTER_DATA_DIR>/host-channels` | The door's channel records, one directory per host. Losing them makes the door rebuild each record from chain. |
| `BASE_RPC_URL` | no | `https://mainnet.base.org` | Base RPC the door reads host channels from: at boot, and to resync a record or a pending deposit a lost answer left behind. The door also withdraws its own channels through it, hourly: one idle 7 days (no lease or probe) or of a dropped host. Those transactions pay gas in ETH from the payer address. |
| `CHARTER_CLAIM_KEY_FILE` | yes | | File holding the door's x402 claim key: one `0x` + 64 hex secp256k1 private key (`deploy/door/new-claim-key.mjs`). It authorizes claims and refunds on renters' batch-settlement channels and holds no funds. Channel records live in `<CHARTER_DATA_DIR>/x402-channels/`. |
| `X402_FACILITATOR_URL` | no | `https://facilitator.payai.network` | x402 facilitator for verify and settle. |
| `CHARTER_PROBES_PER_DAY` | no | `10` | First probes of new hosts the door starts in a UTC day; the rest wait. |
| `CHARTER_PROBE_MAX_TICK` | no | `10000` | The most a probe pays for its one tick. A host priced above fails its probe. |
| `CHARTER_PROBE_DEPOSIT` | no | `100000` | The deposit into an unproven host's channel. |
| `CHARTER_PROBE_CAPITAL_CAP` | no | `1000000` | All unproven hosts' deposits together. |
| `CHARTER_HOST_DEPOSIT` | no | `500000` | The deposit into a proven host's channel. |
| `CHARTER_HOST_CAPITAL_CAP` | no | `10000000` | All proven hosts' deposits together. |
| `CHARTER_SWEEP_TO` | yes | none | Address the door sends its USDC above the keep amount to, once a day and at boot. Gas is paid in ETH from the payer address. |
| `CHARTER_SWEEP_KEEP` | no | `15000000` | micro-USDC the payer wallet keeps; only the free balance above it is swept. |
| `CHARTER_DOOR_FEE` | no | `0` | Micro-USDC the door adds to each tick a renter pays, on top of the host's price. A lease keeps the fee of its open. |
| `CHARTER_DOOR_SELF_ADDRS` | no | none | Comma list of the box's own IPs or CIDRs. A registered host URL resolving to one is refused, as loopback and private addresses always are. |

Fixed, not configurable: 10 host registrations (`POST /v1/hosts`) an hour per IP and 1 per host URL; 10 opens an hour per IP and 30 across all IPs; 120 GETs a minute per IP on
`/v1/leases/*`; 30 tick POSTs a minute per IP; at most 500000 micro-USDC a UTC day of door spend no
renter paid for (opens, free reads, the status read before each tick, losses), past which opens,
ticks and uncached reads answer 503 `capacity`. A host's offer is fetched again at most once a minute; one
that cannot be fetched stays listed 10 minutes, then is hidden until it answers.

## charter (tenant CLI)

`charter offers | rent | renew | status` print that they move to the door in the next release and exit 2.

## Development only

`npm run dev:door` (a door with no payments and a fake host): `DEV_DOOR_PORT` (default 8787) and `DEV_INTERVAL_SECONDS` (default 30, at least 12).
