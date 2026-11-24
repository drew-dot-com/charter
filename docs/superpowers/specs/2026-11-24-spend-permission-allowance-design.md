# Spend-permission allowance: a person approves once, Charter keeps the home paid

Status: **SHELVED, ready to build.** Written 2026-11-24 after a mainnet spike. Build it when the trigger
below happens, not before.

## Why

Every Charter home today is paid by a wallet the agent holds, and a person has to put USDC in that wallet
by hand, again and again. The allowance turns that into one approval: a person signs "Charter may take up
to N USDC every 30 days to keep this home running", and from then on the home renews with no person
involved until they cancel or the money runs out.

It was shelved because nothing shows that funding is what stops agents today: the grant fund offers a free
month to any agent that asks (19 open on 2026-11-24) and no outside agent had asked. Drew wants it ready
for the day the real blocker shows up.

**Trigger to build:** a real outside agent wants to keep its home and its person does not fund it. The
likely first sight of this is a grantee whose month is ending.

## What the spike proved (2026-11-24, Base mainnet)

Throwaway code in `~/src/TOON/spend-spike/` (not a repo), `@base-org/account` 2.6.0.

- A person approved from a plain web page (localhost) with one signature: a NEW Base Account
  `0xCAa3…a334` granted a test spender up to 0.05 USDC per 1 day.
- The spender pulled 0.007 USDC twice. The first pull is two transactions (`approveWithSignature` 96,793
  gas, then `spend` 126,873 gas); every later pull is one `spend` (92,004 gas).
- The contract itself, not only the SDK, refuses a pull over what is left (revert `0xfd1ebc88`) and every
  pull after a revoke (revert `0x282b9f97`).
- A revoke sent by the spender takes one transaction (53,531 gas) and needs no popup for the person.
- All four transactions together used about 0.0000022 ETH.
- `prepareSpendCallData(permission, amount, recipient)` can send the pulled USDC to any address.
- Contract: SpendPermissionManager `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` on Base. The account was
  an EIP-7702 delegated EOA.

Friction seen, which the design must state up front to the person:

- Approving needs a **Coinbase sign-up with an email**, not only a passkey.
- The approval is a pop-up from `keys.coinbase.com`. Chrome blocked it once, and it was blank for a while
  on first load before it rendered.
- Only Base Account (Coinbase's smart wallet) can approve. MetaMask and other plain wallets cannot.

Not tested: the allowance resetting at the next period; a cancel started by the person (`requestRevoke`).

## Goals

- One approval by a person keeps one home paid, hour by hour, for as long as the allowance and their USDC
  last.
- The agent needs nothing new: no key, no USDC, no ETH, no extra software. It asks Charter for a link and
  sends it to its person.
- The person can see what was taken and cancel at any time.
- Reuse the door's tick path unchanged, the way the grant fund does.

## Non-goals

- An allowance that works at any x402 seller (the "agent pulls" approach below). Lading has no traffic, so
  that reach buys nothing today.
- Lading, cross-app allowances, referral payouts, an x402 standard proposal.
- Wallets other than Base Account.
- Paying for jobs (python, fetch). Homes only.

## Anti-goals (a failure even if it works)

- Charter pulls more than it needs: never more than about a day of ticks ahead of use.
- Pulled money sits with Charter: credit left when an allowance ends goes back to the person's account.
- Any flow that opens Drew's personal wallet, or uses Drew's money to cover a person's shortfall.
- New risk in the door's money path: the door's tick route, ledger and settlement stay as they are.

## Approaches considered

1. **A biller pulls, then pays the tick over x402 (picked).** A new service, `charter-allow`, holds the
   spender key. It pulls USDC from the person's account into its own wallet, then pays the home's tick
   through the door's normal x402 route, exactly as the grant fund's paymaster does today. The door's tick
   path does not change. Cost: the biller holds up to a day of a home's rent at a time, and each pull is a
   transaction the biller pays gas for.
2. **The door takes the tick by `spend()` directly.** One transaction an hour and no float, with the
   payment landing straight in the door's payTo. But it adds a second kind of payment to the door's tick
   route, whose verify, settle and loss accounting are the most sensitive code in Charter.
3. **The agent's own key is the spender.** Works at any x402 seller, but every agent then needs a key and
   a little ETH, which agents do not need today. Rejected for the reasons in Non-goals.

Drew handed the choice over ("what do you think makes sense?"); approach 1 is Claude's pick.

## The design

### Parts

- **The door** stores allowance requests and the signed permissions, serves the approval page, and shows
  status. It is told the biller's address so the biller is never answered `payer_blocked` (as with
  `CHARTER_FUND_ADDRESS`).
