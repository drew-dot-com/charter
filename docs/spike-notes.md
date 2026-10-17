# Task 1 spike notes: the TOON mainnet path and the `toon` CLI facts

Run 2026-10-16, 21:50 to 23:45 UTC, over `ssh air` (Lima VMs `toon` = Edison's node and `toon2`)
and the Hetzner box (Drew's edge). Mainnet only. Later tasks read their `toon` flags and JSON
shapes from this file. Shapes marked **live** were seen on mainnet. Shapes marked **source** were
read from toon 0.3.0 or connector code.

## Outcome

A paid packet went from Edison's node, through Drew's edge, to an app on `toon2`, which is a
hidden (onion) home node. It was fulfilled, `paid` 100, and the echo body came back. A 503
answer is fulfilled and paid. An unreachable app is rejected `T01`. Getting there took three changes:

1. Drew funded `toon2` (1.02 USDC on Solana).
2. The edge got its own Anyone SOCKS proxy.
3. The edge peered toward `toon2`'s onion `/ilp` with a 1 USDC Solana channel, plus a route.

The payer's channel moved 1200 micro-USDC in total (two echo packets plus one relay write).
The edge paid `toon2` 400 on its new channel. All of it is Drew's money on both sides.

## How a home (hidden) host is reached

```
payer (Edison, hidden)  --peering "drew"-->  edge (connector.mainnet.toonprotocol.dev)
                                             --peering "toon2" over Anyone (edge-anon SOCKS)-->
                                             toon2 connector (http://ev2ocvzg...anyone/ilp) --> app on 127.0.0.1
```

- The payer needs a route for the host's prefix over its peering to the edge
  (`toon route add g.toon.69b2a212547e7a9c --peer drew`). It also needs `--seal-to` = the host's
  onion `/ilp` URL. Edison's hidden node fetched `<onion>/ilp/identity` through its own overlay
  without trouble. A door that seals by key (ToonClient `sealTo`) needs no fetch.
- The edge needs a peering it opened itself toward the host's URL, plus a route for the host's
  prefix to that peering. **An inbound session from the host is not enough**: a peer BTP session
  that dials in "binds nothing" (`connector-peer-btp/src/accept.rs`). The client session registry
  binds only a client session that declares `peerId`, with an exact destination match. So
  `toon2`'s own outbound peering to the edge did not make it reachable.
- Edge ops, both signed operator writes with `/opt/refuel/deploy/sign-write.sh -k /root/keys-refuel/operator-write.key -u http://<edge container ip>:4000`:
  - `POST /peers {"id":"toon2","url":"http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp","fee":0,"max_packet_amount":1000000,"deposit":1000000,"chain":"solana"}`
    answered `{"id":"toon2",...,"channel":{"id":"E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn","status":"created","chain":"solana"}}`.
  - `POST /routes/peers {"prefix":"g.toon.69b2a212547e7a9c","peer_id":"toon2","price":0}`.
  - Edge `GET /ilp` now publishes 22 routes (21 before, plus `g.toon.69b2a212547e7a9c`).
- Deposit tx (verified on chain, finalized, no error):
  `571kFfyzRAdMMGKL6jz6kVnw95jHc8WSjf2YRN2HzQXToVyDQEJQ4SiwJ7A8h6NWG7ieHV1nbtGbZbiEWdGxbsb`.
  - Program `CHNLxYvV...`, signers `J6Ur...` (toon2, fee payer and sponsor) and `4s2J...` (edge).
  - Edge USDC went 5000000 to 4000000, and the channel vault holds 1000000.
- The edge pays the host for each delivered packet with a voucher on that channel. The host lands
  it with `toon channel land`.

## The edge's Anyone SOCKS proxy (`edge-anon`)

- Container `edge-anon`, its own compose project `/opt/toon-relay/edge-anon/` on
  `relay_deploy_net`, nothing host-published, `restart: unless-stopped`.
- It reuses the Debian runtime of `anonfetch:local`, re-tagged `edge-anon:local`.
- It runs **anon 0.4.10.2**, the release toon pins. It was downloaded from
  `anyone-protocol/ator-protocol` v0.4.10.2 `anon-live-linux-amd64.zip`, sha256 `9c6498b8...eb17`
  (the checksum is in toon_cli `src/anon.rs`), and mounted at `/opt/anon`.
  **anon 0.4.9.11 (what `anonfetch` bundles) cannot reach `.anyone` addresses**: the SOCKS
  connect failed with "host unreachable" and the log said "tried resolving ... at 3 different places".
- The `anonrc` has:
  - `AgreeToTerms 1`
  - `SocksPort 0.0.0.0:9050`
  - `SocksPolicy accept 127.0.0.1`, `SocksPolicy accept 172.18.0.0/16`, `SocksPolicy reject *`
  - `ORPort 0`, `ControlPort 0`
  - data in volume `edge-anon_edge-anon-data`
- It bootstraps to 100% in about 2 s. Its healthcheck is a TCP connect on 9050.
- Edge TOML (`/opt/toon-relay/deploy/rust/config/connector-rust.toml`) gained one line after
  `peer_expose`: `socks_proxy = "socks5h://edge-anon:9050"`. Backup:
  `connector-rust.toml.bak-20261016-presocks`; staged copy: `connector-rust.toml.staged-socks`.
  - Only `.onion`/`.anyone` dials use the proxy. Settlement RPC stays direct (no `rpc_via_socks_proxy`).
  - The edge was restarted once (`docker restart deploy-connector-rust-1`, 23:32 UTC, about 13 s).
- Before and after the restart: 21 routes, peer `drew-store` kept, relay NIP-11 answered, Lading
  containers healthy. Edison's zero-amount probes still got `F06` cost quotes (`g.drew.relay`
  1000, `g.drew.ario` 1030). Lading canary #758 (23:24 UTC, before) and #759 (00:24 UTC, after) were both ok, paid 3090.

## Versions

| VM | before | after |
| --- | --- | --- |
| `toon` | `toon 0.1.1 (connector 81cfe8e60ac787fb5e1c790341dc4328a0372297, relay ghcr.io/toon-protocol/relay:rust-sha-1b02f2e@sha256:3eea8d9421892a3f9617ce268db8df7432484221de08f7a217494ac0540d1059)` | `toon 0.3.0 (connector 18da529a442f1740ddf0fce4c132c3f8bcc7c8e8, relay ghcr.io/toon-protocol/relay:rust-sha-1b02f2e@sha256:3eea8d9421892a3f9617ce268db8df7432484221de08f7a217494ac0540d1059)` |
| `toon2` | same 0.1.1 string | same 0.3.0 string |
| edge | `ghcr.io/toon-protocol/connector:rust-2026.09.29.1` | unchanged (config only) |

- Installed with `TOON_VERSION=v0.3.0 sh install.sh`, using the script from the `v0.3.0` tag
  (sha256 `593829d9dc9acd3ab001fa1e0f664d7c3ba3a78dde91316528eadf3409d60b72`).
- Backups, mode 600: `toon` `~/agent-node-bak-20261016-215543-pre0.3.0.tgz`, `toon2`
  `~/agent-node-bak-20261016-215200-pre0.3.0.tgz`. Old binaries are kept as `~/.local/bin/toon-0.1.1`.
- **Upgrade trap (0.1.1 to 0.2.0 or later):** the relay app now runs confined as `501:1000`
  and cannot write an `events.db` owned by uid 1000. Fix before or after the first start:
  `sudo chown 501:1000 ~/.toon/agent-node/apps/relay/data/events.db`, then `toon down; toon up`.
  It was applied on both VMs.
- `toon up` refuses to start unless each settlement key holds 1 whole token
  (`A settlement key is not funded ... 1 token`).

## The nodes

| | `toon` (Edison) | `toon2` (host) |
| --- | --- | --- |
| ILP address | `g.toon.c50e6a019916b7cb` | `g.toon.69b2a212547e7a9c` |
| reach | hidden | hidden |
| `/ilp` URL | `http://u72ggcqupz3elxa4at24wgeozfonmghaoivwecqfkpu4so3ffasz3yid.anyone/ilp` | `http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp` |
| seal key (`GET <connector>/ilp/identity` `publicKey`) | `0x04c50e6a019916b7cbcbf6427cf5034923b65058b3f38e7a4990cfe64455eab05d89187d512d5b9ca127c68c18d44cd0b3aa3da5747066ca97c53c3688ada36a7d` | `0x0469b2a212547e7a9c089e06cececdc52eb468209a5735cf98a3eb68ed281287e59c0097dfcb29a8b10cc9aedf22de77d4df1d5b5d5cef3502a8c47329e79e5e1b` |
| peer carriages | `http` | `http` |
| peering to the edge | `drew` (by hand) | `mainnet` (`toon join`) |
| outbound channel to the edge | Solana `121CYE4waJ1777GJE8QTnn82Sr29m1saPf175N75wRFv` | Solana `8oBnwH4uFQNuuGH5tRKB36jCQ86MFgyvJwNfYpAPoJg5` |
| inbound channel from the edge | none | Solana `E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn` (1 USDC, from `4s2J...`) |
| EVM / Solana settlement | `0x54930f9f7461c3EFC1c194eb02A909CAEb818172` / `FDyzvH4kPUUtodV5QwSqnDU3RKnBg5psYrJuEjS12NEz` | `0x9C467fAcF00D497dE27F281b2c1a202De618e809` / `J6UrAZpsnCJREvdp4V4JojfNP5TgCsv5Qkq6oURGo1mM` |

- The seal key is the 65-byte uncompressed point whose x is the connector identity.
- The ILP segment is the first 16 hex of x.
- Each node's Anyone SOCKS port is chosen anew at each `toon up`: Edison 62258 today, `toon2` 61704.
- Drew's edge seal key is `0x0431e6a28e18132159d95efdbb0a3f5d65a4bf9228377fd80021fe88a7cc49bd85116899233e79287d48dc67bfa943164ed52f2d9e29301feb18ebc6fd4471b087`.
  It settles on Base (`eip155:8453`) and Solana.

## App address format and price

```sh
toon add charter-echo --to relay --url http://127.0.0.1:7499/ --price 100 --yes --json
# live: {"added":"charter-echo","address":"g.toon.69b2a212547e7a9c.charter-echo","price":100,"restarted":true,"toon_app":"relay"}
toon remove charter-echo --yes --json
# live: {"address":"g.toon.69b2a212547e7a9c.charter-echo","removed":"charter-echo","restarted":true,"toon_app":"relay"}
```

- The app address is `<node ILP address>.<app name>`. So Charter's apps are `${ilpBase}.charter-open`,
  `.charter-tick` and `.charter-status`, where `ilpBase` = the node ILP address.
- `--to <toon app>` is **required**. The default TOON app is named `relay`.
- `--price 100` is accepted. **The minimum price is 0**; there is no floor.
- `add` and `remove` restart the connector, so both need `--yes` while it runs. `remove` asks for
  `--yes` even when the node is stopped.

## `toon send` (live)

```
toon send [--json] [--seal-to <URL>] [--method <M>] [--path <P>] [--body <FILE>] --amount <N> --yes <ADDRESS>
```

- `--amount` is required. `--method` defaults to `POST`, `--path` to `/`. `TOON_PASSPHRASE_FILE` goes in env.
- `--body` is a **file path**, sent as `application/json`. It is not inline JSON.
- `--seal-to` is the terminating connector's **`/ilp` URL**, not a key. The CLI GETs
  `<url>/identity`. An onion URL works from a hidden node.
- `--path /echo` reaches the handler as `http://127.0.0.1:7499/echo`. The app saw `"path": "/echo"`.
  **ToonClient callers:** connector source refuses with `F00` any envelope target that starts
  with `/` unless it is the handler's own path, so send relative targets (`echo`).

Live outputs (Edison to `toon2`, 23:36 to 23:37 UTC):

```json
{"amount":100,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"fulfilled","paid":100,"response":{"body":"{\"method\": \"POST\", \"path\": \"/echo\", \"body\": \"{\\\"hi\\\":1}\"}","status":200}}
{"amount":100,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"fulfilled","paid":100,"response":{"body":"{\"method\": \"POST\", \"path\": \"/echo\", \"body\": \"{\\\"hi\\\":1}\"}","status":503}}
{"amount":100,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"rejected","paid":100,"reject":{"code":"T01","message":"error sending request for url (http://127.0.0.1:7499/echo): error trying to connect: tcp connect error: Connection refused (os error 111)"}}
{"amount":0,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"rejected","paid":0,"reject":{"code":"F02","message":"no route to destination '...'"}}
```

- `response.body` is the app's body as a **string**. `response.status` is the app's HTTP status.
- Exit 0 when fulfilled, 1 when rejected. A paid send took about 1.8 s end to end (payer, edge, onion
  hop to the host). A probe took about 5 s, including the identity fetch.
- Source-only outcomes: `"wrong_fulfilment"`, and `{"error":{"code":"spending_limit",...}}` for refusals.

`toon probe` takes the same flags with `--amount` optional (default 0, pays nothing, no `--yes`).

## 5xx and unreachable app: what is paid (live)

- **503 is fulfilled and paid.** `paid` 100, payer watermark +100, and `toon2`'s history
  shows `delivered ... fulfilled`. A 5xx is never a refund.
- **Unreachable app (connection refused) is a reject `T01`.** Each side counts it differently:
  - The payer CLI reported `paid: 100`, but the edge rolled its claim back (connector #1012).
    Edison's watermark read 18300 right after, and the next voucher was cumulative 19200 =
    18200 + 1000. So the payer was **not** charged in the end, but `paid` in that one report
    over-counts.
  - The edge still paid `toon2` for it: the edge's outbound voucher is not rolled back
    (connector #1028).
- **A zero-amount probe to a priced app is delivered and the app does the work.** The probe
  carried 0, yet `toon2`'s app answered 200, and the edge still signed `toon2` a +100 voucher.
  The edge pays the next hop's price out of its own pocket.
  - For Charter: a host's apps can be called for free through a forwarding hop, at that hop's
    expense. The host is paid, so Charter's door is not exposed, but any forwarding edge is.
    This is worth filing.
- Edge outbound voucher log for `E63r...`: 100, 200, 300, 400. Those are the probe (0), the 200,
  the 503 and the T01. Edge inbound from Edison: 18000 to 19200 = 100 + 100 + 1000.

## `toon event publish` (live)

```
toon event publish --kind <K> [--content <S>] [--tags '<JSON array of arrays of strings>'] [--relay <ws(s)://...>] [--amount <N>] --yes --json
```

The test was ephemeral kind 21390 to Drew's relay, so it is not stored for readers:

```json
{"event":{"content":"charter spike: output shape test","created_at":1792193886,"id":"702df20abc8f71b7871f9eac8d6e78997cb431caaba62fbaacd1fe045e29d355","kind":21390,"pubkey":"3c75d15ee999ba19e601d7149324136579f306f237b707f1459664ffec7d8190","sig":"d022...","tags":[["L","charter-spike"]]},"outcome":"published","paid":1000,"relay":"wss://relay.mainnet.toonprotocol.dev","response":{"body":"{\"eventId\":\"702df2...\",\"storedAt\":1792193886,\"payment\":{\"payer\":\"solana:121CYE4w...\",\"amount\":\"1000\",\"chain\":\"solana\"}}","status":200}}
```

- The event id is `event.id`.
- Without `--relay` it writes to the node's own relay, and the amount defaults to 0.
- With `--relay`, the amount defaults to the relay's NIP-11 price (Drew's relay: 1000).
- Source-only outcomes: `"refused"` (non-2xx, exit 1, still paid) and `"rejected"`.
- `toon event sign` prints a signed event and pays nothing.

## `toon channel list --json` (live)

```json
{"channels":[{"chain":"solana","collateral":1000000,"counterparty":"4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1","direction":"inbound","id":"E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn","landed":0,"scheme":"batch-settlement","status":"open","watermark":400},{"chain":"solana","collateral":999000,"counterparty":"4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1","direction":"outbound","id":"8oBnwH4uFQNuuGH5tRKB36jCQ86MFgyvJwNfYpAPoJg5","landed":1000,"scheme":"batch-settlement","status":"open","watermark":1000}]}
```

## `toon channel land <id> --json` (live, on `toon2`)

```json
{"channel":{"chain":"solana","collateral":999600,"counterparty":"4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1","direction":"inbound","id":"E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn","landed":400,"scheme":"batch-settlement","status":"open","transaction":"5zCi1WXYRnZadYK1eonrtF6XLerBnPH3q3161ZFoGxEAezsBdRsRNLkBDvpJ9hKoPc8wERc8rv24379wqg6uctw3","watermark":400},"transactions":[{"chain":"solana","hash":"5zCi1WXYRnZadYK1eonrtF6XLerBnPH3q3161ZFoGxEAezsBdRsRNLkBDvpJ9hKoPc8wERc8rv24379wqg6uctw3","network":"mainnet"}]}
```

- Each transaction is `{chain, network, hash}`: map `hash` to Charter's `tx`. The channel also
  carries `transaction`.
- The tx was finalized on chain with no error. It needs gas on the settlement key.

## Anyone SOCKS proxy for host-side containers

- A `toon` node's own `anon` daemon serves `socks5h://127.0.0.1:<port>` on **loopback only**, on
  a port chosen at each `toon up`. A container on the default Docker bridge (`172.17.0.1`)
  **cannot reach it**.
- Answer for Task 5/11: **none reachable from a bridge container as the node ships**.
- To give a host's jobs hidden egress, run a separate `anon` 0.4.10.2 SOCKS container on the
  job network. That is the `edge-anon` pattern above, with `SocksPolicy` limited to that network.

## Spend and money moved

| leg | amount |
| --- | --- |
| Edison to edge (payer channel `121CYE4w...` watermark 18000 to 19200) | 1200 (100 echo + 100 echo-503 + 1000 relay write) |
| CLI `paid` fields summed | 1300 (0, 100, 100, 100, 1000): the T01 `paid: 100` was later rolled back |
| edge to `toon2` (channel `E63r...`, landed) | 400 |
| deposits | toon2's channel to the edge already existed from 10-04 (none new); edge 1 USDC to `toon2`, tx `571kFfyz...` |
| gas | the land tx (toon2 pays), the channel open (toon2 sponsors) |

All packet spend was under the 10000 cap.

## State left behind

- `toon2` is **running**: peered to the edge (`mainnet`) and reachable from it (`toon2`).
  `charter-echo` is removed and the echo server is killed.
- Edison's temporary route `g.toon.69b2a212547e7a9c -> drew` was removed. Its routes are as before (`g.drew`).
- The edge keeps `edge-anon`, `socks_proxy`, peer `toon2`, its channel and route `g.toon.69b2a212547e7a9c`.
