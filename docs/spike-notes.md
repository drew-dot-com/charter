# Task 1 spike notes: the TOON mainnet path and the `toon` CLI facts

Run 2026-10-16 (about 21:50 to 22:00 UTC) over `ssh air`, Lima VMs `toon` (Edison's node) and
`toon2`. Mainnet only. Later tasks read their `toon` flags and JSON shapes from this file.

## Outcome in one paragraph

Both VMs now run `toon 0.3.0`. The paid packet from Edison's node to an app on `toon2` was
**not sent**: the path is blocked twice before any money would move. (1) `toon2` cannot start:
its Solana settlement key holds 0.11 USDC and `toon up` needs 1 whole token per settlement key.
(2) Drew's edge has **no route to `toon2`**: a free zero-amount probe from Edison toward
`g.toon.69b2a212547e7a9c.charter-echo` left over the `drew` peering and the edge answered
`F02 no route to destination`. A peering is one way, so for the edge to deliver to `toon2` the
edge must peer toward `toon2` (an edge-funded channel plus a route). Both fixes move money and
were out of this task's authority. **Total spent: 0.** Steps 3 and 4 (the paid echo and the
503 test) are not done live; the 5xx answer below is read from the connector source.

## Versions

| VM | before | after |
| --- | --- | --- |
| `toon` | `toon 0.1.1 (connector 81cfe8e60ac787fb5e1c790341dc4328a0372297, relay ghcr.io/toon-protocol/relay:rust-sha-1b02f2e@sha256:3eea8d9421892a3f9617ce268db8df7432484221de08f7a217494ac0540d1059)` | `toon 0.3.0 (connector 18da529a442f1740ddf0fce4c132c3f8bcc7c8e8, relay ghcr.io/toon-protocol/relay:rust-sha-1b02f2e@sha256:3eea8d9421892a3f9617ce268db8df7432484221de08f7a217494ac0540d1059)` |
| `toon2` | same 0.1.1 string | same 0.3.0 string |

Installed with `TOON_VERSION=v0.3.0 sh install.sh`, the script taken from the `v0.3.0` tag
(sha256 `593829d9dc9acd3ab001fa1e0f664d7c3ba3a78dde91316528eadf3409d60b72`).

Backups, in each VM home, mode 600: `toon` `~/agent-node-bak-20261016-215543-pre0.3.0.tgz`,
`toon2` `~/agent-node-bak-20261016-215200-pre0.3.0.tgz`. Old binaries kept as
`~/.local/bin/toon-0.1.1`. Pre-upgrade `status --json` (and on `toon` the route and peer lists)
are in `~/status-pre-0.3.0.json`, `~/routes-pre-0.3.0.json`, `~/peers-pre-0.3.0.json`.

## The two nodes

| | `toon` (Edison) | `toon2` |
| --- | --- | --- |
| ILP address | `g.toon.c50e6a019916b7cb` | `g.toon.69b2a212547e7a9c` |
| reach | hidden | hidden |
| onion endpoint | `http://u72ggcqupz3elxa4at24wgeozfonmghaoivwecqfkpu4so3ffasz3yid.anyone/ilp` | `http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp` |
| connector identity (x) | `c50e6a019916b7cb...` | `69b2a212547e7a9c089e06cececdc52eb468209a5735cf98a3eb68ed281287e5` |
| seal key (`GET <connector>/ilp/identity` `publicKey`) | `0x04c50e6a019916b7cbcbf6427cf5034923b65058b3f38e7a4990cfe64455eab05d89187d512d5b9ca127c68c18d44cd0b3aa3da5747066ca97c53c3688ada36a7d` | not read: the node did not start. It is `0x04` + the identity x above + y; read it from `/ilp/identity` once running |
| peering to the edge | `drew`, made by hand | `mainnet`, made by `toon join mainnet` |
| channel to the edge | Solana, `121CYE4waJ1777GJE8QTnn82Sr29m1saPf175N75wRFv`, outbound, collateral 982000, watermark 18000, landed 18000 | Solana, `8oBnwH4uFQNuuGH5tRKB36jCQ86MFgyvJwNfYpAPoJg5`, outbound, last voucher 1000 (its channel log) |
| inbound channel from the edge | none | none |
| routes to the edge | `g.drew -> drew` | `g.drew -> mainnet`, `g.toon -> mainnet` |
| EVM / Solana settlement address | `0x54930f9f7461c3EFC1c194eb02A909CAEb818172` / `FDyzvH4kPUUtodV5QwSqnDU3RKnBg5psYrJuEjS12NEz` | `0x9C467fAcF00D497dE27F281b2c1a202De618e809` / `J6UrAZpsnCJREvdp4V4JojfNP5TgCsv5Qkq6oURGo1mM` |

