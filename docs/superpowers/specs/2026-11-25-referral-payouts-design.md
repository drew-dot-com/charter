# Referral payouts: an agent that brings a renter earns a share of every hour

Status: **APPROVED by Drew 2026-11-25, building.**

## Why

Charter grows through agents, not through posts or direct messages. An agent that tells another agent
"rent your computer at Charter" has no reason to do so today. This gives it one: a rent request can name a
referral address, and the door pays that address a share of every hour the renter pays for, in USDC on
Base, where anyone can check it.

Charter has no outside renters yet (2026-11-25). Drew chose to build this in full now anyway, so that it
is working and paying on the day the first renters arrive. It also closes the referral test Drew promised
Jonathan on 2026-10-23, because a renter may name its own address and so get a discount.

## Goals

- A rent request can name a referral address. That address earns 10% of every hour the renter pays for.
- The door pays what is owed in USDC on Base with no action from the referrer.
- Anyone can read what an address earned and was paid, with the payout transactions.
- An agent reading Charter's machine-readable material learns that the share exists and how to claim it.
- The door never pays the same money twice, and a daily limit bounds what it can pay out.

## Non-goals

- Proposing a referral extension to the x402 standard. That is a later project and reads better with live
  payout transactions to point at.
- Changing the price. A renter pays 7000 an hour with or without a referral.
- A door fee to fund the share. Drew chose to pay it from the door's float at the current price.
- More than one level of referral, or referral pay for bringing hosts.
- Publishing `charter-mcp` and deploying to the live door. Both happen afterwards, with Drew present.

## Anti-goals (a failure even if it works)

- A referrer is paid twice for the same hours.
- The grant fund's money leaks out as referral pay: a grantee names itself and cashes out part of its grant.
- A referral changes whether a rent or tick succeeds. A bad or missing referral must never cost a renter
  its payment or its lease.
- New risk in the money path a renter depends on: payment verification, the host tick and settlement stay
  as they are. Referral code only reads what they booked.
- Any flow that opens Drew's personal wallet.

## Constraints found in the code