- **`charter-allow`**, a container beside `charter-fund` on the box, built the same way: it listens on
  nothing, talks to the door over https with its own token, and to Base over RPC. It holds the spender key
  (`secrets/allow-key`, 0400) and a small ETH balance for gas, and keeps `data/state.json` (what it pulled,
  what it paid, credit held per allowance; backed up nightly like the fund's state).
- **The approval page** on the door (`/allow/<allowanceId>`), bundled by `scripts/build-web.mjs` with
  `@base-org/account`.

### The flow

1. **The agent asks for a link.** `POST /v1/allowances` with the home's `sshKeys` (the home's identity;
   `homeId` is their hash) and its `image` (default `charter-home`; the door's ledger does not record a
   lease's image, and a re-open needs it). Free. Only for a home that exists: one that has paid a tick
   and whose disk is still kept. Answers `{ allowanceId, approveUrl, ownerToken, state: "waiting" }`. The
   allowance belongs to the home, not one lease, so re-opens keep it. An unapproved request expires after
   7 days. Rate-limited like the other free routes. A home has at most one live allowance: a request for a
   home that already has a `waiting` or `active` one is refused and names the existing one's status
   route.
2. **The agent sends `approveUrl` to its person.** The docs give the agent a ready message that says what
   the person will meet: a Coinbase sign-up with an email, a pop-up to allow, and one signature.
3. **The person approves.** The page shows the home (host, price an hour, what it has been paid so far),
   the amount per 30 days and the spender address. It asks for a spend permission: token USDC on Base,
   spender = the biller, `periodInDays` 30, allowance = 31 days of ticks at the home's current price
   (5.21 USDC at 0.007), no end date. The person may lower it. The page posts the signed permission to the
   door.
4. **The biller checks it** before using it: right chain, token, spender and account; allowance at least
   one tick; the signature accepted by the contract (a simulated `approveWithSignature`); the account
   holding USDC. Bad: state `refused` with a reason. Good: state `active`.
5. **The biller keeps the home paid.** On a loop like the paymaster's (`tickDue`: half an interval before
   the paid time runs out):
   - If its credit for this allowance is short of one tick, it pulls up to 24 ticks' worth, capped by what
     the permission has left this period. The first pull carries `approveWithSignature`.
   - It pays the tick from its wallet through `POST /v1/leases/:id/ticks`, as the fund does.
   - If the home's lease has closed but its disk is still kept, it re-opens the home with the same keys
     and image on the host that holds the disk, and pays the first tick.
   - It **never opens a fresh home**: no first open, no other host. An open that answers
     `home_host_gone`, or a home past its 7-day retention, ends the allowance for good.
   - **It does not pay while a grant does.** Before paying, it reads whether the home has a live grant;
     while one does, it pays nothing and starts at the hour after the grant's last. The agent docs tell
     agents to stop their own renew loop (`charter-x402 renew`, `charter renew`) once the allowance is
     `active`, since two payers race for the same tick index.
6. **It pauses** when the allowance is used up for the period (`spent_for_period`; it waits for the next
   period, and the lease may lapse) or the person's account is short (`short`; it tries again each hour).
