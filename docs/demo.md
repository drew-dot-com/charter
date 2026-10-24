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

- [x] Node 22 or later: `node --version`.
- [x] Copy the repo in, then `npm ci && npm run build && npm install -g --prefix ~/.local .`.
  Check: `~/.local/bin/charter` prints its usage.
- [x] Clock: `timedatectl` says `System clock synchronized: yes` (the door's x402 windows need it too).

In `toon2` only:

- [x] `docker build -t charter-job-fetch jobs/fetch`.
- [x] `apt install socat`, then copy `deploy/host/charter-socks-connect` to `~/.local/bin/` and both
  units in `deploy/host/` to `~/.config/systemd/user/`. `loginctl enable-linger "$USER"`.
- [x] `systemctl --user enable --now charter-socks`. Check from a container:
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
- [x] Drew's call: file the zero-amount forwarding bug as a connector issue for Jonathan.

## 2. Host up (`toon2`), offer publish (gate 2)

- [x] `~/.config/charter/env` from `deploy/host/env.example`, mode 600. Fill `CHARTER_SEAL_KEY` and
  `CHARTER_SEAL_URL` from `toon describe --json`, `CHARTER_ILP_BASE` from `toon status --json`.
- [x] The three apps, each on the `relay` TOON app:
  - `toon add charter-open --to relay --url http://127.0.0.1:7401/ --price 1000 --yes`
  - `toon add charter-tick --to relay --url http://127.0.0.1:7402/ --price 5000 --yes`
  - `toon add charter-status --to relay --url http://127.0.0.1:7403/ --price 100 --yes`
- [x] `charter-host offer --print` and read it: prices, `images: [charter-job-fetch]`, `hiddenHost`,
  `hiddenEgress`, `firstTickGraceSeconds: 90`.
- [x] **Go-ahead (paid relay write):** `systemctl --user enable --now charter-host`. It publishes
  the offer and republishes it every 10 minutes.
- [x] Check: `charter offers --relay wss://relay.mainnet.toonprotocol.dev` from the `toon` VM lists the
  offer. That read filters kind 31390 by `#L charter`, so it also proves Drew's relay stores the tag.
  Note the offer's `<pubkey>:<id>`: the door's `CHARTER_DOOR_HOSTS` and Edison's bridge need it.

## 3. Edison's first lease (gate 2, under 0.10 USDC)

- [x] In the `toon` VM: `toon route add g.toon.69b2a212547e7a9c --peer drew` (re-added 10-17 for gate 1).
- [x] `charter rent --offer <pubkey>:<id> --urls https://api.ipify.org?format=json,https://browserleaks.com/webrtc,https://example.com --max-intervals 6 --relay wss://relay.mainnet.toonprotocol.dev --json`
- [x] Check: state `done`, `paidIntervals >= 3`, output present. The ipify output and the WebRTC page
  show an exit IP and no candidate that is Drew's home IP.
- [x] In `toon2`: `charter-host land`. Verify the printed tx on Solscan (finalized, no error).
  Never trust the tool output alone.
- [x] Record below: lease id, paid intervals, spent, land tx.

## 4. The door (gate 3)

On the Hetzner box (`ssh -i ~/.ssh/toon_node root@167.233.221.236`):

- [x] Copy the repo to `/opt/charter` (rsync from the Mac, no `node_modules`, `dist`, `.superpowers`).
- [x] `install -d -m 700 -o 1000 -g 1000 /root/charter-door /root/charter-door/data /root/charter-door/secrets`
- [x] The payer key, printed address only:
  `docker run --rm -v /root/charter-door/secrets:/s -v /opt/charter/deploy/door:/x:ro node:22-bookworm-slim node /x/new-payer-key.mjs /s/toon-payer.json`,
  then `chown 1000:1000` it (it is already mode 400). Back it up beside the other keys.
- [x] `secrets/rpc-url`: the Helius URL, copied from `node-artifacts/helius.key` on the Mac with `scp`,
  never echoed. Mode 400, owner 1000.
- [x] **Drew funds the printed address:** 2.1 USDC and about 0.01 SOL on Solana (the channel deposit
  is 2 USDC; SOL pays a later close and settle). Verify the balances on Solscan.
- [x] `/root/charter-door/door.env` from `deploy/door/door.env.example`: `CHARTER_PAY_TO` = Drew's Base
  address (**needed from Drew**), `CHARTER_DOOR_HOSTS` = `<toon2 offer pubkey>=g.toon.69b2a212547e7a9c`.
- [x] `cd /opt/charter && docker compose -f deploy/door/docker-compose.yml up -d --build`.
  Check: `docker logs charter-door` says `channel ready, headroom 2000000` (the boot opens the channel).
- [x] Caddy: back up `/opt/toon-relay/deploy/Caddyfile`, append `deploy/door/Caddy.snippet` by writing
  the file in place (never `sed -i`), `docker cp` it to `deploy-caddy-1:/tmp/Caddyfile`, then
  `docker exec deploy-caddy-1 caddy reload --config /tmp/Caddyfile`.
- [x] Check: `curl https://charter.167-233-221-236.sslip.io/v1/offers` lists the offer, and `/v1/door`
  shows Drew's `payTo` on `eip155:8453`.

Done 2026-10-17: payer `DRSB3XhJxzDmtcVmPNZv9J1KnkgRXXM2aeaFPE7QEHUn` funded 2.11 USDC + 0.01 SOL
(finalized); boot opened channel `5akKFS2L9Wx3jMJtwVUW768xmEfy5e71cEzyb7W1M2Wm` (2 USDC, open tx
`3WGTDPaYeafv5HeC8snoKQxs6yr6mL7hPy3WXQTu34cZ3qiLJWCpETRFWyH7Hn5sY8rtmbNVr8iDN3PciYMaDY9g`, finalized,
owner `CHNLxYvV...`). `CHARTER_PAY_TO` = `0xbD87E8Ff0691f0A924e5ce2A06821db818B62385` (an EOA on Base).
Caddy backup `Caddyfile.bak-20261017-precharter`; relay, connector, l402 and lading still answer 200.
The key's backup is `/root/keys-charter/toon-payer.json.bak-20261017`. On this box there is no uid 1000
user, so make the dirs with `install -d -m 700` then `chown -R 1000:1000`.

## 5. Browser lease (Drew clicks Rent)

- [x] Drew opens `https://charter.167-233-221-236.sslip.io` with his own browser wallet (USDC on Base),
  picks the machine, enters URLs, clicks Rent and signs each interval (one prompt per interval; section 8
  replaces this with one deposit prompt).
- [x] Check: the lease page reaches `done`; the x402 payments show on Basescan to `CHARTER_PAY_TO`;
  `door-ledger.json` shows 0 losses for the lease; `charter-host land` and its tx on Solscan.
- [x] Record below.

Notes (10-17): the first try failed with the wallet's own "Unexpected error" (a stuck connect request
or two wallet extensions on `window.ethereum`); clearing it fixed it. The page should pick a wallet by
EIP-6963. With a door fee of 0 the door carries the open and the reads, 1600 on this lease.

