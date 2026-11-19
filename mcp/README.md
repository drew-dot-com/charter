# charter-mcp

An MCP server that lets an agent rent a machine on [Charter](https://charter.mainnet.toonprotocol.dev/agents) and pay for it itself. No account, no API key, no signup: the agent has a wallet, its operator funds it, and each paid tool call is one x402 payment in USDC on Base.

What it rents, by the hour, at 0.007 USDC an hour on the live host:

- **A Python sandbox.** Your script (up to 8 KiB, NumPy installed, no network) runs once; stdout, stderr and the exit code come back.
- **A page fetcher.** Up to five pages loaded in a headless browser through a hidden exit on the Anyone network; the text of each comes back.
- **A Linux home.** A Debian box of your own with 1 CPU, 1 GiB of memory, a 2 GiB disk kept 7 days after the lease ends, and SSH in.

## Install

Claude Code:

```bash
claude mcp add charter -- npx -y charter-mcp
```

Any other MCP client, in its server config:

```json
{
  "mcpServers": {
    "charter": { "command": "npx", "args": ["-y", "charter-mcp"] }
  }
}
```

Node 22 or newer.

## First run

1. The server makes a wallet key at `~/.charter/mcp.key` (mode 600). It never leaves the machine.
2. Ask the agent to call `charter_wallet`. It prints the address.
3. Send USDC on Base to that address. No ETH is needed: the facilitator submits each transfer. 0.05 USDC is enough for seven test runs; 1 USDC is about 6 days of a home.
4. Ask the agent to run something: "run `print(2 + 2)` on Charter".

Until the wallet is funded the free tools work and the paid ones answer with the reason; `charter_wallet` gives the address to fund.

## Tools

| tool | cost | what it does |
| --- | --- | --- |
| `charter_offers` | free | the machines on sale now, with price, size and images |
| `charter_wallet` | free | the wallet address, its USDC balance, the caps, today's spend |
| `charter_run_python` | one interval | runs a Python script and returns its output |
| `charter_fetch_pages` | one interval | loads up to five pages and returns their text |
| `charter_rent_home` | one interval | opens a Linux home with your SSH public keys |
| `charter_lease` | free | a lease's state, paid time left, SSH address, finished output |
| `charter_extend` | one interval each | pays the next 1 to 24 intervals of a running lease |

A job tool waits up to 40 seconds by default, under most clients' tool timeout. A job still running then hands back its `leaseId`, and `charter_lease` collects the output for free.

## From a shell

The same seven actions, one command each, for an agent that runs commands instead of speaking MCP. Each prints one JSON document; a failure is `{"error": "..."}` with a non-zero exit code.

```bash
npx -y charter-mcp offers
npx -y charter-mcp wallet
npx -y charter-mcp run-python job.py
echo 'print(2 + 2)' | npx -y charter-mcp run-python -
npx -y charter-mcp fetch https://example.com --wait 120
npx -y charter-mcp rent-home keys.pub
npx -y charter-mcp lease <leaseId>
npx -y charter-mcp extend <leaseId> 2
```

`run-python`, `fetch`, `rent-home` and `extend` pay; the others are free. With no command it runs as the MCP server. The wallet, the caps and the count of the day's spend are shared by both.

## What bounds the money

- The server signs only `exact` payments in USDC on Base, to the payee Charter's door names at `GET /v1/door`. Anything else a 402 offers is never signed.
- It reads the price first and never signs for more than that price, whatever the 402 then asks.
- `CHARTER_MAX_USDC_PER_HOUR` (default `0.01`): a dearer interval is never signed.
- `CHARTER_MAX_USDC_PER_DAY` (default `0.25`): the most one UTC day may cost. The count is kept in `~/.charter/mcp-spend.json`, under a lock, so a restart or a second client on the same machine does not reset it. A damaged file stops payments until you delete it.
- A call is counted against the day unless no payment was signed, or the signed payment was turned down with a 402 (an empty wallet, most often). So a call refused as `busy` after signing is counted although it never settles: the count errs toward having spent.
- It talks to the door's own address only, follows no redirect, and gives up on a request after 30 seconds (90 for a paid one).
- Every paid tool's description starts with `PAID` and names the price, so a client that asks before a tool call shows it.
- What the caps do not do: bind a door that lies about a refusal. Against that the bound is the wallet's balance. Keep only what the rent needs in this wallet; the key is a plain file.

Other settings: `CHARTER_MCP_KEY_FILE`, `CHARTER_MCP_SPEND_FILE`, `CHARTER_MCP_NO_NEW_KEY` (never make a key; paid tools stay off without one), `CHARTER_BASE_RPC`, `CHARTER_DOOR_URL`.

## Read this before renting a home

- SSH is reachable only at an onion address on the Anyone network. Whoever logs in needs an Anyone client: `ssh -o ProxyCommand="nc -x 127.0.0.1:<SOCKS port> %h %p" tenant@<host>`.
- The box has no public address and all its traffic leaves through Anyone: slow, and some services refuse shared exits.
- No root. 1 GiB of memory. The live host has two home slots; an open answers `busy` when both are taken.
- The operator of the host can read the disk. Secrets go in over `scp`, never through Charter.
- A home that is not paid closes; its disk and address are kept 7 days and the same keys open it again.

The full procedure is at [charter.mainnet.toonprotocol.dev/agents](https://charter.mainnet.toonprotocol.dev/agents).

## Status

One host, run by the project, live on Base mainnet since 2026-10-17. No uptime figure. Charter runs on [TOON](https://toon.ar.io/): ILP routes each packet, x402 settles it. MIT.

## Develop

```bash
npm install
npm test
npm run build
node scripts/smoke.mjs --free
```

`node scripts/smoke.mjs` without `--free` also makes one paid call from the wallet in the key file.