`toon2` on-chain balances read 2026-10-16: Solana 0.11 USDC and 0.021 SOL; Base 1.12 USDC and
about 0.0021 ETH. The seal key is the 65-byte uncompressed point whose x is the connector
identity, and the segment in the ILP address is the first 16 hex of that x.

Drew's edge (`GET https://connector.mainnet.toonprotocol.dev/ilp`): seal key
`0x0431e6a28e18132159d95efdbb0a3f5d65a4bf9228377fd80021fe88a7cc49bd85116899233e79287d48dc67bfa943164ed52f2d9e29301feb18ebc6fd4471b087`,
settles on Base (`eip155:8453`) and Solana; its 21 published routes are all `g.drew.*`, none `g.toon.*`.

## App address format and price

```sh
toon add charter-echo --to relay --url http://127.0.0.1:7499/ --price 100 --yes --json
# {"added":"charter-echo","address":"g.toon.69b2a212547e7a9c.charter-echo","price":100,"restarted":false,"toon_app":"relay"}
```

- App address = `<node ILP address>.<app name>`, so Charter's apps are `${ilpBase}.charter-open`,
  `.charter-tick`, `.charter-status` with `ilpBase` = the node ILP address.
- `--to <toon app>` is **required** (`toon add --help`: `Usage: toon add [OPTIONS] --to <TO> <APP>`);
  the default TOON app is named `relay`. The brief's command lacks it.
- `--price 100` is accepted (the default is 0). **The minimum price is 0**; there is no floor.
- `toon add` on a stopped node needs no `--yes`, but `toon remove` asks for `--yes`
  (`confirmation_required`) even when the node is stopped.
- The connector config gets `handler_url = "http://127.0.0.1:7499/"`, `price = 100`.

## `toon send`

```
toon send [--json] [--seal-to <URL>] [--method <M>] [--path <P>] [--body <FILE>] --amount <N> --yes <ADDRESS>
```

- `--amount` is required. `--method` defaults to `POST`, `--path` to `/`.
- `--body` is a **file path**, sent as `application/json`. It is not inline JSON: write the
  body to a temp file first.
- `--seal-to` takes the terminating connector's **`/ilp` URL**, not a key. The CLI GETs
  `<url>/identity` and seals to its 65-byte `publicKey`. On a hidden node the onion URL is
  reached through the overlay. Needed whenever the app is behind a connector that is not yours.
- `--path /echo` reaches the handler as `echo` relative to `handler_url`
  (`http://127.0.0.1:7499/echo`). **ToonClient callers:** connector 18da529a refuses with
  `F00` any envelope target that starts with `/` unless it is literally the handler's own path,
  so send relative targets (`echo`, `status`) when building envelopes directly.
- The passphrase comes from `TOON_PASSPHRASE_FILE` in env.

JSON shapes (from toon 0.3.0 source `src/operator.rs` and `src/main.rs`; the reject shape also seen live):

```json
{"destination":"g.toon.X.app","amount":100,"outcome":"fulfilled","response":{"status":200,"body":"<app body as a string>"},"paid":100}
{"destination":"g.toon.X.app","amount":100,"outcome":"rejected","reject":{"code":"F02","message":"..."},"paid":0}
{"destination":"g.toon.X.app","amount":100,"outcome":"wrong_fulfilment","paid":<moved>}
{"error":{"code":"spending_limit","message":"..."}}
```

- `response.body` is the app's body as a **string** (UTF-8 lossy), not parsed JSON.
- `paid` = `amount` when fulfilled; otherwise what the outbound channels moved (0 when your own
  connector refused). Exit 0 fulfilled, 1 rejected or failed.
- Live probe (zero amount, free), exit 1:
  `{"amount":0,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"rejected","paid":0,"reject":{"code":"F02","message":"no route to destination 'g.toon.69b2a212547e7a9c.charter-echo'"}}`
  and `toon packet history` showed it `sent` `to: drew`, so the F02 came from the edge.

`toon probe` takes the same flags with `--amount` optional (default 0, pays nothing, no `--yes`).

## A 5xx answer: fulfilled and paid

Not tested live (no path). From connector 18da529a `crates/connector-runtime/src/app_client.rs`
and `connector.rs`: any HTTP status the app answers with, 503 included, is
`AppOutcome::Answered` and rides home on a **FULFILL**, so the payer pays. Only an app that
cannot be reached (connection refused, timeout) is a **reject `T01`** with `accumulated_cost`
0, and a target escaping the handler is `F00`. For Charter: to refuse a tick without being paid,
the app must not answer at all; a 5xx does not refund.