## 6. Edison's tool (gate 4)

- [x] Install the plugin from hermes-toon branch `charter-tool` (push it first), with a pty:
  `yes y | script -q /dev/null hermes plugins install --force --enable 'https://github.com/drew-dot-com/hermes-toon#src/charter_tool'`.
  Add `charter` to `platform_toolsets` for telegram and discord.
- [x] `CHARTER_ALLOWED_IDS=telegram:<Drew's id>,discord:<Drew's id>` in `~/.hermes/.env`. Nobody else.
- [x] Into the `toon` VM: `limactl copy src/charter_tool/vm/charter-bridge toon:~/bin/charter-bridge`
  (mode 700) and `~/.config/charter/bridge.env` with `TOON_PASSPHRASE_FILE`, `CHARTER_OFFER_ID`,
  `CHARTER_RELAY_URL` only. The bridge caps 5 leases a UTC day and 6 intervals each.
- [x] Restart the gateway (`launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway`).
- [ ] Check: a non-allowed account asking Edison to rent is refused before anything runs (no new
  counter file in `~/.charter-bridge/`, no lease on the host). Then Drew asks for one real rent and
  it comes back `done` through the bridge, with its minimal env.

Done 2026-10-17 (gate 4): installed the way `toon-node` was, by copying hermes-toon `28d8fff`
`src/charter_tool` to `~/.hermes/plugins/charter-tool` (no push needed), `hermes plugins enable
charter-tool`, `charter` added to `platform_toolsets.telegram` and `.discord` (backups
`config.yaml.bak-20261017-precharter`, `.env.bak-20261017-precharter`). Allowed:
`telegram:6082398535,discord:1001391808925925438`. Bridge `~/bin/charter-bridge` (700) and
`bridge.env` (600) in the `toon` VM. Refusal smoke test: the installed `charter_rent`, called under
Hermes' own session context as Jonathan's and Jim's Discord ids, a stranger's Telegram id, an empty id,
and Drew's Telegram id on Discord, refused every one before the bridge (a tripwire on `subprocess.run`
never fired, and the VM has no `~/.charter-bridge`). Drew's two ids reached the bridge. Not yet done:
a real rent through Edison from chat, and a refusal from a second real account.

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

