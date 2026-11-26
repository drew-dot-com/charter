# Charter demo runbook

**History.** Every section below (0 to 17, "Operating the door" included) records Charter before the
open-hosts change of 2026-11-23, when the door paid hosts over TOON and hosts published offers to a relay.
Nothing in today's path is TOON: renters pay the door over x402 on Base, the door pays each host over its
own x402 `batch-settlement` channel on Base, and hosts register themselves (README.md, "How it works" and
"Run a host"; `docs/ops.md`). The commands below are kept as the record, not as instructions.

Status: first-party. Drew is on both sides of every lease below: he runs the host (`toon2`), the
door, the edge, and both renters (Edison and his own browser wallet). Charter has no outside users.

```
browser wallet --x402 (Base USDC)--> door (Hetzner, charter.mainnet.toonprotocol.dev)
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
- [x] `cd /opt/charter && docker compose -f deploy/door/docker-compose.yml up -d --build charter-door`.
  Check: `docker logs charter-door` says `channel ready, headroom 2000000` (the boot opens the channel).
- [x] Caddy: back up `/opt/toon-relay/deploy/Caddyfile`, append `deploy/door/Caddy.snippet` by writing
  the file in place (never `sed -i`), `docker cp` it to `deploy-caddy-1:/tmp/Caddyfile`, then
  `docker exec deploy-caddy-1 caddy reload --config /tmp/Caddyfile`.
- [x] Check: `curl https://charter.mainnet.toonprotocol.dev/v1/offers` lists the offer, and `/v1/door`
  shows Drew's `payTo` on `eip155:8453`.

Done 2026-10-17: payer `DRSB3XhJxzDmtcVmPNZv9J1KnkgRXXM2aeaFPE7QEHUn` funded 2.11 USDC + 0.01 SOL
(finalized); boot opened channel `5akKFS2L9Wx3jMJtwVUW768xmEfy5e71cEzyb7W1M2Wm` (2 USDC, open tx
`3WGTDPaYeafv5HeC8snoKQxs6yr6mL7hPy3WXQTu34cZ3qiLJWCpETRFWyH7Hn5sY8rtmbNVr8iDN3PciYMaDY9g`, finalized,
owner `CHNLxYvV...`). `CHARTER_PAY_TO` = `0xbD87E8Ff0691f0A924e5ce2A06821db818B62385` (an EOA on Base).
Caddy backup `Caddyfile.bak-20261017-precharter`; relay, connector, l402 and lading still answer 200.
The key's backup is `/root/keys-charter/toon-payer.json.bak-20261017`. On this box there is no uid 1000
user, so make the dirs with `install -d -m 700` then `chown -R 1000:1000`.

## 5. Browser lease (Drew clicks Rent)

- [x] Drew opens `https://charter.mainnet.toonprotocol.dev` with his own browser wallet (USDC on Base),
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

## Operating the door (TOON era)

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
each publish is a paid relay write of 1000, so a running host costs about 0.14 USDC a day (every 20
minutes and about 0.07 a day since 2026-11-02).

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

## 11. A name and security headers (2026-10-27)

The door answers at `charter.mainnet.toonprotocol.dev` once Jonathan adds the A record (the zone
has a wildcard to Porkbun parking, so the name resolves elsewhere until then). The sslip name keeps
working through the cut-over; both are in `deploy/door/Caddy.snippet`, which also sets HSTS,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and a CSP (`default-src 'self'`,
`img-src 'self' data:` for job screenshots, `connect-src 'self'`, `frame-ancestors 'none'`). The
page calls only its own origin: wallet RPC and signing go through the injected wallet.

- [x] Caddy: backup `Caddyfile.bak-20261027-preheaders`, the block replaced in place, `docker cp`,
  `caddy reload`; `curl -sI` shows the headers, `/v1/offers` lists the offer, relay, connector,
  l402, lading and ipfs answer as before. A local dev lease (fetch job, screenshot, output) under the
  same headers and a live page load plus the rent form show no CSP violation in the console.
- [ ] **Jonathan:** A record `charter.mainnet.toonprotocol.dev` to `167.233.221.236`, TTL 600.
  Caddy retries the certificate in the background and gets it once the name resolves here.
- [ ] After the record resolves: republish `site/index.html` to Arweave (it links the new name),
  then drop the sslip name from the Caddy block if nothing still links it.
- Back out: `cat Caddyfile.bak-20261027-preheaders > Caddyfile`, `docker cp`, `caddy reload`.

## 12. Early status reads (2026-11-04)

With the hourly offer, the tenant loop's one status read at half the interval meant a five second
fetch through `charter rent` was not seen for 30 minutes (found by Edison's charter-tool 0.3.0
upgrade: the bridge kills `charter` at 540 s). Fix: after each tick the loop reads 10 s in, then
at doubling gaps, then at the half-way point where it pays again; the wait-out after the last
tick is watched the same way. At most nine reads a watched hour (0.0009 USDC). The skill's
`references/lease-loop.sh` and SKILL.md step 1 got the same change (plugin 0.2.1).

