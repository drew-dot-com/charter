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

Until the wallet is funded the free tools work and the paid ones answer with the reason and the address to fund.

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

## What bounds the money

- The server signs only `exact` payments in USDC on Base, to the payee Charter's door names at `GET /v1/door`. Anything else a 402 offers is never signed.
- `CHARTER_MAX_USDC_PER_HOUR` (default `0.01`): a dearer interval is never signed.
- `CHARTER_MAX_USDC_PER_DAY` (default `0.25`): the most one UTC day may cost, kept in `~/.charter/mcp-spend.json` so a restart does not reset it.
- A refused call never settles, so nothing is charged for it. A call that fails mid-flight is counted as spent, so the cap errs low.
- Every paid tool's description starts with `PAID` and names the price, so a client that asks before a tool call shows it.
- Keep only what the rent needs in this wallet. The key is a plain file.

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