Step 0 to 3 notes (10-17): Node 22.23.3 installed in both VMs (`~/.local/node`, checksum verified).
Job egress through the relay was `82.22.174.135`, not the home IP; the lease's WebRTC page showed no
public IP. Offer `cde9138b...:toon2-fetch-1`, event `886a16d4...`. Edison's channel `121CYE4w...`
moved 19200 to 25700 (6500); `toon2`'s inbound `E63r...` watermark and landed 6900. The land tx moves
no USDC: a Solana channel pays out at settle. The host republishes the offer every 10 minutes, and
each publish is a paid relay write of 1000, so a running host costs about 0.14 USDC a day.

| | lease id | intervals paid | spent (micro-USDC) | txs |
| --- | --- | --- | --- | --- |
| Edison, step 3 (10-17 18:17 UTC) | `c73ccd97ab6987023b37c99281f12a34` | 1 (the job finished inside it) | 6500 (open 1000, tick 5000, 5 reads) | land (Solana, finalized): `E6C5MaGtD5PyTURWSM5GYufXdE9boBZGkYiyhyHtFaNBVX2Wbjgk4EFBfDSQreFbcyuDJajkUfVdDsMsKxt535k` |
| browser, step 5 (10-17 18:53 UTC, Drew's wallet) | `0b4ce38ec3ea43a7172f8df136a68501` | 1 | renter 5000 over x402; door paid host 6600 (open 1000, tick 5000, 6 reads), 0 losses | x402 (Base): `0xaa19e753857fb3347f83d02d0fc84d7024f37a92a734f35756912476a58bf51d`; land (Solana, finalized): `mNmAd7kHpTwM3ep98JzPXKKPJioB2sGhDwGmLpsyPySQKgHc2spFnNoN5o3nEfn1Ewogc93Nadj4AouV8j2B5Sp` |

## 7. The python job (2026-10-17)

- [x] `toon2`: gVisor `runsc` release-20261012.0 from the gVisor apt repo, `sudo runsc install`, then
  `sudo systemctl reload docker` (a reload, so the relay container stayed up). Systrap platform, no KVM.
- [x] `docker build -t charter-job-python jobs/python`; both images probed under `runsc` with the runner's
  exact flags (no network, caps 0, fsize/tmpfs/AS/NPROC caps hold; fetch still exits through Anyone).
- [x] Source in `~/src/charter` replaced from `python-job` (dist backup `/tmp/charter-dist.bak-*`), env backup
  `~/.config/charter/env.bak-*-prepython`; env now `CHARTER_ALLOW_IMAGES=charter-job-fetch,charter-job-python`
  and `CHARTER_RUNTIME=runsc`. Restarted `charter-host`: offer event `b3c9e90a...` lists both images.
- [x] Door: backup `/opt/charter.bak-20261017-2108`, rsync, `compose up -d --build`; `channel ready, headroom 1993400`.
- [x] Drew: one paid python lease from the browser (Run Python, the example script). Check: `done`, the
  result shows, 0 losses in the door ledger, then `charter-host land` in `toon2` and the tx on Solscan.

Done 2026-10-17: lease `ad14ba77f60adba4374e264e0410a4e6`, `charter-job-python` under `runsc`, network `none`,
exit 0 in 1.2 s (pi 3.1413, eigenvalue 749.8), 1 interval paid by the renter (`0xa95483d2...6a45`) and to the
host, 0 losses. Land tx `4vVwtjimF88jfpb8a7KStXewh9id3mew1YFEMViH6uKNuNY2i5c7fSDdkWwmWTSqpxZhjHsmKzZqMs8N5BTwr2ci`
finalized, no error. First renter-supplied code run on Charter (first-party: Drew on both sides).

## 8. Batch settlement: one prompt per deposit (2026-10-20)

Spec `docs/superpowers/specs/2026-10-20-batch-settlement-design.md`, plan `docs/superpowers/plans/2026-10-20-batch-settlement.md`.
The door offers x402 `batch-settlement` beside `exact` on the tick route. A browser renter's wallet signs
once to deposit at least 0.10 USDC into a channel on the x402 contract; the page signs every tick after
that with a session key it keeps in localStorage; the door claims and settles hourly and refunds idle
channels after 10 min. PayAI (`facilitator.payai.network`) submits every transaction.

- [x] Door deployed 2026-10-20 18:30 UTC: backup `/opt/charter.bak-20261020-1829-prebatch`, rsync, `compose build`,
  claim key made inside the image as uid 1000 (`/root/charter-door/secrets/claim-key`, 0400), `compose up -d`.
  Boot: `channel ready, headroom 1986900`. **Claim authorizer `0x590efEAa332eDc7D58FE2282fC1ef8010cD16C66`** (no funds, ever).
- [x] Live 402 on lease `4b30a283…` (opened for the check, left to lapse): accepts `batch-settlement` then `exact`,
  both 5000 to `0xbD87…2385`; batch extra `receiverAuthorizer 0x590e…6C66`, `withdrawDelay 3600`.
  `charter-door x402 status`: `no channels`.
- [x] 🏆 **FIRST BATCH-SETTLED BROWSER LEASE, 2026-10-20 ~19:57 UTC.** Drew's browser, wallet
  `0x4d7b7960…c8f4`, ONE prompt (MetaMask showed several "unknown site" warnings on the way to it).
  Lease `811904795c4b68fcfd8a9020dfc03e50`: done, 1 interval (the fetch job finishes inside one), 0 losses.
  Channel `0x10837ec6…530b` (payer authorizer = the page's session key `0xf10b2D55…CE09`, receiver
  authorizer `0x590e…6C66`). **Deposit tx `0x0a77f557494f952ee689bf343d45e9b4b1c59fa190e4f5b6728005bb7a691f13`**
  (block 52868446, 100000 micro-USDC from Drew's wallet to the x402 deposit collector `0x40208060…0004`).
  `x402 status` after: balance 100000, charged 5000, claimed 0.
- [x] `x402 claim` → claimed 5000 (status: claimed 5000); the first settle right after said
  `nothing_to_settle` (claim not mined yet; the command now prints the claim hash before trying, this run's
  claim hash was not captured). `x402 settle` a minute later →
  **settle tx `0x5abcf2fc8daa68c92fac910e08b4073cfa3555fe7391da6587d1d615fed258d0`** (block 52868505,
  5000 micro-USDC from the contract to `CHARTER_PAY_TO` `0xbD87…2385`).
- [x] Refund by the door's timer, no hand involved: log `x402 refunded 0x10837ec6…530b tx
  0xf69dcfcbe87454369ba634550b07a67dcde0da74213869878dfaf174a1d006ca`; on chain (block 52869028) 95000
  micro-USDC from the contract to Drew's wallet. `x402 status` after: `no channels`. (The settle that
  follows a refund said `nothing_to_settle`, correct here: the 5000 had been settled by hand already.)
  Whole loop, first to last: deposit 100000 in, 5000 to CHARTER_PAY_TO, 95000 back. Renter's cost: half a cent.
- [x] **Second lease from the same wallet after the refund, ~20:30 UTC: ONE prompt, batch, no fallback.**
  Lease `2663d176c98a0e8490bf232c31ef007d`, 1 interval, 0 losses. Deposit tx
  `0x390ced3a098df76a32da65abc85080e1579faeb6141121c001f9d64688f9fa2b` (block 52869437, 100000). The page's
  stored record was stale after the refund; it rebuilt the channel from chain and continued the cumulative:
  `x402 status` = balance 105000, charged 10000, claimed 5000 (same channel id `0x10837ec6…530b`). No USDC
  transfer to payTo from the wallet, so no exact payment was made. This is the case the review's critical
  finding covered, now proven. The timer will claim, settle and refund this one too.

Ops: `docker compose -f deploy/door/docker-compose.yml run --rm charter-door node dist/door/main.js x402 status | claim | refund`
(safe beside the running door). Channel records: `/root/charter-door/data/x402-channels/server/*.json`.
Back out: `compose down`, restore the backup dir, `compose up -d --build`; the old door ignores the claim key env.

## 10. Tick timing deploy (2026-10-24)

One packet over the onion hop to `toon2` took 2 to 15 s on 2026-10-24, so a tick paid 10 s before
the paid time ran out could land after the host's grace (lease `c04ced6f…`, `missed_tick`). Fix
`c5e3f1c`: `tickLeadMs` = half the interval, never under 10 s, for the tenant loop and the page;
the loop counts paid time from when the tick was sent.

- [x] Door: backup `/opt/charter.bak-20261024-2118-pretick`, rsync, `compose up -d --build`;
  `channel ready, headroom 1964000`, healthy, `/v1/door` 200, served `app.js` equals the local build.
- [x] `toon` VM (Edison's `charter` CLI): source backup `~/src/charter.bak-20261024-2119-pretick`,
  fresh source from `git archive c5e3f1c`, `npm ci && npm run build`; `dist/cli.js` needs `chmod +x`
  after an archive extract. `charter offers` lists the live offer.
- Back out: restore either backup directory and rebuild as in section 5.
- The Claude Code plugin's `references/lease-loop.sh` (section-less; `plugins/charter`) already used this timing.
