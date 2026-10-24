# Charter

Compute leases on the TOON payment network. A host posts an offer for a machine, a renter pays per
interval, and a container runs the renter's job for as long as the payments keep arriving. There is
no account on either side, and the host can be a home machine with no domain and no open port (a
hidden host, reached over Anyone).

**Status: v1, first-party.** Every lease so far has Drew Pierson on both sides: he runs the one host,
the door and the edge node, and both renters. There are no outside users yet. Two job images:
`charter-job-python` runs the renter's own Python script (up to 8 KiB, NumPy included) with no
network at all and returns its stdout, stderr and exit code; `charter-job-fetch` fetches up to five
pages in a headless browser and returns a screenshot and the text of each. Why the python job is
safe enough for a home host: `docs/superpowers/specs/2026-10-17-python-job-design.md`.

## How it works

- **Offer.** The host publishes a signed Nostr event, kind 31390, tag `["L","charter"]`: size,
  prices, the host's ILP address, the key to seal packets to, and badges. It lives 30 minutes and is
  republished every 10.
- **Lease.** The host's `toon` node serves three priced apps: `charter-open` (start a lease),
  `charter-tick` (pay one 30 second interval) and `charter-status` (read state and output). Each
  answers only its own action. The container is created at open and started only once the first
  interval is paid. A lease whose renter stops paying is closed at the end of the paid time.
- **Paying.** Packets are routed by ILP and settled by x402 channels. A renter with a `toon` node
  pays directly. A renter with only a browser wallet pays the door over x402 (USDC on Base), and the
  door pays the host over TOON. The door is a paying hop that never holds more than one interval:
  it pays the host each interval only after the renter's payment for it has verified.

v1 prices: open 0.001 USDC, one interval 0.005 USDC, a status read 0.0001 USDC.

## Rent

From a browser: open the storefront, connect a wallet holding USDC on Base, pick a machine, enter
URLs and click Rent. Your wallet signs once to put a deposit (at least 0.10 USDC) into an x402
channel. Each interval after that is signed by the page, silently. What you do not use comes back
when the lease ends.

From a `toon` node:

```sh
charter offers --relay wss://relay.mainnet.toonprotocol.dev
charter rent --offer <pubkey>:<id> --urls https://example.com --max-intervals 6 --relay wss://relay.mainnet.toonprotocol.dev --json
```

`TOON_PASSPHRASE_FILE` names the file with the node wallet's passphrase.

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
toon add charter-open   --to relay --url http://127.0.0.1:7401/ --price 1000 --yes
toon add charter-tick   --to relay --url http://127.0.0.1:7402/ --price 5000 --yes
toon add charter-status --to relay --url http://127.0.0.1:7403/ --price 100  --yes
```

Then fill `~/.config/charter/env` from `deploy/host/env.example` and enable
`deploy/host/charter-host.service` (systemd user unit). `charter-host land` redeems the host's
vouchers on chain. Every variable is in `docs/env.md`; the full deploy, door included, is
`docs/demo.md`.

A job container gets 1 CPU, 1 GiB, 256 pids, a read-only root, no capabilities and
`no-new-privileges`. With `CHARTER_PROXY` set, its traffic leaves through the host's Anyone proxy.

## Develop

```sh
npm ci
npm test          # node --test
npm run typecheck
npm run dev:door  # the storefront with no payments and a fake host
```

## License

MIT