- [x] `toon` VM (Edison's `charter` CLI): source backup `~/src/charter.bak-20261104-1225-prewatch`, f7054f8 built 12:25 VM time,
  fresh source from `git archive`, `npm ci && npm run build`, `chmod +x dist/cli.js`.
- Host and door unchanged: the host's lease machinery and the storefront's own poll were already right.

## 13. The first home (plan section 8)

The `charter-home` image on toon2: a box with a 2 GiB disk kept between leases, SSH in at an onion
address, egress only through Charter's own Anyone client. Design:
`docs/superpowers/specs/2026-11-04-home-image-design.md`; operating it: `docs/ops.md`, "Homes".
Run 2026-11-04 20:39Z to 21:25Z with Drew present (toon2's journal prints local time, five hours
earlier); the lapse and re-open step follows after 21:57:49Z, the paid hour's end.

- [x] Built on the Mac at main 2aa60b1 (`npm test` 484, typecheck, build), tarred `dist`, `src`,
  `package.json`, `jobs/home`, `deploy/host`, copied into toon2 over `~/src/charter`. Source backup:
  `~/src/charter/dist.bak-20261104-prehome`.
- [x] toon2: `docker build -t charter-home jobs/home` (image a6490f726b84, 709 MB), then
  `CHARTER_IMAGE_TESTS=1 node --test jobs/home/home.test.mjs` exit 0 under runsc on a real loop disk.
  Lima disk NOT grown (Drew's call: skip for now; 5.5 GiB free, one slot fits).
- [x] No live lease; `sudo ./install-home.sh` wrote `~/.local/bin/anon`, the GeoIP copies, the anonrc,
  both system units, `/usr/local/bin/charter-home-net.sh` and `/etc/sudoers.d/charter-home`; network
  `charter-home` on `br-fe24d63a6a96`; anon bootstrapped 100% and listens on `172.19.0.1` tcp 9050, 9080
  and udp 53; `DOCKER-USER` drop and the seven `INPUT` rules plus the `ip6tables` drop in place.
- [x] The fence, from a container on `charter-home`: direct `https://example.com` 000; through
  `-x http://172.19.0.1:9080` 200; through `socks5h://172.19.0.1:9050` 200; `http://172.19.0.1:22` and
  `http://172.17.0.1:9150` time out; from the VM shell `172.19.0.1:9050` times out (by design);
  `getent hosts example.com` resolves from a runc container; SOCKS to `172.19.0.1:22` is refused (97).
- [x] Host env: backup `~/.config/charter/env.bak-20261104-prehome`; `CHARTER_MAX_HOMES=1`,
  `CHARTER_ANON_HS_DIR`, `CHARTER_ANON_PIDFILE`, `CHARTER_TENANT_CONNECTOR_URL=https://connector.mainnet.toonprotocol.dev/ilp`,
  `CHARTER_HOST_PUBKEY=cde9138b…fb91`, `charter-home` in `CHARTER_ALLOW_IMAGES`; restart at 20:52Z;
  offer event `9663da03…2bcb` lists three images and `home: { diskGiB: 2, retentionDays: 7, slots: 1 }`.
  First deploy failure: the unit's PATH lacked `/usr/sbin`, so `mkfs.ext4` could not spawn and a bare
  home open answered `boot_failed` (lease `326859c3…`); fixed in the installed unit and in
  `deploy/host/charter-host.service` (commit e339898, which also logs the boot failure's cause).
- [x] Door: backup `/opt/charter.bak-20261104-prehome`, rsync, `compose up -d --build` (healthy, headroom
  1945900). `GET /v1/offers` lists the home terms. Bare home open through the door: lease
  `92aa7746…` `awaiting_first_tick` with record port 22000, a 2 GiB sparse `disk.img`, one loop device, the
  volume and a created container; 100 s later `missed_tick`, `paidIntervals` 0, record, directory, loop
  device, volume and container all gone.
- [x] Proof from the `toon` VM (Edison's node): `charter rent --offer cde9138b…:toon2-fetch-1 --home
  ~/charter-home-test-key.pub --max-intervals 1 --relay wss://relay.mainnet.toonprotocol.dev`. Lease
  `8608c96c6091a62877bd79ebaf515094`, homeId `4bf93f0a2bde316f`, onion
  `2sqyr6so7vzg67mjwxdzhhs3ik3gkfors4bferrwye37o4mesmmjp7yd.anyone`, `access` set and the ssh line printed
  by the CLI within a minute of tick 0; paid through 1793829469079 (21:57:49Z).
- [x] `ssh` in over the node's SOCKS port (65327): user `tenant`; env `HTTPS_PROXY`, `ALL_PROXY`,
  `CHARTER_LEASE_ID` present in the session; `/charter/paid-through` readable; disk 2.0 GiB, 1.9 free;
  `curl https://example.com` 200 through the proxy; `curl --noproxy '*'` 000; zero setuid files;
  host key `SHA256:+cJSc0uD5192pg4AX2fZBlx5g9KQ7w/Lh5Z8uoq+H0g`; wrote `~/kept` and a long-running
  `~/.charter/boot.sh`. Step 6 HTTP half: `NODE_USE_ENV_PROXY=1 node -e fetch(CHARTER_CONNECTOR_URL)`
  answered 200 from inside the box (undici prints an experimental warning).
  Found: `getent hosts example.com` resolved NOTHING in the box. Cause: under runsc docker's embedded
  resolver (127.0.0.11) is unreachable; verified with two throwaway runsc containers (embedded: empty;
  bind-mounted `resolv.conf` with `nameserver 172.19.0.1`: resolves). Fix: the host writes
  `<home>/charter/resolv.conf` and mounts it at `/etc/resolv.conf` (commit 00886dd), deployed 21:06Z.
- [x] `systemctl --user restart charter-host` at 21:05Z: the box untouched (container `StartedAt`
  unchanged, `restarts: 0`). Then `docker rm -f charter-8608c96c…` and a restart at 21:07Z: the box
  re-created on the same volume and port, `restarts: 1`, same onion, `/etc/resolv.conf` mounted from
  the host, one loop device. In-box recheck from Edison's node at 21:21Z: `~/kept` present, `~/booted`
  present (so `boot.sh` ran at start), `getent hosts example.com` resolves inside the box, `/etc/resolv.conf`
  is the host's file, host key unchanged.
  Found: for about 14 minutes after the re-create, Edison's node got "Connection timed out during banner
  exchange" while the onion answered at once through Charter's own anon. Cause: the host's re-publish sent
  anon a HUP, which "resets internal state" and kills the live rendezvous circuits; the client kept
  attaching to a dead one until it expired. Fix: publishing an unchanged onion conf sends no HUP (commit
  712a185), deployed 21:24Z.
- [x] The lease lapsed at 21:58:12Z (`closed missed_tick`, `paidIntervals` 1, `restarts` 1); the record
  became `paidOnce: true, lastClosedAt: 1793829479728`; the 2 GiB disk and the onion keys stayed; the
  container was removed and the onion conf retired (the loop device and the docker volume stay attached
  for a retained home, which is harmless and saves a re-attach). The `rent` process reported
  `spent 0.0096 USDC` for open, tick and reads. Re-opened at 21:59Z with the same key: lease
  `acb80d64498c4684e42aae40ccd59936`, the same homeId `4bf93f0a2bde316f`, the SAME onion address, `~/kept`
  and `~/booted` present, host key unchanged. Edison's node needed two retries (about 40 s) before the
  onion answered: the retire and the new publish each reload anon, as the ops notes say. Total spend
  for the two leases: about 0.019 USDC.
- [ ] From inside the box: one `charter status` with `CHARTER_PAYER=toon-client` against a channel Drew
  funds (channel `<id>`, Base ETH for the open included): `<result>`. The HTTP half (Node fetch through
  the env proxy) is proven above; the toon-client half runs when Edison's box gets its funded key (Task 15).

### Edison moves in (plan Task 15)

Run 2026-11-04 23:00Z to 2026-11-05 09:55Z, Drew present for the funding and the first message.

- [x] Edison's home opened from the `toon` VM with its own key pair (`~/.ssh/charter-edison-home`, kept on
  the node): first lease `65dc49d22ce5ff7f0bc751a142f89492` (23:01Z, two ticks from the node, lapsed 01:01Z
  overnight), re-opened on the same key 09:37Z as lease `5ec56ea899aeee5c98407afd99ec8f2c`, homeId
  `ac83e7d58faf521d`, onion `6g4pbj3gmvvfynu3ex65bva5ziwb5chekdif7nhebspphu4rrnid2tid.anyone`, same disk.
- [x] In the box: the charter CLI (dist plus node_modules copied in, 150 MB), a Base payer key made inside
  the box (`~/.charter/payer.key`, never left it; address `0xB8C6DB6059A23327A983eE075E4d35c02CFcec7b`),
  Hermes 0.22.7. The official installer does not fit the 2 GiB disk (567 MB of tool bundles, a Node that
  needs `libatomic.so.1`, a 512 MB clone and a venv on top), so Hermes was installed lean: the installer's
  clone kept, `UV_PROJECT_ENVIRONMENT=~/.hermes/venv uv sync --locked --no-default-groups --extra telegram
  --extra discord --extra google --extra mcp --extra web` (a plain `uv pip install -e .` installs none of
  the 46 base pins). Venv 297 MB. Hermes's package manager re-downloads its bundles at gateway start
  ("install out of sync"); removed twice, 722 MB free after.
- [x] Drew's `.env`, `config.yaml` and `SOUL.md` piped from the Air into the box over ssh (checksums equal;
  contents never shown). Gateway started 09:39Z (`~/.hermes/venv/bin/hermes gateway run`), Telegram
  connected in polling mode, 329 MB RSS; the Air's gateway stopped 09:40Z. Drew asked "where are you
  running right now?" and Edison answered from the box: "a sandboxed Linux container (gVisor environment)".
  Parked in the box: the WhatsApp platform (wants the Node bundle), the drewtrade MCP servers (Air paths),
  and the toon, l402 and charter tool plugins (they bridge through `limactl` on the Air).
- [x] Drew funded the box's address with 2.1 USDC and 0.001 ETH on Base (09:50Z).
- [x] **The milestone, 09:51:46Z: one paid packet from the box to Jonathan's node through Drew's edge.**
  `node ~/charter/two-hop-post.mjs` in the box opened the box's own channel to the edge (2 USDC deposit,
  one Base transaction; `rpcUrl` had to be named, the client could not read the ETH balance through its
  default RPC from inside the box) and sent a kind 1 Nostr write to `g.toon.relay` sealed to Jonathan's
  connector: `fulfilled=true status=200 paid=2`, event `2e5e5913c45eb3e7a71c2be6734b4f8228208840c0237b6b2da983949c921ddf`,
  read back from `wss://relay.toonprotocol.xyz` (kind 1, created 1793872287). Box, Drew's edge,
  Jonathan's node: two hops, one channel.
- [x] The box pays its own rent: `charter renew` in the box with `CHARTER_PAYER=toon-client` on that
  channel (started 09:53Z, 720 ticks, pays when due) paid tick 1 at 10:08Z: the host shows `paidIntervals`
  2, paid through 11:37Z, and the box's channel total went from 1102 to 8102 units. Plan step 6's gate is
  met: the toon-client payer works from inside the proxied box with an explicit `rpcUrl`.

### One payer for everything (2026-11-05, 10:18Z to 11:10Z)

Edison's plugins and crons had bridged into the Air (`limactl`, the `toon` VM, a payer sidecar). In the
box they share the rent's one channel, and a channel store has exactly one writer, so the box now runs
one `charter payer` (charter main dab906f, 2d7261b, 93d2812; `docs/env.md`) and everything else pays
through it (`CHARTER_PAYER=url`, `TOON_PAYER_URL`, `CHARTER_PAYER_URL`, all `http://127.0.0.1:3510`).

- [x] 10:18Z: the running `renew` (toon-client payer) stopped and `charter payer` started 2 s later,
  then `renew` with `CHARTER_PAYER=url`; its first status read went through the service within 10 s,
  nothing missed (the next tick was 50 minutes away). `~/.charter/boot.sh` now starts payer, renew,
  gateway in that order (`payer.env`, `start-payer.sh`, `start-renew.sh`, `restart-gateway.sh`); a
  box re-create at 10:40Z ran it unattended and all three came back paying.
- [x] hermes-toon main ffa9298: charter-tool 0.4.0 (`CHARTER_PAYER_URL`), toon-node 0.2.0 (rewritten
  over the service; the VM bridge is gone), web-toon 0.1.3; installed in the box pinned to that sha
  (`hermes plugins install --force --enable --yes-deps --ref`, no pty needed).
- [x] 11:10Z, the three tools from inside the box, each paid from the box's channel
  `0x300c3432…fbd7`: `web_extract` of example.com through web-toon (1000, job `ed8d4472…`, content hash
  `6ad6a6c3…`), `charter_rent` of a Python job (lease `de176d5d95cb276039e8e5efa551c532`, done,
  `hello from a Charter python job aarch64 2`, 8200), `toon_post` on Drew's relay (event
  `ffe6b2e9a95ca2c8ce1b54cdcf69b651767b49b86a9028c1d10eb7511f2d71d7`, 1000, read back with
  `toon_read mine`). The channel's running total moved 18502 to 28702, exactly the three.
