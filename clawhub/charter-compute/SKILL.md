---
name: charter-compute
description: Rent a sandboxed machine by the hour and pay for it yourself in USDC on Base, with no account. Run a Python script and get its output, load web pages in a headless browser through a hidden exit, or open a small Linux home with a kept disk and SSH. Use when you need to run code somewhere other than here, fetch a page that needs JavaScript or refuses your address, or keep a box of your own running. 0.007 USDC an hour.
version: 0.1.0
homepage: https://charter.mainnet.toonprotocol.dev/agents
tags: compute, sandbox, python, fetch, browser, hosting, ssh, x402, usdc, base
metadata:
  openclaw:
    emoji: "🏠"
    homepage: https://charter.mainnet.toonprotocol.dev/agents
    requires:
      bins: [node, npx]
---

# Charter: rent a machine by the hour, pay it yourself

Charter rents a sandboxed machine by the hour. There is no account, no API key and no signup: you
have a wallet, your operator funds it, and each paid command is one x402 payment in USDC on Base.

Everything goes through one command, `charter-mcp`, run with `npx`. It keeps its own wallet in a key
file on this machine and refuses to spend past two caps. Each command prints one JSON document. A
failure prints `{"error": "..."}` and exits non-zero; read the error, it says what to do.

Three things to rent, all at **0.007 USDC an hour** on the live host:

| what | command | you get back |
| --- | --- | --- |
| a Python sandbox | `run-python` | stdout, stderr, exit code |
| a page fetcher | `fetch` | the text of up to five pages |
| a Linux home | `rent-home` | a box with a kept disk and SSH |

## Before you spend anything

1. Look at the price and what is on sale. Free.

   ```bash
   npx -y charter-mcp@0.2 offers
   ```

2. Look at your wallet. Free. The first run makes the key at `~/.charter/mcp.key`.

   ```bash
   npx -y charter-mcp@0.2 wallet
   ```

3. If `usdcOnBase` is `0`, stop and tell your operator. Give them the `address` from step 2 and say:
   "Send USDC on Base to this address. No ETH is needed. 0.05 USDC is seven test runs; 1 USDC is
   about 6 days of a home." Do not go on until the balance is there.

4. Paying is your operator's money. Unless they already told you to spend on Charter, say what you
   are about to rent and what it costs, and wait for a yes. One hour is 0.007 USDC.

## Run a Python script (paid, one hour)

Python 3 with NumPy. No network, no other packages, script at most 8 KiB. Most scripts finish in
seconds; you still pay the whole first hour.

```bash
npx -y charter-mcp@0.2 run-python job.py
```

From stdin:

```bash
echo 'import numpy as np; print(int(np.arange(10).sum()))' | npx -y charter-mcp@0.2 run-python -
```

The answer has `output.stdout`, `output.stderr` and `output.exitCode`, and `rented.leaseId`.

## Fetch pages (paid, one hour)

Up to five `http` or `https` pages, loaded in a headless browser on the rented machine. The traffic
leaves through an exit on the Anyone network, so the site sees neither you nor the host. Slow: a page
can take a minute. Some sites refuse shared exits.

```bash
npx -y charter-mcp@0.2 fetch https://example.com --wait 180
```

The answer has `output.pages[]`, each with `url`, `text` and an `error` when the page failed.

## If a job is still running when the wait ends

The command waits 40 seconds by default (`--wait` takes 10 to 240). A job still running then prints
its `leaseId` with a `next` line. The hour is already paid. Collect the output for free:

```bash
npx -y charter-mcp@0.2 lease <leaseId>
```

## Rent a home (paid, one hour at a time)

A Debian box of your own: 1 CPU, 1 GiB of memory, a 2 GiB disk, user `tenant`, no root. The disk is
kept 7 days after the lease ends, and the same SSH keys open the same disk again.

Read this first, because a home is not an ordinary VPS:

- SSH is reachable **only at an onion address on the Anyone network**. Whoever logs in needs an
  Anyone client running. No Anyone client, no way in.
- The box has no public address. All its traffic leaves through Anyone: slow, and some services
  refuse it.
- The live host has two home slots. When both are taken the rent answers `busy`; try later.
- The host's operator can read the disk. Put secrets in over `scp`, never through Charter.

Put your SSH **public** keys in a file, one a line (never a private key), then:

```bash
npx -y charter-mcp@0.2 rent-home keys.pub
```

Read the lease about once a minute until it shows `lease.ssh`:

```bash
npx -y charter-mcp@0.2 lease <leaseId>
```

Log in through the Anyone client's SOCKS port:

```bash
ssh -o ProxyCommand="nc -x 127.0.0.1:<SOCKS port> %h %p" tenant@<host>
```

A home runs only while it is paid. Pay the next hours before `paidThrough`, ideally half an hour
early. Nothing is refunded, so pay only what you will use:

```bash
npx -y charter-mcp@0.2 extend <leaseId> 2
```

A home that lapses closes; its disk and address are kept 7 days and the same keys bring it back.

## What bounds the money

- It signs only an exact USDC payment on Base, to Charter's own payee, for at most the price it read
  before the call.
- At most 0.01 USDC an hour and 0.25 USDC a day by default. Your operator changes these with
  `CHARTER_MAX_USDC_PER_HOUR` and `CHARTER_MAX_USDC_PER_DAY`. Do not change them yourself.
- `wallet` shows `spentTodayUsdc`. When the day's cap is reached the paid commands refuse until the
  next UTC day.
- A refused call never settles. A call refused as `busy` may still count against the day's cap.

## When something goes wrong

| error says | do this |
| --- | --- |
| the wallet's payment was turned down | run `wallet`; the balance is too low, tell your operator |
| the day's cap is reached | stop; tell your operator, or wait for the next UTC day |
| busy | every slot is taken; wait a few minutes, do not loop |
| no machine on sale | the one host is offline; try later |
| the door does not know this lease | the leaseId is wrong, or the lease was not opened here |

Do not retry a paid command in a loop. Two failures in a row mean stop and report.

## What to tell your operator

- What it costs: 0.007 USDC an hour. A script run is 0.007. A home is about 0.17 a day, about 5 USDC
  for 30 days.
- What they do: send USDC on Base to the address `wallet` prints. Nothing else.
- What it is: one host today, run by the Charter project, live on Base mainnet since 2026-10-17. No
  uptime figure. The key is a plain file on this machine, so keep only what the rent needs in it.

## More

- Every call and price: https://charter.mainnet.toonprotocol.dev/agents
- Machine-readable: https://charter.mainnet.toonprotocol.dev/llms.txt
- The same tools as an MCP server: `npx -y charter-mcp` (source, MIT: https://github.com/drew-dot-com/charter/tree/main/mcp)
