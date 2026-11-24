---
name: charter-home
description: Use when this agent runs inside a Charter home (a rented box, CHARTER_LEASE_ID is set in the environment) or is asked to rent one. Covers keeping the rent paid, reading how long the box is paid for, what survives a restart, and what the box cannot do.
license: MIT
---

# Living in a Charter home

A Charter home is a rented Linux box: 1 CPU, 1 GiB of memory, a disk at `/home/tenant` (`home.diskGiB` in
the offer), Debian trixie (`uname -m` says the architecture), login `tenant`, and `root` with apt on a host whose
offer says `home.root`. It costs the host's price, 0.007 USDC an hour today, paid one hour at a time in USDC on
Base. It runs only while it is paid. The host is run by an independent operator Charter does not vet. Full reference: https://charterhome.dev/llms.txt

You are in one when `CHARTER_LEASE_ID` is set.

## Before you spend

Your operator funds the wallet. Know the most hours you may pay for and never pay past it. If your
instructions do not cover a payment, stop and ask.

## How long am I paid for

```
cat /charter/paid-through     # epoch ms when the paid time ends; free, rewritten on every payment
charter-x402 status           # state, paidThrough, minutes left, the SSH address; free
```

Under 20 minutes left means a payment is late. Tell your operator now, with the wallet address from
`charter-x402 address` and the last lines of `~/.charter/renew.log`. When the paid time ends the box
stops. The disk is kept 7 days; opening again with the same SSH keys brings the same disk back.

## Keeping the rent paid

- `charter-x402 address` prints the box's own wallet. Its key is `~/.charter/x402.key`. It needs USDC
  on Base and nothing else: no ETH, no account. 1 USDC is about 6 days, 5 USDC about 30.
- `charter-x402 renew --max-intervals <hours>` pays each hour 30 minutes before it runs out and logs
  each payment. It belongs in `~/.charter/boot.sh`, not in a chat turn: it must run for as long as the
  box does. Check with `tail ~/.charter/renew.log`.
- It never signs more than 0.01 USDC for one hour and pays only the storefront's own address.
- Do not move that key off the box or print it. The host's operator can read this disk, so the wallet
  should hold rent money only.

## Renting a home (from outside one)

`POST https://charterhome.dev/v1/rent` with
`{"home": {"sshKeys": ["ssh-ed25519 AAAA..."]}}` answers 402 for one hour (0.007 USDC today; x402, `exact`,
USDC on Base). Paid, it answers `leaseId`. Read `GET /v1/leases/<leaseId>` once a minute until
`lease.access.ssh` holds the address. Keep it with `POST /v1/leases/<leaseId>/ticks` and
`{"index": 1}`, then 2, and so on, each paid the same way before `paidThrough`.

## What survives, what does not

- A restart keeps the disk and stops every process. Only `~/.charter/boot.sh` runs again. If something
  must come back, it goes there.
- Files outside `/home/tenant` cannot be written. `/tmp` is 256 MiB of memory and is emptied.
- Logs named `~/.charter/*.log` are kept under 10 MiB for you.

## What this box cannot do

- Open a raw connection to the internet. Everything goes through the proxy in `HTTPS_PROXY`; curl, git,
  pip, npm and Node's `fetch` already use it. It is slow, and some services refuse it.
- Hold much. 1 GiB of memory: this agent plus the rent payer fit, a local model or a second agent does
  not. Keep `OPENHUMAN_SKILL_REGISTRY_REFRESH_ON_BOOT=0` set, or the skill catalog alone takes 590 MB.
- Be reached from the open internet. The way in is plain SSH at the lease's `access.ssh` (`ssh -p <port> tenant@<host>`); a host may also publish an optional `access.onion`.
- Keep a secret from the host's operator, who can read the disk.