- [x] Crons: `ai-signal-digest`, `news-roundup-dm`, `ai-psychosis-starters` copied into
  `~/.hermes/cron/jobs.json` with `timezone: America/New_York` (same expressions as on the Air, whose
  gateway stays off), their pre-scripts and prompts in `~/.hermes/scripts`; the pre-scripts reach GitHub
  through the box proxy. First runs from the box: `news-roundup-dm` 11:30:52Z and `ai-signal-digest` 11:30:52Z
  (both completed and delivered by 11:31:38Z), `ai-psychosis-starters` 11:40:52Z (delivered 11:41:15Z).
  Found: Hermes's package manager refilled `~/.hermes/tools` (568 MB, then 206 MB of Python and uv during
  a plugin install) on the 2 GiB disk; `HERMES_DISABLE_LAZY_INSTALLS=1` in `payer.env` stops the per-start
  refill. Found: a plugin install built a package-manager environment without the Telegram and Discord extras
  and the next gateway start ran in it (`requirements not met`, 11:11Z to 11:17Z); moving that environment and
  the `venv` entry of its facts file aside (`~/.hermes/backups/pm-20261105T1135Z/`) and restarting brought both
  back. Found: the onion ssh session drops during a long command; run long work detached in the box.
  Still open in the box: Hermes's package manager re-downloads about 570 MB of tool bundles at every
  gateway start and fills the 2 GiB disk (removed three times); the toon, l402 and charter tool plugins and
  the crons bridge through the Air and do not work from the box. Both are being fixed in their own
  sessions (the hermes-toon plugins pay through one local payer; the Hermes-in-a-box image bakes the lean
  install into the image).


## 14. Hermes in a box (2026-11-05)

`charter-hermes`, the second home image: `charter-home` plus Hermes Agent 0.22.7 on its own CPython
3.14.9 under `/opt/hermes` (read-only, five extras), the charter CLI at `/usr/local/bin/charter`,
ripgrep, and a default `~/.charter/boot.sh` that starts `charter payer`, pays rent through it with
`renew`, and runs the gateway once `~/.hermes/.env` arrives. Design:
`docs/superpowers/specs/2026-11-05-hermes-in-a-box-design.md`; plan beside it; the image's facts in
`docs/ops.md`, "Homes". Built with Drew away ("defer to your recs"), reviewed task by task.

- [x] Code: charter main 48d51de (merge of `hermes-image`, 14 commits over c6a057a): `HOME_IMAGES`,
  `home.image` in the open body, `charter rent --image`, the storefront select, `/health` with a
  top-level `payer`, `jobs/hermes/` with its boot test (runs anywhere) and image test. 520 tests,
  typecheck and build green on main. Not pushed.
- [x] toon2: `docker build -t charter-home jobs/home` (home.sh now hands `HERMES_HOME` and
  `HERMES_DISABLE_LAZY_INSTALLS` to sessions), then `docker build -f jobs/hermes/Dockerfile -t charter-hermes .`
  from the staged tree `~/src/charter-hermes-build`: image `853b76c250ae`, 1.73 GB (709 MB shared base;
  `/opt/hermes/app` 186 MB, venv 360, python 92, charter 136). Build takes about two minutes on the VM.
  `CHARTER_IMAGE_TESTS=1 node --test jobs/hermes/hermes.test.mjs` under runsc on a real loop disk: pass,
  including the gateway smoke (a dummy `.env`, `boot: gateway started`, no `~/.hermes/tools`, no
  `Read-only file system`, no `out of sync`). Found on the way: with an empty `git init` and no stamp
  `hermes --version` said `vunknown`, so the tree carries an `install-stamp.json` with
  `updateMechanism: external` and the tag's commit (Hermes's two launch checks still skip it); and
  `charter --help` exits 2 by design. Untagged image layers pruned (342 MB; every charter tag kept);
  3.0 GB free after.
- [x] Host, 12:04Z, no lease awaiting its first tick: dist installed over `~/src/charter` (backup
  `dist.bak-20261105-prehermes`), `charter-hermes` added to `CHARTER_ALLOW_IMAGES` (env backup
  `env.bak-20261105-prehermes`), `systemctl --user restart charter-host`; offer `a5fbc512…f4ff` lists
  four images; Edison's container `StartedAt` unchanged, lease `5ec56ea8…` running, `restarts` 0.
- [x] Door, 12:05Z: backup `/opt/charter.bak-20261105-prehermes`, rsync, `compose up -d --build`, healthy;
  `GET /v1/offers` lists the four images; `/agents#hermes` and the `## Hermes in a box` section of
  `/llms.txt` are served; storefront 200.
