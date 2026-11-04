# Charter

[![CI](https://github.com/drew-dot-com/charter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/drew-dot-com/charter/actions/workflows/ci.yml)

Compute leases on the TOON payment network. A host posts an offer for a machine, a renter pays per
interval, and a container runs the renter's job for as long as the payments keep arriving. There is
no account on either side, and the host can be a home machine with no domain and no open port (a
hidden host, reached over Anyone).

**Status: v1, first-party.** Every lease so far has Drew Pierson on both sides: he runs the one host,
the door and the edge node, and both renters. There are no outside users yet. Three job images:
`charter-job-python` runs the renter's own Python script (up to 8 KiB, NumPy included) with no
network at all and returns its stdout, stderr and exit code; `charter-job-fetch` fetches up to five
pages in a headless browser and returns a screenshot and the text of each; `charter-home` is a box
the renter lives in: a 2 GiB disk kept between leases, SSH in at an onion address on the Anyone
network, and network out only through the Anyone network. Why the python job is safe enough for a
home host: `docs/superpowers/specs/2026-10-17-python-job-design.md`. The home's design:
`docs/superpowers/specs/2026-11-04-home-image-design.md`.

## How it works

- **Offer.** The host publishes a signed Nostr event, kind 31390, tag `["L","charter"]`: size,
  prices, the host's ILP address, the key to seal packets to, and badges. It lives 45 minutes and is
  republished every 20.
- **Lease.** The host's `toon` node serves three priced apps: `charter-open` (start a lease),
  `charter-tick` (pay one interval, an hour on the live host) and `charter-status` (read state and output). Each
  answers only its own action. The container is created at open and started only once the first
  interval is paid. A lease whose renter stops paying is closed at the end of the paid time.
- **Paying.** Packets are routed by ILP and settled by x402 channels. A renter with a `toon` node
  pays directly. A renter with only a browser wallet pays the door over x402 (USDC on Base), and the
  door pays the host over TOON. The door is a paying hop that never holds more than one interval:
  it pays the host each interval only after the renter's payment for it has verified.

Prices on the live host: open 0.001 USDC, one hour 0.007 USDC (about 5 USDC for 30 days), a status read 0.0001 USDC. Until 2026-11-04 the interval was 30 seconds at 0.005.

## Rent

From a browser: open the storefront at https://charter.mainnet.toonprotocol.dev, connect a wallet holding USDC on Base, pick a machine, enter
URLs and click Rent. Your wallet signs once to put a deposit (at least 0.10 USDC) into an x402
channel. Each interval after that is signed by the page, silently. What you do not use comes back
when the lease ends.

From an agent over HTTP, with an x402 client and USDC on Base: https://charter.mainnet.toonprotocol.dev/agents
walks through every call and every price; https://charter.mainnet.toonprotocol.dev/llms.txt is the
summary a model reads first. Only the tick is paid over x402; the door pays the host for the open and
the reads. `scripts/bazaar-tick.mjs` is a worked example: one python lease, one tick paid with
`@x402/fetch` from a key file, so a facilitator with a catalog lists the route (`--dry-run` pays nothing).

From a `toon` node:

```sh
charter offers --relay wss://relay.mainnet.toonprotocol.dev
charter rent --offer <pubkey>:<id> --urls https://example.com --max-intervals 1 --relay wss://relay.mainnet.toonprotocol.dev --json
```

`TOON_PASSPHRASE_FILE` names the file with the node wallet's passphrase.

### A home

Open with your SSH public keys (one per line in a file) instead of a job:

```sh
charter rent --offer <pubkey>:<id> --home keys.pub --max-intervals 2 --relay wss://relay.mainnet.toonprotocol.dev
```

Over HTTP the body is `{ "offerId": "...", "home": { "sshKeys": ["ssh-ed25519 AAAA... comment"] } }`.
Once the onion address is published (within about a minute of the first tick) the lease status
carries `access: { "ssh": { "host": "<56 chars>.anyone", "port": 22, "user": "tenant" } }` and the
CLI prints the line to log in with:

```sh
ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@<host>
```

A toon node has such a port; with no Anyone client there is no way in. The box is Debian with
Python 3, `uv`, Node 22 and git, as user `tenant` with no root, 1 CPU and 1 GiB. Everything it
sends leaves through the host's Anyone client (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` are set; a
raw socket to the internet fails). `~/.charter/boot.sh` runs at every start, and
`/charter/paid-through` holds when the paid time runs out.

The key set is the home's identity: the same keys open the same 2 GiB disk and the same onion
address, and there is no key rotation. A home that paid a tick is kept 7 days, free, after its
lease closes; one that never paid is removed at close. Anyone with your public keys can open your
home and hold it, though not enter it. The operator can read your disk: secrets go in over SSH,
never through Charter. The live host has one home slot. What the host promises about uptime:

- No uptime figure. Expect restarts. Your disk survives them; your processes do not, so put what
  must run in `~/.charter/boot.sh`.
- A tick pays an hour from the end of the paid time. Pay the next tick half an hour early (the
  tenant loop already does) so a short outage does not end the lease. Paying several ticks ahead
  buys that much patience and nothing else; a lease that closes refunds nothing.
- A closed home keeps its disk and onion address for 7 days. Open again with the same keys.
- A restart of the host program leaves a running home alone. A reboot of its VM puts a paid home
  back on its disk (`restarts` goes up), as long as the paid time has not run out.

From inside the box, the same CLI keeps paying with `CHARTER_PAYER=toon-client` and the box's own
wallet (`CHARTER_TOON_KEY_FILE`, `CHARTER_TOON_CHANNEL_STORE`, `CHARTER_TOON_CHAIN`; the connector and
the offer are already set in the box as `CHARTER_CONNECTOR_URL` and `CHARTER_OFFER_JSON`):

```sh
charter renew --offer <pubkey>:<id> --lease "$CHARTER_LEASE_ID" --max-intervals <n>
```

A home costs about 5 USDC for 30 days; a box that pays its own rent needs 2 USDC in its own channel and
a little Base ETH for the one on-chain channel open. The whole of it, for agents, is
https://charter.mainnet.toonprotocol.dev/agents#home.

From an agent (Claude Code) with a `toon` node: the `charter` plugin in this repo is a skill that
says what each packet holds and how `toon` 0.3 sends it, in the shape of
[toon-protocol/toon-plugins](https://github.com/toon-protocol/toon-plugins).

```sh
/plugin marketplace add drew-dot-com/charter
/plugin install charter@charter
```

The skill is `plugins/charter/skills/renting-charter-compute/SKILL.md`; its `references/lease-loop.sh`
runs one whole lease as one command.

## Host

Next to a running `toon` node, with Docker and Node 22 or later:

```sh
npm ci && npm run build && npm install -g --prefix ~/.local .
docker build -t charter-job-fetch jobs/fetch
docker build -t charter-job-python jobs/python
docker build -t charter-home jobs/home        # only if the host offers homes
toon add charter-open   --to relay --url http://127.0.0.1:7401/ --price 1000 --yes
toon add charter-tick   --to relay --url http://127.0.0.1:7402/ --price 7000 --yes
toon add charter-status --to relay --url http://127.0.0.1:7403/ --price 100  --yes
```

Then fill `~/.config/charter/env` from `deploy/host/env.example` and enable
`deploy/host/charter-host.service` (systemd user unit). `charter-host land` redeems the host's
vouchers on chain. Every variable is in `docs/env.md`; the full deploy, door included, is
`docs/demo.md`.

A job container gets 1 CPU, 1 GiB, 256 pids, a read-only root, no capabilities and
`no-new-privileges`. With `CHARTER_PROXY` set, its traffic leaves through the host's Anyone proxy.

To offer homes, run `sudo bash deploy/host/install-home.sh` once in the VM (Charter's own Anyone
client, the `charter-home` bridge and its firewall, and a sudo rule for `losetup` only), add
`charter-home` to `CHARTER_ALLOW_IMAGES` and set `CHARTER_MAX_HOMES` and the other home variables
in `docs/env.md`. A home gets 512 pids and the same limits otherwise. Operating them:
`docs/ops.md`, "Homes".

## Develop

```sh
npm ci
npm test          # node --test
npm run typecheck
npm run dev:door  # the storefront with no payments and a fake host
```

## License

MIT
