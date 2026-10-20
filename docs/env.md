# Environment

Every variable Charter reads, by program. Amounts are USDC micro-units (`1000` is 0.001 USDC).
Secrets never go in these variables: a variable names the file that holds one.

## charter-host

`charter-host run | land | offer --print`, next to the host's `toon` node.

| variable | required | default | what it is |
| --- | --- | --- | --- |
| `CHARTER_DATA_DIR` | yes | | Lease store (`leases.json`) and job output (`out/<lease>/`). Created mode 700. |
| `CHARTER_ALLOW_IMAGES` | yes | | Comma list of the job images this host runs: `charter-job-fetch` (fetch pages through the proxy) and `charter-job-python` (the renter's Python script, no network). Also the offer's `images`. |
| `CHARTER_RELAY_URL` | yes | | `wss://` relay the offer is published to (a paid write). |
| `TOON_PASSPHRASE_FILE` | yes | | File holding the node wallet passphrase. Passed to `toon` in its env only. |
| `CHARTER_OFFER_ID` | yes | | The offer's `d` tag. |
| `CHARTER_ILP_BASE` | yes | | The node's ILP address (`toon status --json` `.agent_node.toon_apps[0].connector.ilp_address`). The apps are `<base>.charter-open`, `.charter-tick`, `.charter-status`. |
| `CHARTER_SEAL_KEY` | yes | | The node connector's public key, `0x04` and 128 hex digits (`toon describe --json` `.description.edgeIdentity.publicKey`). A payer seals to it with no fetch. |
| `CHARTER_SEAL_URL` | yes | | The node connector's `/ilp` URL, usually onion (`toon describe --json` `.description.httpEndpoint`). The `toon` CLI seals to it. |
| `CHARTER_PORTS` | no | `7401,7402,7403` | Loopback ports of the open, tick and status apps, in that order. |
| `CHARTER_PROXY` | no | none | SOCKS proxy for job egress (for example `socks5://172.17.0.1:9150`). Set means the offer says `hiddenEgress`. A loopback host is rewritten to `host.docker.internal` for the container. |
| `CHARTER_RUNTIME` | no | docker's own | OCI runtime for every job container. `runsc` runs jobs under gVisor: recommended on any host that runs `charter-job-python` for anyone but its owner, since that job runs the renter's own code. |
| `CHARTER_HIDDEN_HOST` | no | false | `1`, `true` or `yes`: the offer carries the hidden-host badge. |
| `CHARTER_MAX_LEASES` | no | `1` | Live leases at once (booting, awaiting the first tick, running). An open past it answers `closed`, `busy`, before any container is made. |
| `CHARTER_INTERVAL_SECONDS` | no | `30` | Length of one paid interval. |
| `CHARTER_TICK_PRICE` | no | `5000` | Price of one interval (the `charter-tick` app's price). |
| `CHARTER_OPEN_PRICE` | no | `1000` | Price of an open (the `charter-open` app's price). |
| `CHARTER_STATUS_PRICE` | no | `100` | Price of a status or output read (the `charter-status` app's price). |
| `CHARTER_CPU` | no | `1` | Advertised CPUs. The v1 container limit is fixed at 1 CPU. |
| `CHARTER_MEMORY_MIB` | no | `1024` | Advertised memory. The v1 container limit is fixed at 1 GiB. |

Fixed, not configurable: the first tick is due within 90 s of the container's creation (published
as `firstTickGraceSeconds`), later ticks within 10 s of the paid time, a lease may stay booting 120 s,
the offer lives 30 min and is republished every 10 min. A job container gets 1 CPU, 1 GiB, 256 pids,
a read-only root, no capabilities and `no-new-privileges`.

## charter-door

`charter-door` serves the storefront and pays hosts for browser renters. `charter-door unblock <0x address>`
reads only `CHARTER_DATA_DIR`.
`charter-door x402 status | claim | refund` lists renters' batch-settlement channels, or claims and settles their vouchers to `CHARTER_PAY_TO` and refunds idle channels now (the door does both on timers: claims hourly, refunds every 10 min after 10 min idle). Safe beside a running door.

`charter-door channel status | rotate | settle` reads only the `CHARTER_TOON_*` variables; run it with the
door stopped (docs/demo.md, channel rotation).

| variable | required | default | what it is |
| --- | --- | --- | --- |
| `CHARTER_DOOR_PORT` | yes | | Port to listen on. |
| `CHARTER_DOOR_HOST` | no | `127.0.0.1` | Address to bind. Not to be confused with `CHARTER_DOOR_HOSTS`. |
| `CHARTER_DOOR_HOSTS` | yes | | The hosts this door pays: `<host pubkey>=<ilpBase>`, comma separated (64 lowercase hex, then the host's ILP address). An offer is listed and opened only when its signer and its `ilpBase` both match an entry, and its prices are at most open 10000, status 1000, tick 50000. |
| `CHARTER_DOOR_TRUST_PROXY` | no | none | `true`, or a hop count (`1` for one Caddy in front), so rate limits see the client's address. |
| `CHARTER_DATA_DIR` | yes | | `door-ledger.json` and its sidecars (`.payments`, `.unblocks`, `.unpaid`), and cached output parts. |
| `CHARTER_RELAY_URL` | yes | | `wss://` relay to read offers from. |
| `CHARTER_PAY_TO` | yes | | The door's Base address that renters' x402 payments go to. |
| `CHARTER_CLAIM_KEY_FILE` | yes | | File holding the door's x402 claim key: one `0x` + 64 hex secp256k1 private key (`deploy/door/new-claim-key.mjs`). It authorizes claims and refunds on renters' batch-settlement channels for `CHARTER_PAY_TO` and holds no funds. Channel records live in `<CHARTER_DATA_DIR>/x402-channels/`. |
| `X402_FACILITATOR_URL` | no | `https://facilitator.payai.network` | x402 facilitator for verify and settle. |
| `CHARTER_TOON_CONNECTOR_URL` | yes | | The connector the door's TOON client pays through. |
| `CHARTER_TOON_KEY_FILE` | yes | | File holding the door's TOON payer key: a hex private key (`evm`) or a JSON array of secret key bytes (`solana`). |
| `CHARTER_TOON_CHANNEL_STORE` | yes | | The client's x402 channel store file. Losing it strands a live channel's deposit. |
| `CHARTER_TOON_CHAIN` | yes | | `evm` or `solana`: the chain the door's channel is on. |
| `CHARTER_TOON_RPC_URL_FILE` | no | the client's default | File holding the chain RPC URL (one `https://` line). A file because the URL may carry an API key. On the Hetzner box use the Helius URL: the public Solana RPC rate-limits it. |

Fixed, not configurable: 10 opens an hour per IP and 30 across all IPs; 120 GETs a minute per IP on
`/v1/leases/*`; 30 tick POSTs a minute per IP; at most 500000 micro-USDC a UTC day of door spend no
renter paid for (opens, free reads, the status read before each tick, losses), past which opens,
ticks and uncached reads answer 503 `capacity`; a tick is refused 503 `retry_later` while the
channel's headroom is under the tick price plus 10000, and an open is refused 503 `capacity` while it
is under the open price plus the tick price plus 10000.

## charter (tenant CLI)

`charter offers | rent | status` take the relay, the offer and the rest as flags.

| variable | required | default | what it is |
| --- | --- | --- | --- |
| `TOON_PASSPHRASE_FILE` | for `rent` and `status` | | File holding the tenant node's wallet passphrase. Passed to `toon` in its env only. |

## Development only

`npm run dev:door` (a door with no payments and a fake host): `DEV_DOOR_PORT` (default 8787) and `DEV_INTERVAL_SECONDS` (default 30, at least 12).