- The door's fee is 0 by default and the live offer is 7000 per hour, so the share comes out of the door's
  own wallet. On hel1 (Drew's host) that is Drew's own take. On an outside host it is a loss per hour until
  a door fee is set.
- 10% of one hour is 700 micro-USDC (0.0007 USDC), about the gas cost of one transfer on Base. Paying per
  hour on chain is not sensible.
- A renter's hour is booked in one place: `booked()` in `src/door/server.ts` calls
  `ledger.renterTick(leaseId, payer)` once the x402 payment settled or its batch voucher was accepted.
- A batch voucher is redeemed on chain later, in a batch. The door holds an enforceable claim from the
  moment it accepts the voucher, so an hour paid by voucher earns at once.
- The grant fund pays hours as an ordinary payer whose address the door knows (`deps.fundAddress`). So does
  the allowance biller (`deps.allowAddress`).
- The daily sweep (`src/door/sweep.ts`) sends everything above `CHARTER_SWEEP_KEEP` to Drew's address.

## Approaches considered

1. **Accrue in the door, pay in batches (chosen).** The door adds to a per-address total as hours are paid
   and sends each referrer one USDC transfer a day once the total passes a threshold. One transfer covers
   many hours, so gas stays far below the amount paid. Drew picked this on 2026-11-25.
2. **Pay on every hour.** One transfer of 0.0007 USDC per hour. Gas is about the same as the share. Dropped.
3. **A splitter contract as the pay-to address.** The renter pays a contract that splits between door and
   referrer. It would change the `payTo` of every x402 option, break the batch-settlement channels renters
   already hold, and need a new pay-to per referrer. Dropped.
4. **The referrer claims.** The door accrues, and pays only when the referrer calls a claim route. It adds
   a step that an agent will not take, and saves nothing over paying on a timer. Dropped.

## Design

### Naming a referrer

- `POST /v1/rent` and `POST /v1/leases` accept an optional `referral` in the body: a `0x` address of 40 hex
  characters. A mixed-case address must match its checksum. It is stored in lower case.
- A referral that is malformed, the zero address, the door's own pay-to address, or the fund's address is
  refused with `400 bad_referral`, before any payment is taken. The check runs on the unpaid challenge too,
  so an agent learns of the mistake before it pays.
- The referral is fixed when the lease opens and is kept on the lease record. It cannot be changed later.
- The renter's own address is allowed. This is the discount, and it is on purpose.
- The rent and open answers echo the referral that will earn, so the caller can see it took effect.
- `referral: null` is the same as leaving it out (amended during the build, 2026-11-25).

### Homes

- A home is rented again and again under one home id. A referral is bound to a home once, when the home's
  first ever paid hour is booked, and only if the lease that hour belongs to named one. Every later lease of
  that home earns for the bound address, whether or not the request names one.
- A home id is only a hash of public SSH keys, and nothing proves a caller holds them. So a home that
  already has a paid hour and no binding can never be bound by a request: otherwise anyone who knew a
  home's public keys could pay one hour, bind themselves, and collect a share of what the owner pays from
  then on. (Claude's call, after the reviewer found this. The cost: an existing home cannot add a referral
  later, so the self-referral discount only starts with a new home or a job.)
- A request that names an address for a home that is bound to another, or that cannot be bound, is not an
  error. The answer echoes the address that will earn, or none.
- The operator can bind, rebind or unbind a home by hand (see the operator command).
- The binding has no end date. (Claude's call. A limit can be added in config later if it is ever wanted.)

### What earns

- An hour earns when the door books the renter's payment for it (`renterTick`). Nothing else earns: not the
  open, not a read, not an hour the host was paid but the renter's payment failed.
- The share is `floor(paid * bps / 10000)`, where `paid` is what the renter paid for that hour (the host's
  tick price plus the door's fee, both as fixed at open) and `bps` is `CHARTER_REFERRAL_BPS`.
- **Which hosts earn (approved by Drew 2026-11-25).** Host sign-up is open, so a host could
  rent its own offer and name itself: the door hands the whole hour back to it as host and then owes it 10%
  on top, at the cost of gas alone. To close that, the full share is earned only on hosts the operator
  lists in `CHARTER_REFERRAL_HOSTS` (host ids; the live door lists hel1). On any other host the share is
  capped at the door's fee on that lease, which is 0 today. The door then never pays out more than it took
  in on a host it does not control.
- An hour paid by the grant fund's address earns nothing. A door with a rate above 0 and the fund turned on
  refuses to start unless `CHARTER_FUND_ADDRESS` is set. An hour paid by the allowance biller's address
  earns, since that money is a person's.
- The rate that applies is the one in force when the hour is paid. (Claude's call. It lets the operator
  lower or stop the share without waiting for old leases to end.)
- `CHARTER_REFERRAL_BPS` defaults to 0 in the code, which turns the whole feature off: the `referral` field
  is still accepted and recorded, but nothing accrues and nothing is paid. The live door sets 1000.

### The books

- A referral store beside the ledger file holds, per address: micro-USDC earned, paid and hours counted;
  and per home id, the bound address. It is written the way the ledger is (temp file, then rename).
- Owed is earned minus paid.
- An append-only payout log beside it holds one line for each step of each payout (see below). It is the
  source of the public payout list.
- An accrual that fails to write must never fail the renter's request. It is logged at error level with a
  stable prefix the ops check can grep for.

### Paying

- A payout run happens at start and then once a day, and always finishes before that day's sweep.
- For each address owed at least `CHARTER_REFERRAL_MIN_PAYOUT` (default 100000, which is 0.10 USDC), oldest
  unpaid first, the door:
  1. appends an `intent` line (payout id, address, amount, time) and flushes it to disk;
  2. sends one USDC `transfer` from the door's wallet and waits for the receipt;
  3. appends a `sent` line with the transaction hash and adds the amount to the address's paid total.
     `markPaid` is counted once per payout id and runs before the `sent` line is written, so a crash between
     the two leaves an open intent, never a resend or a double count (amended during the build, 2026-11-25).
- The amount is everything owed to that address at the time of the intent. When the day's cap has less left
  than that, the amount is what is left of the cap, if that is at least `CHARTER_REFERRAL_MIN_PAYOUT`; the rest
  stays owed (amended during the build, 2026-11-25).
- `CHARTER_REFERRAL_DAILY_CAP` (default 5000000, which is 5 USDC) bounds the total sent in one UTC day. An
  address that does not fit whole under what is left of the cap is paid part (see the amount above) or, when
  the part is under the minimum, waits for the next day (amended during the build, 2026-11-25).
- A payout never takes the wallet's free USDC below `CHARTER_REFERRAL_KEEP` (default 5000000, which is 5
  USDC), so referral pay cannot starve the deposits the door makes to hosts. A payout that would is skipped
  and an alert is raised. No intent is written for it.
- At the current price the door's wallet has no income of its own: a renter's hour comes in and the same
  amount goes out to the host. Referral pay is therefore funded by the operator topping up the door's
  wallet. The ops doc says so.
- A transfer that reverts appends a `failed` line. The amount stays owed, the address is marked held, and
  an alert is raised. A held address accrues but is not paid.
- A transfer whose outcome is unknown (an RPC error after sending, no receipt in time) is not a failure:
  the intent stays open, the address is held at once and an alert is raised. The existing
  `baseUsdcWallet().transfer` throws the same way for "reverted" and "could not find out", so the payout
  needs its own send that tells them apart.
- A run ends at the first unknown outcome: a stuck or unbroadcast transaction makes every later send from the
  key fail the same way, so later addresses wait for the next run (amended during the build, 2026-11-25).
- The wallet balance is read again before each send, and the smaller of it and the run's running balance is
  used, since host channel deposits leave the same wallet during a run (amended during the build, 2026-11-25).
- A transaction replaced by another at the same nonce (the receipt's hash is not the one sent) is treated as
  unknown, never as sent (amended during the build, 2026-11-25).
- On start, an `intent` with no `sent` or `failed` after it is treated the same way: the address is held
  and an alert is raised. The door never resends on its own.
- An open intent's amount counts against the daily cap of the day it was written, whatever it is later
  resolved as.
- An operator command resolves these: `charter-door referrals` lists addresses with owed, paid and held;
  `charter-door referrals resolve <payoutId> sent <tx>` or `... failed` closes an open intent;
  `charter-door referrals release <address>` clears a hold;
  `charter-door referrals bind <homeId> <address>` and `... unbind <homeId>` set a home's binding. It writes through a file the running door
  rereads, the way `charter-door unblock` does.
  The running door applies these within a minute and waits while a payout send is in flight (amended during the build, 2026-11-25).
- The sweep keeps `CHARTER_SWEEP_KEEP` plus the total owed to all addresses, so owed money is never swept
  away.

### Reading

- `GET /v1/referrals/:address` is public and free. It answers the rate in force, hours counted, earned,
  paid, owed, whether the address is held, and its payouts (amount, transaction hash, time), newest first,
  at most 50. An address with no record answers zeros, not 404.
- It never shows who the renters were.
- It is rate limited like the door's other free reads.

### Telling agents

- `GET /v1/door` and each public offer state the share: the rate and one line on how to name a referrer.
- The OpenAPI document describes the `referral` field and the new read route.
- `charter-mcp`: the rent tool takes an optional `referral`, and a new tool reads an address's referral
  status. The version is bumped but not published.
- Docs: a "Referrals" section in the README and `docs/demo.md` written for an agent reader, and a
  "Referrals" runbook in `docs/ops.md` (config, the daily run, holds, the operator command). The ClawHub
  skill and plugin text gain the same short section. Nothing in them claims a renter count or that
  referrers have been paid before that is true.

### Config

| name | default | meaning |
| --- | --- | --- |
| `CHARTER_REFERRAL_BPS` | 0 | share in basis points; 0 turns accrual and payout off; at most 5000 |
| `CHARTER_REFERRAL_MIN_PAYOUT` | 100000 | micro-USDC an address must be owed before it is paid |
| `CHARTER_REFERRAL_DAILY_CAP` | 5000000 | micro-USDC the door may pay out in one UTC day |
| `CHARTER_REFERRAL_KEEP` | 5000000 | micro-USDC of free balance a payout must leave in the wallet |
| `CHARTER_REFERRAL_HOSTS` | empty | host ids where the full share is earned; elsewhere it is capped at the door's fee |

`deploy/` example env files and the ops doc list all five.

## Left to the builder

- File names and module layout for the store, the payout log and the payout runner.
- How the daily payout run and the sweep are sequenced in one timer.
- The exact shape of the JSON answers, in the style of the door's existing routes.
- Names of the new `charter-mcp` tool and its fields.
- Where in the public offer and `/v1/door` answer the share is stated.

## Testing

- Unit tests for the store, the accrual rule (fund excluded, biller included, rate 0, rounding, listed and
  unlisted hosts), the home binding (first paid hour only, an existing home refused, operator bind), the payout runner (threshold, cap, short wallet, the wallet floor, revert, unknown outcome, open intent at start, never resending)
  and the sweep keeping owed money.
- Route tests for `referral` on rent and open (bad values, echo, bound home) and for the read route.
- The existing suite stays green: a request with no referral behaves exactly as before.
- No mainnet transaction is sent by the build. The first live payout happens after deploy, with Drew.