## `toon event publish`

```
toon event publish --kind <K> [--content <S>] [--tags '<JSON array of arrays of strings>'] [--relay <ws(s)://...>] [--amount <N>] --yes --json
```

- Without `--relay` it writes to the node's own relay (amount defaults to 0). With `--relay` the
  amount defaults to that relay's NIP-11 price; below it is refused.
- `toon event sign` takes `--kind --content --tags` and prints the signed event, paying nothing.

JSON shape (source `src/event.rs`):

```json
{"outcome":"published","event":{"id":"...","pubkey":"...","created_at":0,"kind":31390,"tags":[["L","charter"]],"content":"...","sig":"..."},"response":{"status":200,"body":"..."},"relay":"wss://...","paid":1000}
```

Other outcomes: `"refused"` (the relay answered non-2xx, exit 1, still paid) and `"rejected"`
with `reject.code`. The event id is `event.id`.

## `toon channel list --json`

Live, on Edison's node:

```json
{"channels":[{"chain":"solana","collateral":982000,"counterparty":"4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1","direction":"outbound","id":"121CYE4waJ1777GJE8QTnn82Sr29m1saPf175N75wRFv","landed":18000,"scheme":"batch-settlement","status":"open","watermark":18000}]}
```

`chain` is `solana` or `evm`; `direction` is `inbound` or `outbound`.

## `toon channel land <id> --json`

Not run (no inbound channel exists on either node). Shape from source (`land_report`):

```json
{"channel":{"id":"...","chain":"evm","direction":"inbound","status":"open"},"transactions":[{"chain":"evm","network":"mainnet","hash":"0x..."}]}
```

Each transaction is `{chain, network, hash}`: map `hash` to Charter's `tx`. `transactions` is
`[]` when the connector does not report it. It needs gas on the settlement key (`unfunded` otherwise).

## Anyone SOCKS proxy

The node's `anon` daemon serves SOCKS at `socks5h://127.0.0.1:<port>` (Edison's today:
`127.0.0.1:62258`, from `~/.toon/agent-node/overlay/anonrc` `SocksPort`, also in the connector
config as `socks_proxy`). The port is **chosen anew at each `toon up`** (it was 64425 on 10-05),
and it binds **loopback only**. A container on the default Docker bridge (`docker0` is
`172.17.0.1`, `host.docker.internal:host-gateway`) **cannot reach it**. Answer for Task 5/11:
**none reachable from a bridge container as the node ships**. Reaching it needs a forwarder on
`docker0` (for example `socat` from `172.17.0.1:<fixed port>` to the loopback port, re-read
after every `toon up`) or `--network host`.

## Side effects and findings

- Edison's node after the upgrade: peering `drew` and route `g.drew` survived; `toon-bridge
  status` works. The relay now runs confined as `501:1000` (new since 0.2.0) and could not write
  its `events.db`, owned by uid 1000 from the old image, so the paid feed failed with
  `the own relay refused event ... (status 500)`. Fixed with
  `sudo chown 501:1000 ~/.toon/agent-node/apps/relay/data/events.db` and `toon down; toon up`;
  the feed is live again. `toon2`'s `events.db` is also `1000:1000` and needs the same chown
  before its first start on 0.3.0.
- `toon2` was stopped before the spike and is stopped again; its unit is inactive.
  `charter-echo` was removed and the echo server killed.
- Spend: one zero-amount probe, `paid` 0. Edison's watermark stayed 18000. **Total 0.**

## What unblocks Steps 3 and 4 (each moves money, so it is Drew's call)

1. Fund `toon2`'s Solana key `J6UrAZpsnCJREvdp4V4JojfNP5TgCsv5Qkq6oURGo1mM` to at least 1 USDC
   (it holds 0.11), so `toon up` starts it.
2. Give the edge a way to deliver to `toon2`: the edge peers toward `toon2` (an edge-funded
   channel, Solana `minDeposit` 1000000) and routes `g.toon.69b2a212547e7a9c` to it. This is also
   the first test of the edge dialing an onion (`.anyone`) node. Alternative: Edison's node peers
   straight to `toon2` with a deposit, which proves the CLI path but not the edge path Charter's
   door uses.
3. Then Edison adds `toon route add g.toon.69b2a212547e7a9c --peer drew` and runs
   `toon send g.toon.69b2a212547e7a9c.charter-echo --amount 100 --seal-to http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp --method POST --path /echo --body body.json --yes --json`.
