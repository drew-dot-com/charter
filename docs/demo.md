# Charter demo runbook

Status: first-party. Drew is on both sides of every lease below: he runs the host (`toon2`), the
door, the edge, and both renters (Edison and his own browser wallet). Charter has no outside users.

```
browser wallet --x402 (Base USDC)--> door (Hetzner, charter.167-233-221-236.sslip.io)
                                       --TOON, door's Solana channel--> edge (connector.mainnet.toonprotocol.dev)
Edison's node (toon VM) --TOON--------->   --over Anyone--> toon2 (hidden host) --> charter-open / -tick / -status
```

Charter is a paying hop that never holds more than one interval: the door pays the host each
interval only after the renter's payment for it has verified.

## The four go-aheads

Nothing below a gate runs until Drew says go on that gate in chat.

| gate | what runs | spend |
| --- | --- | --- |
| 1. edge free-ride | per-app route prices on the edge, then a zero-amount probe | none |
| 2. small spends | offer publish (paid relay write), Edison's first lease | about 0.001 + under 0.10 USDC |
| 3. door | door payer key, Drew funds it, compose + Caddy | about 2 USDC deposit + a little SOL |
| 4. Edison tool | `charter_rent` into the live Edison, allow-listed to Drew | up to 5 leases a day, about 0.035 USDC each at most |

## 0. Build and install (no spend)

In both Lima VMs (`ssh air`, then `limactl shell toon` and `limactl shell toon2`):

- [ ] Node 22 or later: `node --version`.
- [ ] Copy the repo in, then `npm ci && npm run build && npm install -g --prefix ~/.local .`.
  Check: `~/.local/bin/charter` prints its usage.