- [x] Bare open through the door at 12:06Z with a throwaway key and `image: "charter-hermes"`: lease
  `3bae2e403f515e287c0c91ead40d96e0`, `closed busy` (the one home slot is Edison's), nothing created.
  `image: "charter-job-python"` in a home body: 400 `bad_request`. Both as documented.
- [x] Edison's move (plan Task 9), with one failure on the way. 13:32Z: the box's `renew` stopped (last tick 5,
  paid through 15:37Z); a waiter on the Air was to open the same key on `charter-hermes` at the lapse. The lease
  closed 15:37Z and the open FAILED: the waiter ran `charter rent` in the toon VM's login shell, which has no
  `TOON_PASSPHRASE_FILE`, so the CLI refused before paying and printed its usage. Edison was offline 15:37Z to
  19:49Z (the Air's gateway is off too), until the parent session re-opened the home on `charter-home` (lease
  `85069b50…`, tick 0 at 19:49Z). Lesson, now in the ops notes: source `~/.config/charter/bridge.env`
  (`set -a; . …; set +a`) before any paying `charter` command in the toon VM, and dry-check with a bogus offer
  id first (it fails at "no live offer" after the free relay read).
- [x] Redo, inside one lapse window: 19:50Z `renew` stopped in the box (paid through 20:48Z); 20:48:19Z lease
  `85069b50…` closed; 20:48:29Z the waiter's open from Edison's node landed: lease
  `09fb199ac8ba540344c3c4ec73b53e41` on `charter-hermes`, homeId `ac83e7d58faf521d`, the same onion
  `6g4pbj3g…tid.anyone`, tick 0 paid (0.008 USDC from the node). Edison's own `boot.sh` on the retained disk
  started its old payer, `renew` and gateway at once, so the outage was about a minute.
- [x] 20:50Z the switch to the image, over `docker exec` (the operator path; Drew's go): `~/.local/bin/charter`
  moved aside, Edison's `boot.sh` kept as `boot.sh.bak-20261105-prehermesimage`, `/app/boot-default.sh` copied
  over it, old processes stopped, the new boot started with `nohup`. Result: `charter payer` (pid 209) and
  `renew` from `/opt/charter`, `hermes gateway run` from `/opt/hermes/venv`; `boot.pid` and `payer.pid`
  written; `/health` ok; `agent.log` 20:50:24Z `telegram connected` and `discord connected`, polling healthy.
  No `~/.hermes/tools`. Then `rm -rf ~/.hermes/venv ~/.hermes/hermes-agent ~/charter ~/.local/share/uv`: the
  disk went from 213 MiB free to 1419 MiB free (27 % used). Container memory 471 MiB of 1 GiB. The first
  self-paid tick from the image's `renew` landed at about 21:18Z: `renew.log` `paid tick 1`, `/charter/paid-through`
  1793915305889 to 1793918905889 (one hour), paid through the box's `charter payer` on its own channel.

## 15. A trixie home, OpenHuman, and rent by plain x402 (2026-11-16)

Why: OpenHuman's founder agreed to be a tenant, and its official aarch64 build would not start in a
home (`GLIBC_2.39 not found`; the box was bookworm, glibc 2.36). Branch `feat/openhuman-home`.
Deploy steps: `docs/deploy-openhuman-home.md`.

- [x] `jobs/home/Dockerfile`: `BASE=debian:trixie-slim` (glibc 2.41, Python 3.13.5, OpenSSH 10.0p2); the
  image gains `charter-x402` (`jobs/home/x402-rent.mjs` with its modules in `/opt/x402`) and
  `Subsystem sftp internal-sftp` (a plain `scp` was refused before, on bookworm too: only `scp -O` worked).
- [x] toon2, new tags only, from the staged tree `~/src/charter-trixie-build`: `charter-home:trixie-1116`
  `940bf7093299` (842 MB; 709 MB before) and `charter-hermes:trixie-1116` `5cac2d5fffec` (1.94 GB; 1.73
  before). `latest` untouched. `CHARTER_IMAGE_TESTS=1 node --test` under runsc on real loop disks:
  `jobs/home/home.test.mjs` 1 of 1 (now also: plain `scp`, glibc 2.39 or newer, `charter-x402` on the
  PATH), `jobs/hermes/*.test.mjs` 11 of 11. `npm test` on the Mac: all pass, 2 image tests skipped.
- [x] A staged box (`~/src/charter-trixie-build/stage-box.sh up charter-home:trixie-1116`): the flags of a
  live home read off `docker inspect` (runsc, 1 CPU, 1 GiB, 512 pids, read-only root, no capabilities, the
  `charter-home` bridge with the Anyone proxies and DNS, a fresh 2 GiB ext4 loop disk), SSH on
  `127.0.0.1:22050`. Not a lease: `latest` could not be touched.
- [x] In it, the official `openhuman-core-0.64.15-aarch64-unknown-linux-gnu.tar.gz`: 141 MB down in 65 s
  through the fence, SHA-256 equal to the release's `.sha256`, 293 MB unpacked. `ldd` resolves against
  the box's own libc. `./openhuman-core run --host 127.0.0.1 --port 7788`: `/health` 200 after 1 s,
  `core.ping` over `/rpc` with the token in `~/.openhuman/core.token` answers `{"ok":true}`.
  `--version` is not a command (exit 1, "unknown namespace"); the start log names 0.64.15.
- [x] Memory, the number that matters in 1 GiB: 155 MB at 20 s, then the core downloads and indexes a
  104,239-entry skill catalog (`hermes-agent.nousresearch.com/docs/api/skills.json`, 40 s through the
  fence): 803 MB at the peak, 591 MB after, 68 MB on disk. With `OPENHUMAN_SKILL_REGISTRY_REFRESH_ON_BOOT=0`
  (OpenHuman's own switch, `skills/catalog/ops.rs`): 97 MB, flat over two minutes, with or without the
  cached catalog on disk. The 11-16 morning test's "140 MB" was read before the catalog landed.
- [x] `~/.charter/boot.sh` with the core in a restart loop: `docker restart`, `/health` 200 twelve
  seconds later, pid tree `home.sh` > `boot.sh` > `openhuman-core`.
- [x] v0.64.15's `/schema` (300 KB) names no `x402` and no `wallet` method: the release is built without
  the `web3` feature. `openhuman.x402_fetch` is on their main only (PRs 8690 and 8692, 11-12 and 11-13),
  in no tag. Skills: a `SKILL.md` under `~/.openhuman/workflows/<name>/` is listed by `skills list`;
  one under `~/.openhuman/skills/` is not.
- [x] `charter-x402` from inside the box against the live door, with an unfunded wallet so nothing was
  spent: `address` made `~/.charter/x402.key` (mode 400); an unpaid open through the door from the box
  (leases `e109e35b…` and `377212e8…`, each closed `missed_tick` unpaid after 90 s, 0.001 each of the
  door's own spend); `status` read it; `renew --once` reached the facilitator through the proxy and was
  refused as it should be: `payment refused (insufficient_funds …): does the wallet hold USDC on Base?`.
  `renew` holds 172 MB.
- [x] `deploy/host/charter-home-watch.sh` run by hand in toon2 against the live records, state in `/tmp`:
  `fail lapsed-ac83e7d5…` (Edison's home, closed `missed_tick` 02:48Z, kept until 11-23) and `ok
  home-e5fbcd39…` (the morning's test home, 37 min left); with the threshold raised to 90 min the second
  went `fail`, then back to `ok` with a "recovered". Not installed.
- [x] Drew's go, 18:10Z. toon2: old images kept as `charter-home:pre-1116` (`1124b47dbde7`) and
  `charter-hermes:pre-1116` (`0dac66d1e19c`); `latest` now `940bf7093299` and `5cac2d5fffec`. The
  morning's test home (lease `12f4c805…`, on the old image) was running and was left alone. No host restart.
- [x] A real home, opened by plain x402 from a fresh SSH key (`~/charter-openhuman-proof/key` in the
  `toon` VM): `node jobs/home/x402-rent.mjs open --keys proof.pub` on the Mac with the test payer
  `0xb66E…c715`. Lease `a924dce31c28a1fb7b17e5ba457bb7c0`, tick 0 settled by `exact` in 3 s, Base tx
  `0xd30fd3db3f375d274a1b216bfcafe4fed6f76d6950ec1afde3899182e411a990` (status 1, 7000 units to the door's
  payee `0xbD87…2385`), paid through 19:10:06Z. `access.ssh` set within 20 s:
  `uvqkkwxu…na6id.anyone`. The container runs image `940bf709…` under runsc.
- [x] In over the onion from the `toon` VM (`ssh -F ~/charter-openhuman-proof/ssh.cfg proof`, the node's
  Anyone SOCKS port 63244), first try. glibc 2.41, Debian 13.7. The install lines of `/agents#openhuman`
  as printed: checksum OK, 71 s, 293 MB.
- [x] The documented `~/.charter/boot.sh` (with `--max-intervals 1`, to hold the spend to one tick),
  started with `nohup`: `/health` 200, core 96 MB after a minute, `charter-x402 renew` waiting at 160 MB,
  247 MB of the box's 1024 in use. `docker restart` of the container at 18:13:34Z: 29 s later `boot.sh`,
  the core (95 MB, `/health` 200) and `renew` were all back, and the log says `boot catalog refresh
  disabled` at both starts.
- [x] The served skill file, copied in by a plain `scp` to `~/.openhuman/workflows/charter-home/SKILL.md`:
  `./openhuman-core skills list` shows `charter-home` with no warnings. `/schema` in the real box: no `x402`.
- [x] The box paid its own second hour, from inside, by plain x402: the boot script's `charter-x402 renew`
  woke when the tick came due (18:40:06Z, half an hour before the paid time ended) and paid index 1 at
  18:40:10Z through the fence. Base tx `0x7e202aa411fba376eb6a2e3e8d24ec93982372d04a5cdf77db1a708541967c58`
  (status 1, 7000 units `0xb66E…c715` to `0xbD87…2385`), `/charter/paid-through` moved to 20:10:06Z, the
  door ledger reads 2 renter ticks, 2 host ticks, 0 losses, and `renew` exited at its cap of one. The core
  was still at 96 MB after 27 minutes. The key in the box was the test payer's, piped in over SSH for this
  one tick and deleted from the box after it (0.006 USDC left in that wallet). Total spend: 0.014 USDC.
- [x] Door, 18:18Z (Drew's go): backup `/opt/charter.bak-20261116-preopenhuman`, rsync by checksum (no
  `--delete`), `compose up -d --build`, healthy in 12 s, `channel ready, headroom 1808600`. Live:
  `/llms.txt` has `## OpenHuman on Charter`, `/agents` has `#openhuman`, `/openhuman/SKILL.md` answers 200
  as `text/markdown` (3468 bytes), `/v1/offers` lists the four images and two home slots, a bare
  `POST /v1/rent` answers 402, the canary is ok. The proof lease kept its state across the restart.
- [x] Home watch, 18:19Z (Drew's go): `charter-home-watch.sh` and `charter-alert.sh` in `~/.local/bin/` on
  toon2, `~/.config/charter/ops.env`, a copy of the box's alert bot token at
  `~/.config/charter/telegram.token` (mode 600), `charter-home-watch.timer` enabled (every 5 minutes).
  First run: two Telegram messages delivered, "Charter home ac83e7d5 lapsed" (Edison's, since 02:48Z) and
  "Charter home e5fbcd39 lapses in 5 min" (the morning's test home, which nobody renews); the proof home
  read `ok`, 50 min left.
- [x] Skill from the live door, in the real home: the documented `curl` line to
  `~/.openhuman/workflows/charter-home/SKILL.md` is listed by `skills list` with no warnings. OpenHuman's own
  `skills install_from_url` fetches the same file but writes it to `~/.openhuman/skills/charter-home/`, which
  v0.64.15 does not list, so the docs keep the `curl` line.
- [x] Branch `feat/openhuman-home` pushed, then fast-forwarded into main and pushed at `07996fc` (Drew's go
  for each); 562 tests pass on main.
- [ ] Left as it is: the proof home lapses at 20:10Z (the watch will say so) and keeps its disk 7 days,
  with OpenHuman installed in `~/openhuman`. Not checked, and only the tenant can: an OpenHuman agent turn,
  and OpenHuman paying by itself (no release has the wallet).

## 16. The grant fund, first-party proof (2026-11-20/21)

Design: `docs/superpowers/specs/2026-11-20-grant-fund-design.md`; ops: `docs/ops.md`, "Grant fund". This
grant is first-party (Drew's own pitch and money) and is never counted as a renter.

- [x] Host, 22:12Z 11-20: toon2 code to main (backup `~/src/charter-host.bak-20261120-pregrant.tgz`),
  `charter-host` restarted with nothing running; the door's `/v1/offers` then shows `home.free: 2`.
- [x] Door, 22:14Z: backup `/opt/charter.bak-20261120-pregrant` and `door.env.bak-20261120-pregrant`, tree
  synced from main with `web/llms.txt`, `web/agents.html` and `web/index.html` held at 2bd5008 (no grant copy
  until charter-mcp 0.3.0 is published), `CHARTER_FUND_TOKEN_FILE` and `CHARTER_FUND_ADDRESS` added, rebuilt,
  healthy. `POST /v1/grants` answered `503 fund_closed` until the fund reported; `/v1/fund/queue` 401 without
  the token. The lockfile had to be regenerated with npm 10 first (`6821e95`): npm 11's lock failed `npm ci`
  in the node:22 images.
- [x] Fund: wallet `0xFD80174E28Cc2c0f37739659a63877c2D7544C61` (Base), key made in the fund image, token
  shared with the door, balance read from the public `https://mainnet.base.org` (the door's own RPC file is
  Solana). Gemini key placed by Drew. `charter-fund-check.sh` installed through `install-box.sh` (old
  scripts in `/root/ops-bak-20261120`); first run `ok`.
- [x] Funding: Drew sent 6 USDC (1 was the plan's figure, but one grant needs 720 x 7000 x 1.1 = 5.544 USDC of
  cover before the fund opens). Next cycle: `open: true, grantsLeft: 1`.
- [x] Pitch, 22:47Z: `charter-mcp pitch` (0.3.0, built locally) with a throwaway key made in the toon VM;
  grant `501316ecfe3f1d539c57a24f48a06b99`.
- [x] First judge call failed safely: Gemini answered 404 (`gemini-pro-latest is not found for API version
  v1`). The pitch stayed queued, nothing was counted or declined, and the problem was raised. Cause:
  `@google/genai` 3.x defaults to v1, where the `-latest` aliases do not exist. Fixed in `db7bfd8`
  (`apiVersion: 'v1beta'`); the alias resolved to `gemini-3.1-pro-preview`.
- [x] Verdict, 22:52Z: `approved_waiting`, reason "The pitch describes a concrete and legal technical test
  while identifying the operator and the future payment method." Flaw: the summary read "a shorttest", two
  words glued where the copy filter removed a phrase taken from the pitch.
- [x] Open, 22:52Z: lease `aaf775cbf3d9a39cf4fb314e2d92772a`, homeId `97da7fa76568ecba`, hour 0 paid
  (6.000000 to 5.993000 USDC).
- [x] Paying: the fund then paid every hour unattended for 11 hours. At 10:24Z 11-21 the fund counted 13 hours
  and the host `paidIntervals` 13; 6.000 - 13 x 0.007 = 5.909, which is the balance read on chain.
- [x] Onion SSH, 10:23Z: failed for 11 hours with `SOCKSv5 error: Host unreachable`. toon2's anon (running
  since 11-10, idle long stretches) logged the introductions but never completed a connection. After
  `sudo systemctl restart charter-anon` on toon2, SSH from the toon VM worked at once: `tenant`, 2.0G home
  disk, 2 CPUs, 1 GiB, `~/grant-proof.log` written. Egress from inside the home: 200 in under a second
  through both proxies. Note: a test from toon2 itself through `172.19.0.1:9050` always times out by design
  (the firewall accepts the proxy only from the homes' bridge).
- [x] Restart, 10:24Z: `docker restart charter-fund` mid-grant. Three cycles later: fund 13 hours, host 13,
  balance 5.909000, no problems. Nothing paid twice.
- [x] Stop, 10:27Z: `stop 501316ec...`; the door shows the grant `stopped` with `paidHours: 13`, the fund marks
  it `ended`. With 5.909 USDC the fund reopened intake (`open: true, grantsLeft: 1`).
- [x] Onion check added to `charter-home-watch.sh` on toon2 (backup `charter-home-watch.sh.bak-20261121-preonion`):
  the SSH banner of each running home through the toon node's own anon. Its first deploy had the watch
  restart charter-anon after 2 misses; at 10:36Z that sent Drew a false "unreachable" alert and restarted
  charter-anon, after which the onion stayed unreachable from two clients for over 10 minutes (SOCKS "TTL
  expired"). Now: alert after 3 misses in a row (15 minutes), no restart unless `HOME_ONION_RESTART=1`.
  Finding: onion reachability of a toon2 home is flaky in itself, which is the case for the SSH jump host.
- [x] Lapse: the lease closed `missed_tick` at 11:52Z after 13 intervals; the fund paid nothing after the stop
  (still 5.909000, no problems). The home watch said so on Telegram at 11:53Z. Disk and onion kept 7 days.

## 17. hel1 bring-up and the first plain-SSH home (2026-11-21/22)

Plan: `docs/superpowers/plans/2026-11-21-plain-ssh-homes.md`, Task 7. Server: charter-host-hel1, Hetzner CPX32,
Helsinki, 37.27.86.235, Ubuntu 24.04.5, x86_64; admin SSH `ssh -i ~/.ssh/charter_host root@37.27.86.235`.
toon2 kept running jobs; the door does not list hel1 yet.

- [x] Base: `install-host.sh` (Docker 29.10.0, runsc release-20261116.0, Node 22.23.5, anon
  0.4.10.2-live from Anyone's signed repository, held). First run failed at anon: the package asks debconf
  `anon/terms` and refuses without it; Drew accepted Anyone's terms, the script preseeds it (`1c0006e`).
- [x] Firewall: Hetzner Cloud Firewall `charter-host-hel1` (inbound 22, ICMP, 22000-22099, 80, 443; hel1
  only), not ufw (Docker-published ports bypass ufw). From outside: SSH open, a test listener on 9999 refused.
- [x] Node: toon 0.3.0 (release checksum checked) for user `charter`, `toon init --network mainnet --solana
  --clearnet 37-27-86-235.sslip.io --listen 127.0.0.1:7768` run by Drew (he holds the mnemonic). ILP
  `g.toon.7aa291d275b05d07`; offer signer `7beede203167265984d53fd1a10b770da69153feaaa25f5ec88cf31a3cbf0166`.
  Drew funded it (Base 0.0011 ETH + 1.1 USDC; Solana 0.021 SOL + 3.1 USDC). `toon join mainnet --deposit
  2000000 --chain solana` opened hel1's channel toward the edge (its relay writes). Caddy 2.10.2 (Docker, host
  network) terminates TLS for `37-27-86-235.sslip.io` with a Let's Encrypt certificate.
- [x] toon's clearnet mode is broken for peering (0.3.0 through 0.6.0): `render()` advertises
  `http://<listen>/ilp`, so the edge answered `publishes no endpoint this connector can dial`. Drew chose to
  patch: `~/src/TOON/toon_cli-clearnet` branch `clearnet-https-0.3.0`, commit `ba12925` (a clearnet app
  advertises `https://<hostname>/ilp`), built on hel1 in `rust:1.91-bookworm`, same embedded connector
  18da529; the official binary kept as `~/.local/bin/toon.official-0.3.0`. An issue for the toon_cli
  maintainer is drafted, not filed.
- [x] Edge: Drew sent 2 USDC to the edge's Solana address; `POST /peers {"id":"hel1",...,"deposit":2000000}`
  opened channel `FEFVKrn2jAUTzQM37jJTYLcLsbSLC3CeUxpUPDc28GLW` (edge USDC 3.1 to 1.1 on chain); routes for
  `g.toon.7aa291d275b05d07` (0) and its charter-open (1000), charter-status (100), charter-tick (7000).
- [x] Host: `install-home.sh` with `ANON_BIN` (charter-home-fw, charter-home-net, charter-anon, the socks
  drop-in), images built on hel1 (fetch 3.53 GB, hermes 2.05 GB, home 830 MB, python 288 MB), charter-host
  with offer `hel1-1` (4 homes in 6 leases, `CHARTER_HOME_PUBLIC_HOST=37.27.86.235`, onion off, runsc),
  `toon add` charter-open/tick/status at 1000/7000/100, home watch timer with Telegram alerts.
- [x] Paid status read from the toon VM (route `g.toon.7aa291d275b05d07 -> drew` added there): `fulfilled`,
  `404 not_found`, 2.3 s. The VM's CLI hid the first failure (`e.code?.startsWith is not a function`):
  fixed on main (`08ca77c`).
- [x] Proof home, 23:45Z: lease `0ac00731774572ef61eb64181fec57c0` (throwaway key on the Mac), tick 0 paid,
  the CLI printed `ssh -p 22000 tenant@37.27.86.235`. From the Mac: logged in as tenant (2.0G disk, 2 CPUs,
  1 GiB); egress through the proxies 200; direct egress, hel1's own :22, another home's port, the job relay
  172.17.0.1:9150 and a raw socket to 1.1.1.1:443 all refused; DNS via 172.19.0.1.
- [x] `systemctl --user restart charter-host`: the home kept running, still reachable.
- [x] Fetch job `9329a37d` returned example.com through charter-anon (21.6 s, 8300 units).
- [x] Job egress (ruling R12): only job containers use docker0 on hel1, so `charter-job-egress.service`
  (`2133457`) drops everything forwarded from docker0 except DNS. Dropping DNS too emptied every fetch (the job
  resolves names itself, through the host's resolvers 185.12.64.1/2): follow-up to send job DNS through
  charter-anon. Fetch `a845e9f3` with the rule: done, 917 chars.
- [x] Second paid hour: paidIntervals 2, paid through 01:45:07Z.
- [x] Reboot with the home running, 00:20:15Z: back at 00:20:26; charter-home-fw, charter-job-egress, docker,
  charter-home-net, charter-anon active; DOCKER-USER held every rule; the home re-created (`restarts 1`),
  caddy and the node up; charter-host's first offer publish failed while the node booted and succeeded a
  minute later. From the Mac: logged in again and every isolation check held.

## 18. Open hosts on Base: the cut-over off TOON (2026-11-23/24)

Charter stopped using TOON. Renters pay the door over x402 on Base as before; the door now pays every host over the host's own x402 `batch-settlement` channel on Base, and anyone can register a host (design: `docs/superpowers/specs/2026-11-23-open-hosts-on-base-design.md`).

- Code: `main` fast-forwarded to `10b3901` (40 commits) and pushed; door, grant fund and hel1 deployed from it.
- Door wallet (renters' `payTo`, pays hosts): `0xb3fF4E7358c5D3286F6f26cbcc38f08CB9dF8c7d`, key `/root/charter-door/secrets/door-payer.key` (0400). Funded 12.1 USDC and 0.0005 ETH on Base. Daily sweep above 15 USDC to `0xbD87E8Ff0691f0A924e5ce2A06821db818B62385`.
- Backups: `/opt/charter.bak-20261123-preopenhosts`, `door.env.bak-20261123-preopenhosts`, `/root/charter-door-data-20261123-preopenhosts.tgz`; on hel1 `env.bak-20261123-preopenhosts`, `Caddyfile.bak-20261123-preopenhosts`, `/root/charter-src-20261123-preopenhosts.tgz`, images tagged `:pre-20261123`.
- hel1: host id `b6cbc290b3e6f6b57f4c5a94a27014b56a3fe5c4802b47a6c3761655ba8717b3`, `https://37-27-86-235.sslip.io`, paid to `0x6c7035197c2F39de03389b264c0bD3b919336f06`, claim authorizer `0x356C26f9C2fD5a853E49bcaAeacd9C28c365252b`. Registered itself; first probe passed through door channel `0xd56eea45b16aeeb816421458e27758dbfbea848fbba7044f6550ae046b97d564` (0.10 USDC deposit).
- Paid proof and hel1's record, five rents from the bazaar key `0xb66E…c715`, each one tick (7000) and job exit 0:
  - `24b199dd2bb3b4fa44d52a2ab6ababed` tx `0x0d2f8dae11e8fc2d3d0f7423f17418025527324566e33206ec0d1077629a2f62`
  - `576c74f421b25390e35d294cf21ce704` tx `0x41814bb0755372632046e433d4c9c176fe22a3e5a20b8413b9a4ad100dcb3875`
  - `8848816aa36f989368ade0e245a8876f` tx `0xafa63543093e74aa70b1413dd611a2962ccff22594f94bd3d76115198fe52207`
  - `62a679bef84ca090d158028b136cee17` tx `0x5cd0fecd242bd695abced13db015f5a2e26495b7c653830411d243d1022dc3e4`
  - `54f95a1487f1bebda9332334082f890d` tx `0x3fd8649d3ac5cf6844fed9c6fd287686fbc1567107a1e5b73c07a496bd4ace9b`
  hel1 record after: `leasesFinished 5`, `successRate 1`, `new false`; channel charged 42000 (probe + five ticks), zero losses.
- TOON retired for Charter: channels `FEFVKrn2…GLW` (edge to hel1), `DaZN3vmu…5hdr` (hel1 to edge) and `5akKFS2L…M2Wm` (old door to edge, close tx `36dMeknX3SvtuWVdwDiiq9Mx3tP83HcYoJPBKwZhb67RwcPTiCKG9JRYF1yoqM6DsLccNuRip7fc9x3KGw2HLWZR`) closed, accounts gone on chain; nothing was owed on any. hel1's routes and peering removed from the edge; hel1's TOON node stopped and disabled; `/ilp` dropped from hel1's Caddy. `~/.toon` on hel1 kept (its EVM key is hel1's payout address).
- Not republished: the Arweave landing page (charter.ar.io stays at v8; the site moves to a regular website later).

## 19. Charter on its own domain: charterhome.dev (2026-11-24)

Charter left Jonathan's DNS zone and its Arweave landing page. Spec
`docs/superpowers/specs/2026-11-24-charterhome-domain-design.md`, plan
`docs/superpowers/plans/2026-11-24-charterhome-domain.md`.

- Domain `charterhome.dev` bought at Porkbun (Drew's account), registered 14:36Z, expires 2027-11-24.
  DNS: A and AAAA for the apex and `rent`, to 167.233.221.236 and 2a01:4f8:c015:382f::1 (Porkbun's two
  parking records were edited into the A records).
- Caddy: the apex serves the landing page at `/` (rewritten to the door's `/home`) and the door on every
  other path; `rent.charterhome.dev` is the browser storefront; `charter.mainnet.toonprotocol.dev` and the
  sslip name stay as aliases. Backup `/opt/toon-relay/deploy/Caddyfile.bak-20261124-precharterhome`.
- Door redeployed (backup `/opt/charter.bak-20261124-precharterhome`): `https://charterhome.dev/` renders
  the landing page with its fonts and no console error; `POST /v1/rent` answers 402 naming
  `resource.url = https://charterhome.dev/v1/rent`; `/llms.txt` names only the new address.
- Fund rebuilt: its default door is now `https://charterhome.dev`; `/v1/grants` shows the fund open, 19 left.
- hel1: `CHARTER_DOOR_URL=https://charterhome.dev` (backup `~/.config/charter/env.bak-20261124-precharterhome`),
  restarted with no lease booting or running; it logs `door https://charterhome.dev` and is listed again.
- `charter.ar.io` moved notice uploaded free through Turbo: txid
  `EKxsZP-wQZ8p0VJxRO37ParEW-tHm-oXu8Q_9CdvOPg` (1101 bytes, sha256 e172e9f8...c008).

## 20. Referrals (2026-11-25)

Built on branch `feat/referral-payouts`, not deployed. The share stays off (`CHARTER_REFERRAL_BPS` 0) until the
operator sets it on the live door, so nothing below applies to a door until then. Spec
`docs/superpowers/specs/2026-11-25-referral-payouts-design.md`, operator runbook in `docs/ops.md`.

For an agent: a rent request can name a referral address, and that address earns a share of every hour the renter
pays for. The renter pays the same price.

- [ ] Read the rate: `curl https://charterhome.dev/v1/door`. A door that pays referrals answers
  `referral: { bps, how }` (`bps` 1000 is 10%). No `referral` key means none is paid.
- [ ] Read the offers. Only an offer that carries `referralShare` (micro-USDC an hour) earns it.
- [ ] Rent with the field: `POST /v1/rent` with `"referral": "0x..."` (a `0x` address on Base; a mixed-case one
  must match its checksum). The `charter-mcp` tools take `referral` too (its shell commands and the `charter` CLI do not). The answer's `referral` is the address expected to earn, as known when the lease opened.
- [ ] Bad values: a malformed address, the zero address, the door's own address or the grant fund's answers
  `400 bad_referral` before any payment, on the unpaid challenge too.
- [ ] Check: `GET /v1/referrals/<address>`, free and public. It answers `bps`, `hours`, `earned`, `paid`, `owed`
  (micro-USDC strings), `held` and `payouts` (`amount`, `tx`, `at`). An unseen address answers zeros.
- [ ] When it is paid: once a day the door sends one USDC transfer on Base to each address owed at least 0.10 USDC
  (100000), up to 5 USDC a day in all by default; an address that does not fit gets part and the rest the next
  day, if that part is at least 0.10 USDC; otherwise it waits whole for the next day. Read the `tx` in `payouts` on a Base explorer.

Rules an agent should know:

- A renter may name its own address. That is the discount.
- A home's referrer is set at the home's first paid hour, from the lease that opened it, and no request can change
  it later. A home with a paid hour and no referrer cannot gain one: open a new home, or rent a job.
- If two leases of one new home open at once naming different addresses, the first one paid is bound.
- Hours paid by the grant fund earn nothing.
- A referral never changes whether a rent or a tick succeeds.

Not yet done: the live rate and host list (`CHARTER_REFERRAL_BPS` 1000, `CHARTER_REFERRAL_HOSTS`), the deploy, and
the first real payout. Each needs Drew.

## 21. Monthly allowance: period reset and person-side cancel (2026-11-24/25)

Both were run on Base mainnet in the throwaway spike, with a test Base Account
(`0xCAa32aC8bD59741Fd6Aab2432Cc4802fd0DCa334`) and a test spender, before the allowance was switched on.

Period reset (permission `0xd3468891…7104`, 0.05 USDC per day):

- 2026-11-24: the full 0.05 was pulled (`0xa0a28a60…` approveWithSignature, `0xf5143a26…` spend), and the contract
  refused one more tick that day (revert `0xfd1ebc88`).
- The next period began 2026-11-25 21:13:53Z. A pull of 0.007 after it went through:
  `0x9bdbe86bd085faf2e97fe9735b03ac3b1a4ae50cd4828676f5a55cbd29848fbb`, 92,678 gas, and the permission then read
  0.043 remaining.

Person-side cancel (`requestRevoke` from the Base Account, same permission):

- Call id `0x1c2321c6baac9917ca0ae64013adbcbc4361810fade9a7fa8296b06443305253…2105`.
- After it the permission read `isRevoked: true`, `isActive: false`, and the contract refused a 0.007 spend
  (`eth_call`, revert `0x282b9f97`, the same revert a spender-side revoke gives).
- So the approval page now shows its cancel button (`CANCEL_TESTED = true` in `web/allow.ts`).

## 22. Monthly allowance, end to end on the live door (2026-11-25)

The allowance was switched on at the door (`CHARTER_ALLOW_ADDRESS` = the biller, `0x17f27F11d7d491EaBbe99AdadBe8268F236268a4`)
and run once from start to finish with a test home and Drew's test Base Account (`0xCAa32aC8bD59741Fd6Aab2432Cc4802fd0DCa334`).

- The home: a `charter-home` on hel1 opened with throwaway keys, first hour paid by the test payer `0xb66E…c715`
  through `charter rent` (it answered `ssh -p 22005 tenant@37.27.86.235`).
- The link: `POST /v1/allowances` with the home's keys answered 201, state `waiting`, allowance
  `d1d4571c167aa73a1e9441aa276f1c09`.
- The approval: Drew connected the Base Account on `https://charterhome.dev/allow?id=…` and signed for 5.208 USDC per
  30 days (744 hours). State `active`. Nothing moved at signing.
- The pull, when the home's next hour came due: 0.168 USDC (24 hours) from the account to the biller,
  `0x358d88dd7d0247056610f4d9aa922897615dc55bb3533a35baad6731f5aade75` (126,885 gas, approval and spend in one
  transaction). The allowance then read 5.04 remaining.
- The hour: the biller paid one tick, 0.007 USDC, through the door's normal paid route,
  `0x2240bfa3161883d68acba63786229f78fc0517f61b69bcf5bdf59aff0c4bbeec`. `hoursPaid` 1, credit 0.161.
- The stop, by the agent's owner token (`POST /v1/allowances/<id>/stop`, header `x-allowance-token`): state
  `stopping`, then within two cycles:
  - revoke `0xd9a7821c92a1b3e1b85d0244e62dd44b4f86203f5eeb12d4023ff73658464583`,
  - refund of exactly the credit, 0.161 USDC back to the account,
    `0xbfbc95976e00fbf3c0dbdb1c00ceb854f4c68b02593a06687c895f0bd4694e52`,
  - state `ended`, reason `stopped`. The account went 1.061778, 0.893778, 1.054778 USDC.

Only one biller-paid hour was watched (the plan asked for two); the second would have needed another hour's wait.
One fault was found on the way and fixed: the web server's general Content-Security-Policy overwrote the approval
page's wider one (`deploy/door/Caddy.snippet`, the `@notallow` matcher).

## 23. Receipts, and a pin a home paid for itself (2026-11-26)

The door was deployed with receipts (`caf5110`), both home images on hel1 were rebuilt with the new
`charter-x402` subcommands, and each kind of receipt was taken once on the live door. Charter stored and
served none of the content: it signed two hashes.

**A job receipt.** `GET /v1/leases/<id>/receipt` on a finished fetch job from 11-24 (lease `e2a0c0e5…`, paid
by the test payer `0xb66E…c715`), whose output the door already held:

- `kind: "job"`, `sha256` `9e82b465ff4705f05a4a25b729f72e70c2f764c2d6b9527b1a068f4ef4de0f5b`, `bytes` 187,
  `ticksPaid` 1 at 3600 s, host `b6cbc290…` (hel1). No `image`: the lease was opened before the ledger kept it.
- Checked offline: the signature recovers to `0xb3fF4E7358c5D3286F6f26cbcc38f08CB9dF8c7d`, which
  `GET /v1/door` names as `receiptSigner`; the hash and size match what `GET …/output/0` serves; `leaseRef` is
  the SHA-256 of `charter-lease:<id>`; the lease id is nowhere in the answer.

**A declared receipt with a pin.** A `charter-home` on hel1 (lease `82b03b96…`, home `72da8cb1bc5b31ff`),
opened from the Mac with `charter-x402 open` and paid by the test wallet `0x46FC…F93E`
(`0x03b5949112eae70a365e9372f902f4d42efa631bb935d1a2e06a233ea729c6b1`). In the home:

- `charter-x402 address` made the home's own wallet, `0x83f2831d269b782b677Ca8F1F9E9766d277F5e86`. Drew sent
  it 0.011 USDC (`0xb8b3f959a0f6aede7cc7659165a66ae0227d782c1ada11a1245d7bb22277f045`).
- `charter-x402 pin proof.txt` on a 116-byte file: the home's wallet paid Pinata 0.001 USDC, to
  `0xc900f41481B4F7C612AF9Ce3B1d16A7A1B6bd96E`
  (`0x31c63d70ec03dd1d8bf7bc2035fd903eea9cbda305e77b54db01608dd57deaf9`). The wallet then held 0.01.
- The CID: `bafkreibsfpqbevfkvsijp4ttyantttivko43u77vlnu653ju6zmm3m4vci`. Pinata's gateway served the file and
  its SHA-256 matched. `ipfs.io` and `dweb.link` answered 429 at the time, so a read from a gateway Pinata
  does not run was not seen.
- The receipt, saved in the home at `~/.charter/receipts/<sha256>.json`: `kind: "declared"`, `image`
  `charter-home`, `sha256` `322be01254aaac9097f273c01b39cd1553b9ba7ff55b69eeed34f658cdb39512`, `bytes` 116,
  `payer` the wallet that paid the hour, and `cid`
  `f01551220322be01254aaac9097f273c01b39cd1553b9ba7ff55b69eeed34f658cdb39512`: the same CID in base16, the
  form the door signs. Signed at 14:49:16Z. Checked offline the same way: signature, signer and `leaseRef` hold.

**The listing.** `setAgentURI` was sent again with the same address so directories re-read the registration
file (`0x6dc9aace317ec7094c014a2b57d2f6259f1fa1f33cdb7cce7db75043df9e5f02`, block 62564082, about 0.00000025
ETH). 8004scan parsed it again within a minute.

Not shown here: a job receipt that had to fetch parts from the host (this one came from the door's own copy),
the 60-an-hour limit on a live lease, and `charter_receipt` called through the remote MCP endpoint against a
real lease (it is listed there, and tested).
