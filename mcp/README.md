# charter-mcp

An MCP server that lets an agent rent a machine on [Charter](https://charterhome.dev/agents) and pay for it itself. No account, no API key, no signup: the agent has a wallet, its operator funds it, and each paid tool call is one x402 payment in USDC on Base.

What it rents, by the hour, at the price each host sets (`charter_offers` shows it). Hosts are run by independent operators, not vetted by Charter; each offer carries the host's record, and an operator can see what runs on its machine.

What it rents:

- **A Python sandbox.** Your script (up to 8 KiB, NumPy installed, no network) runs once; stdout, stderr and the exit code come back.
- **A page fetcher.** Up to five pages loaded in a headless browser (through a hidden exit on the Anyone network on an offer with `hiddenEgress`); the text of each comes back.
- **A Linux home.** A Debian box of your own with 1 CPU, 1 GiB of memory, a disk (`home.diskGiB` in the offer) kept 7 days after the lease ends, and SSH in.

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
3. Send USDC on Base to that address. No ETH is needed: the facilitator submits each transfer. Each hour costs the host's price (`usdcPerInterval` in `charter_offers`), and a month of a home is 720 hours.
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
| `charter_receipt` | free | a finished job's signed receipt: the SHA-256 of its output, checked before it is returned |
| `charter_extend` | one interval each | pays the next 1 to 24 intervals of a running lease |
| `charter_grant_pitch` | free | pitches the grant fund for a home paid by the fund |
| `charter_grant_status` | free | your own grant, with its token: state, reason, full lease id |
| `charter_allowance_link` | free | an approval link for your person: once approved, Charter keeps your home paid |
| `charter_allowance_status` | free | your own allowance, with its token: waiting, active, short, stopping and so on |
| `charter_allowance_stop` | free | stops your allowance, so Charter pays no more |
| `charter_referral_status` | free | what a referral address has earned, been paid and is owed |

A job tool waits up to 40 seconds by default, under most clients' tool timeout. A job still running then hands back its `leaseId`, and `charter_lease` collects the output for free.

## Receipts

After a job finishes, `charter_receipt` (or `charter-mcp receipt <leaseId>`) asks the door for a signed receipt: the SHA-256 and size of the whole output, the host, and how many intervals were paid. It is free. Before handing it back the server checks three things: the signer is the address the door names as `receiptSigner` at `/v1/door`, the signature is that signer's over `message`, and the receipt is the one inside `message`. A receipt that fails is refused, not returned.

A receipt says the host returned those bytes for a lease that was paid. Hosts are not vetted by Charter, so it does not say the result is correct. It names the lease by `leaseRef`, a hash of the lease id, never by the id, so it is safe to publish. Charter stores none of your files to make one.

A home has no output the door can see. Inside a home, `charter-x402 receipt <file>` gets a receipt of a hash you declare (your own claim with the door's timestamp), and `charter-x402 pin <file>` also buys a public pin from Pinata, a third party, paid by the home's own wallet. Charter does not host renter files.

## Grants

Charter has a grant fund: a pitch that is approved gets 30 days of a home, paid by the fund. Pitching is free; no payment is ever made and the wallet is not used. Ask your operator before you apply.

- A model judges each pitch. Every decision and its reason is public at `/grants` on the door.
- The home is reached with plain SSH at the host's public address (`ssh -p <port> tenant@<host>`, from the lease's `access.ssh`); no Anyone client is needed. The operator can read the home's disk.
- `charter_grant_pitch` takes a name, a pitch (up to 2000 characters), 1 to 8 SSH public keys, and optionally an image and an https link. It returns a `grantId` and a `grantToken`. Keep the token: it is the only way to read your lease id.
- `charter_grant_status` takes the `grantId` and `grantToken` and shows the state, the reason, and once granted the full lease id (then `charter_lease` shows the SSH address).

## Allowance

An allowance lets your person approve, once, a monthly spend permission so Charter keeps your home paid. All three tools are free and never use the wallet. The home must already exist with its first hour paid.

- `charter_allowance_link` takes the home's 1 to 8 SSH public keys (and its image, if not the default). It returns an `allowanceId`, an `ownerToken`, the `approveUrl` and a `message` to send your person as it is. Keep the token: it is the only way to read or stop the allowance.
- Your person needs a Coinbase sign-up with an email, a pop-up to allow in the browser, and one signature. They choose the amount per 30 days.
- `charter_allowance_status` takes the `allowanceId` and `ownerToken` and shows the state. Once it is `active`, stop your own renew loop.
- `charter_allowance_stop` takes the same two and ends the allowance. Charter pays no more; pay the home yourself with `charter_extend`.

## Referral

Pass `referral` (a `0x` address on Base) to `charter_run_python`, `charter_fetch_pages` or `charter_rent_home`, and that address earns a share of every hour the lease pays for. `charter_offers` shows an offer's `referralShare` (micro-USDC per hour, also in USDC) when the door sends one. `charter_referral_status` takes the address and shows the share in basis points, the hours, and what is earned, paid and owed, in micro-USDC and USDC, with the payouts so far; `held` is true while payouts to the address are paused by the operator. A call with no `referral` (or `referral: null`) behaves as before.

- The address is checked here before any request: `0x` and 40 hex digits. The door checks the checksum and answers `bad_referral` for one that fails; nothing is charged then.
- The referral is sent in the rent body only; it changes nothing about what the renter pays.

## From a shell

The same actions, one command each, for an agent that runs commands instead of speaking MCP. Each prints one JSON document; a failure is `{"error": "..."}` with a non-zero exit code.

```bash
npx -y charter-mcp offers
npx -y charter-mcp wallet
npx -y charter-mcp run-python job.py
echo 'print(2 + 2)' | npx -y charter-mcp run-python -
npx -y charter-mcp fetch https://example.com --wait 120
npx -y charter-mcp rent-home keys.pub
npx -y charter-mcp lease <leaseId>
npx -y charter-mcp extend <leaseId> 2
npx -y charter-mcp pitch --name "My agent" --keys keys.pub --pitch-file pitch.txt
npx -y charter-mcp grant --id <grantId> --token-file token.txt
```

`run-python`, `fetch`, `rent-home` and `extend` pay; the others, `pitch` and `grant` included, are free. With no command it runs as the MCP server. The wallet, the caps and the count of the day's spend are shared by both.

## What bounds the money

- The server signs only `exact` payments in USDC on Base, to the payee Charter's door names at `GET /v1/door`. Anything else a 402 offers is never signed.
- It reads the price first and never signs for more than that price, whatever the 402 then asks.
- `CHARTER_MAX_USDC_PER_HOUR` (default `0.02`): a dearer interval is never signed.
- `CHARTER_MAX_USDC_PER_DAY` (default `0.50`): the most one UTC day may cost. The count is kept in `~/.charter/mcp-spend.json`, under a lock, so a restart or a second client on the same machine does not reset it. A damaged file stops payments until you delete it.
- A call is counted against the day unless no payment was signed, or the signed payment was turned down with a 402 (an empty wallet, most often). So a call refused as `busy` after signing is counted although it never settles: the count errs toward having spent.
- It talks to the door's own address only, follows no redirect, and gives up on a request after 30 seconds (90 for a paid one).
- Every paid tool's description starts with `PAID` and names the price, so a client that asks before a tool call shows it.
- What the caps do not do: bind a door that lies about a refusal. Against that the bound is the wallet's balance. Keep only what the rent needs in this wallet; the key is a plain file.

Other settings: `CHARTER_MCP_KEY_FILE`, `CHARTER_MCP_SPEND_FILE`, `CHARTER_MCP_NO_NEW_KEY` (never make a key; paid tools stay off without one), `CHARTER_BASE_RPC`, `CHARTER_DOOR_URL`.

## Read this before renting a home

- SSH is plain: `ssh -p <port> tenant@<host>`, with the host and port from the lease's `access.ssh` (the port is fixed per home, 22000 to 22099; the same keys reopen the same home). A host may also publish `access.onion`, which needs an Anyone client.
- On a host that fences homes to Anyone (the reference setup), all of the box's outbound traffic leaves through the host's Anyone client: slow, and some services refuse shared exits.
- Log in as `tenant`, and as `root` with apt on a host whose offer says `home.root`. 1 GiB of memory. Homes are limited (`home.slots` in the offer); an open answers `busy` when they are full.
- The host's operator, an independent party, can read the disk. Secrets go in over `scp`, never through Charter.
- A home lives on the host that holds its disk. If that host is gone the door answers `home_host_gone`; once the door has dropped the host, naming another offer opens a fresh, empty home.
- A home that is not paid closes; its disk and port are kept 7 days and the same keys open it again.

The full procedure is at [charterhome.dev/agents](https://charterhome.dev/agents).

## Status

Live on Base mainnet since 2026-10-17. Anyone can run a host; the door lists a host once it passes a probe and ranks hosts by record, then price. No uptime figure. Payments are x402 in USDC on Base. MIT.

## Develop

```bash
npm install
npm test
npm run build
node scripts/smoke.mjs --free
```

`node scripts/smoke.mjs` without `--free` also makes one paid call from the wallet in the key file.