7. **It ends for good** (`ended`, with a reason) when any of these happen:
   - the person cancels, seen on chain;
   - the agent stops it;
   - the home is gone: `home_host_gone`, or the 7-day retention passed while paused.

   On ending, the biller revokes the permission itself if it is still live (one transaction, no popup for
   the person) and sends any credit back to the person's account.

### Privacy, status and stopping

Allowances are private, like grants: an allowance links a wallet to a home, and that is the person's
business.

- **No list, unguessable id.** There is no list route. The `allowanceId` is 32 random hex characters, so
  only whoever holds the link can see the approval page.
- **The approval page** (`/allow/<id>`) shows what the person needs before signing: the host, the price
  an hour and the amount per 30 days. After approval it shows the state, what is left this period and when
  it resets, credit held, hours paid and the last pull's transaction.
- **The owner view.** `GET /v1/allowances/<id>` with the `x-allowance-token` header (the `ownerToken`
  from step 1) returns the same as JSON. It works like the grant token.
- **States:** `waiting`, `refused`, `active`, `short`, `spent_for_period`, `ended` (with a reason) and
  `expired`.

Who can stop it:

- **The person** cancels from the approval page, which calls `requestRevoke` from their wallet. This
  button ships only once that path is tested on mainnet.
- **The agent** stops it with `POST /v1/allowances/<id>/stop` and its `ownerToken`. The biller then
  revokes on chain and refunds the credit.
- **Drew** can stop one by hand from the box (`docker exec`), as with the fund's `stop`, for a person who
  writes in.

### Where agents meet it

- The grant fund: in a grant's last 48 hours, the grantee's grant status (the owner view, behind its grant
  token, never the public one) carries the line "to keep this home after the grant, send your person this
  link", with a fresh `approveUrl`. This is the trigger moment.
- `charter-mcp`: a free tool, `charter_allowance_link`, that takes the home's keys and returns the link and
  the message to send.
- `llms.txt`, `/agents`, the README: one short section.

### Money and gas

- Pulling a day of ticks at a time keeps gas to about one pull per home per day. Pulling every hour would
  cost about 0.0004 ETH a month per home (720 pulls of about 92,000 gas at the spike's gas price), roughly a
  quarter of a month's rent at an ETH price near 3,000 USD.
- The biller's ETH lasts on the order of a thousand pulls per 0.0005 ETH. It alerts (the ops Telegram
  path) when ETH runs low, when a pull fails other than for a short account, and when a tick it paid for
  was refused.
- A tick the door refuses after the biller paid is handled as the door already handles refused ticks; the
  biller retries with the next authorization and its credit is unchanged until a tick settles.

## Constraints

- Base mainnet, USDC only, Base Account only.
- The door's tick route, ledger and settlement do not change.
- The biller pays only the door, and signs only `exact` USDC to the door's payTo.
- Secrets stay in files under the box's 0400 secrets folders, never in chat or logs.
- No em dashes in anything that ships.

## Calls Claude made (Drew to check)

- The biller never opens a fresh home or moves one to another host; a gone home ends the allowance and
  refunds.
- Allowances are private like grants (owner token, no list), not public.
- One live allowance per home; a second request is refused.
- The agent can stop an allowance with its owner token; Drew can by hand.
- A person never pays a grant hour: the biller waits for the grant to end.

## Left to the builder

- The exact routes, state names and file layout, following the fund's patterns.
- How the door authenticates the biller (follow `CHARTER_FUND_TOKEN_FILE`).
- How the page handles a blocked or blank pop-up (the SDK has a retry dialog; check it renders).
- Period edge cases: test the reset on a short-period permission on mainnet before trusting the 30-day one.
- Test the person-side cancel (`requestRevoke`) before advertising the cancel button.

## How we know it worked

A person who is not Drew approves an allowance, and the biller pays at least 24 ticks of that home from
it with no one stepping in.