- [ ] Clock: `timedatectl` says `System clock synchronized: yes` (the door's x402 windows need it too).

In `toon2` only:

- [ ] `docker build -t charter-job-fetch jobs/fetch`.
- [ ] `apt install socat`, then copy `deploy/host/charter-socks-connect` to `~/.local/bin/` and both
  units in `deploy/host/` to `~/.config/systemd/user/`. `loginctl enable-linger "$USER"`.
- [ ] `systemctl --user enable --now charter-socks`. Check from a container:
  `docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl -s --socks5-hostname 172.17.0.1:9150 https://api.ipify.org`
  prints an IP that is **not** Drew's home IP (`curl -s https://api.ipify.org` on the Mac). The
  connect script reads the node's SOCKS port at each connection, so nothing needs refreshing after `toon up`.

## 1. Gate 1: the edge free-ride (final review C5)

Found in Task 1: a zero-amount packet through the edge to a priced app is served, and the edge pays
the host. Until the edge prices each app route, anyone can make the edge pay `toon2`.

- [x] On the Hetzner box, three signed operator writes (as in `docs/spike-notes.md`):
  `/opt/refuel/deploy/sign-write.sh -k /root/keys-refuel/operator-write.key -u http://<edge container ip>:4000`
  - `POST /routes/peers {"prefix":"g.toon.69b2a212547e7a9c.charter-open","peer_id":"toon2","price":1000}`
  - `POST /routes/peers {"prefix":"g.toon.69b2a212547e7a9c.charter-tick","peer_id":"toon2","price":5000}`
  - `POST /routes/peers {"prefix":"g.toon.69b2a212547e7a9c.charter-status","peer_id":"toon2","price":100}`
- [x] Check: from Edison's node, a zero-amount `toon probe g.toon.69b2a212547e7a9c.charter-open --seal-to <toon2 onion /ilp URL> --json`
  is **rejected** (expected `F06`, refused by the edge). If it is fulfilled, stop: the gate failed.
- [x] **Done 2026-10-17.** The edge publishes the three prices (25 routes). Zero-amount probes from
  Edison to all three apps: `F06` from peer `drew` ("quotes 1000/5000/100 for this packet, which carried
  only 0"), `paid` 0; `toon2`'s inbound channel `E63r...` watermark stayed 400, so the edge paid nothing.
  Edison's node got the route `g.toon.69b2a212547e7a9c -> drew` back (step 3 needs it too).
- [ ] Drew's call: file the zero-amount forwarding bug as a connector issue for Jonathan.

## 2. Host up (`toon2`), offer publish (gate 2)

- [ ] `~/.config/charter/env` from `deploy/host/env.example`, mode 600. Fill `CHARTER_SEAL_KEY` and
  `CHARTER_SEAL_URL` from `toon describe --json`, `CHARTER_ILP_BASE` from `toon status --json`.
- [ ] The three apps, each on the `relay` TOON app:
  - `toon add charter-open --to relay --url http://127.0.0.1:7401/ --price 1000 --yes`
  - `toon add charter-tick --to relay --url http://127.0.0.1:7402/ --price 5000 --yes`
  - `toon add charter-status --to relay --url http://127.0.0.1:7403/ --price 100 --yes`
- [ ] `charter-host offer --print` and read it: prices, `images: [charter-job-fetch]`, `hiddenHost`,
  `hiddenEgress`, `firstTickGraceSeconds: 90`.
- [ ] **Go-ahead (paid relay write):** `systemctl --user enable --now charter-host`. It publishes
  the offer and republishes it every 10 minutes.
- [ ] Check: `charter offers --relay wss://relay.mainnet.toonprotocol.dev` from the `toon` VM lists the
  offer. That read filters kind 31390 by `#L charter`, so it also proves Drew's relay stores the tag.
  Note the offer's `<pubkey>:<id>`: the door's `CHARTER_DOOR_HOSTS` and Edison's bridge need it.

## 3. Edison's first lease (gate 2, under 0.10 USDC)

- [x] In the `toon` VM: `toon route add g.toon.69b2a212547e7a9c --peer drew` (re-added 10-17 for gate 1).
- [ ] `charter rent --offer <pubkey>:<id> --urls https://api.ipify.org?format=json,https://browserleaks.com/webrtc,https://example.com --max-intervals 6 --relay wss://relay.mainnet.toonprotocol.dev --json`
- [ ] Check: state `done`, `paidIntervals >= 3`, output present. The ipify output and the WebRTC page
  show an exit IP and no candidate that is Drew's home IP.
- [ ] In `toon2`: `charter-host land`. Verify the printed tx on Solscan (finalized, no error).
  Never trust the tool output alone.
- [ ] Record below: lease id, paid intervals, spent, land tx.

## 4. The door (gate 3)

On the Hetzner box (`ssh -i ~/.ssh/toon_node root@167.233.221.236`):

- [ ] Copy the repo to `/opt/charter` (rsync from the Mac, no `node_modules`, `dist`, `.superpowers`).
- [ ] `install -d -m 700 -o 1000 -g 1000 /root/charter-door /root/charter-door/data /root/charter-door/secrets`
- [ ] The payer key, printed address only:
  `docker run --rm -v /root/charter-door/secrets:/s -v /opt/charter/deploy/door:/x:ro node:22-bookworm-slim node /x/new-payer-key.mjs /s/toon-payer.json`,
  then `chown 1000:1000` it (it is already mode 400). Back it up beside the other keys.
- [ ] `secrets/rpc-url`: the Helius URL, copied from `node-artifacts/helius.key` on the Mac with `scp`,
  never echoed. Mode 400, owner 1000.
- [ ] **Drew funds the printed address:** 2.1 USDC and about 0.01 SOL on Solana (the channel deposit
  is 2 USDC; SOL pays a later close and settle). Verify the balances on Solscan.
- [ ] `/root/charter-door/door.env` from `deploy/door/door.env.example`: `CHARTER_PAY_TO` = Drew's Base
  address (**needed from Drew**), `CHARTER_DOOR_HOSTS` = `<toon2 offer pubkey>=g.toon.69b2a212547e7a9c`.
- [ ] `cd /opt/charter && docker compose -f deploy/door/docker-compose.yml up -d --build`.
  Check: `docker logs charter-door` says `channel ready, headroom 2000000` (the boot opens the channel).
- [ ] Caddy: back up `/opt/toon-relay/deploy/Caddyfile`, append `deploy/door/Caddy.snippet` by writing
  the file in place (never `sed -i`), `docker cp` it to `deploy-caddy-1:/tmp/Caddyfile`, then
  `docker exec deploy-caddy-1 caddy reload --config /tmp/Caddyfile`.
- [ ] Check: `curl https://charter.167-233-221-236.sslip.io/v1/offers` lists the offer, and `/v1/door`
  shows Drew's `payTo` on `eip155:8453`.

## 5. Browser lease (Drew clicks Rent)

- [ ] Drew opens `https://charter.167-233-221-236.sslip.io` with his own browser wallet (USDC on Base),
  picks the machine, enters URLs, clicks Rent and signs each interval (one prompt per interval until
  Task 12's batch settlement).
- [ ] Check: the lease page reaches `done`; the x402 payments show on Basescan to `CHARTER_PAY_TO`;
  `door-ledger.json` shows 0 losses for the lease; `charter-host land` and its tx on Solscan.
- [ ] Record below.

## 6. Edison's tool (gate 4)

- [ ] Install the plugin from hermes-toon branch `charter-tool` (push it first), with a pty:
  `yes y | script -q /dev/null hermes plugins install --force --enable 'https://github.com/drew-dot-com/hermes-toon#src/charter_tool'`.
  Add `charter` to `platform_toolsets` for telegram and discord.
- [ ] `CHARTER_ALLOWED_IDS=telegram:<Drew's id>,discord:<Drew's id>` in `~/.hermes/.env`. Nobody else.
- [ ] Into the `toon` VM: `limactl copy src/charter_tool/vm/charter-bridge toon:~/bin/charter-bridge`
  (mode 700) and `~/.config/charter/bridge.env` with `TOON_PASSPHRASE_FILE`, `CHARTER_OFFER_ID`,
  `CHARTER_RELAY_URL` only. The bridge caps 5 leases a UTC day and 6 intervals each.
- [ ] Restart the gateway (`launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway`).
- [ ] Check: a non-allowed account asking Edison to rent is refused before anything runs (no new
  counter file in `~/.charter-bridge/`, no lease on the host). Then Drew asks for one real rent and
  it comes back `done` through the bridge, with its minimal env.

## Operating the door

**Headroom alert.** The door refuses an open (503 `capacity`) while its channel cannot pay the open,
the first tick and 10000 more, and a tick (503 `retry_later`) while it cannot pay the tick and 10000
more. It logs `charter-door: channel headroom ... is under ...` at most once a minute.
`docker logs charter-door 2>&1 | grep headroom` finds it; `channel status` (below) shows the number.

**Channel rotation.** A Solana channel cannot be topped up, and the gate stops the sends that would
replace it, so rotate by hand when no lease is running (the host runs one at a time):

```sh
cd /opt/charter
docker compose -f deploy/door/docker-compose.yml stop charter-door
docker compose -f deploy/door/docker-compose.yml run --rm charter-door node dist/door/main.js channel status
docker compose -f deploy/door/docker-compose.yml run --rm charter-door node dist/door/main.js channel rotate
docker compose -f deploy/door/docker-compose.yml start charter-door
```

`rotate` sends `request_close` on the old channel (SOL gas) and opens a fresh 2 USDC one. The old
deposit stays locked until `settle`, so **Drew sends 2 USDC more to the payer address first** and
verifies it on Solscan. If the open fails after the close went through, fund it and run `rotate`
again: with no open channel it only opens. Once the old channel's exit window has passed,
`channel settle` takes its unspent deposit back. Rotation is unproven on mainnet: check
`channel status` shows the new channel open and the old one closing, and verify both on Solscan.
Back up `data/channels.json` before and after; losing it strands a live deposit.

**Other.** The door spends at most 0.5 USDC a UTC day that no renter paid for (opens, free reads,
losses), then answers 503 `capacity` until the next UTC day. A payer who cost the door a loss is
blocked; `docker compose -f deploy/door/docker-compose.yml run --rm charter-door node dist/door/main.js unblock <0x address>`
clears one (a running door picks it up).

If the boot could not open the channel (`could not open its channel at boot` in the logs), the door
retries the open at most once a minute while opens and ticks come in; `docker compose ... restart charter-door` also retries it.

## What to say

"First-party, Drew on both sides." One hidden host on a home machine, one door, one edge, two
renters that are both Drew. Say "accountless" and "hidden host". Do not say anonymous payments, any
token, or that Charter has outside users.

## Proof

| | lease id | intervals paid | spent (micro-USDC) | txs |
| --- | --- | --- | --- | --- |
| Edison, step 3 | | | | land: |
| browser, step 5 | | | | x402: , land: |
