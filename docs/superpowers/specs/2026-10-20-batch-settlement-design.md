# Batch settlement for browser renters (Task 12)

Date: 2026-10-20. Approved by Drew in chat ("Build it as designed"). Spike: `docs/spike-batch-settlement.md`.

## Problem

A browser renter signs a wallet prompt every 30 s (one `exact` EIP-3009 authorization per tick). A lease
longer than a demo is unusable.

## Design

The door offers the x402 `batch-settlement` scheme beside `exact` on the tick route. The page prefers it.

**Renter's view.** First rental from a wallet: one signature deposits USDC into a `batch-settlement`
channel on the x402 contract (`0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` on Base). Every tick after
that is a cumulative voucher signed by a session key the page generated: no prompt. One channel per
wallet, kept in `localStorage`, so later leases from the same wallet deposit nothing until it runs low;
a top-up is one more prompt. When a lease is over, the door refunds the unspent balance within
about twenty minutes (ten idle, then the next timer round), cooperatively, so the renter never waits
out the withdraw delay. The page then reads the channel from chain and carries on from there.

**After review (10-20):** the page reads the channel from chain (eth_call through the wallet) and, when
the door refuses a batch payment, forgets its record and pays once more from the chain's view before
falling back to exact; a deposit's EIP-3009 window is checked like an exact payment's; a channel whose
payer asked to withdraw is refused (`channel_withdrawing`) and claimed at once; a settle follows every
refund round; batch is offered only when the facilitator lists it.

**Money.** Deposit = max(0.10 USDC (PayAI's floor), 20 x tick price, what this tick needs). The deposit
sits in the contract; the door can claim only what vouchers cover. The door claims and settles hourly in
batches through the facilitator, which submits the transactions (as it does for `exact` today).

**Door.** `X402Config` gains `claimKey` (a hex secp256k1 private key read from `CHARTER_CLAIM_KEY_FILE`)
and `channelDir` (`<CHARTER_DATA_DIR>/x402-channels`). `realGate` registers
`BatchSettlementEvmScheme(payTo, { storage: FileChannelStorage, receiverAuthorizerSigner, withdrawDelay: 3600 })`
and `ExactEvmScheme`; the route's `accepts` lists batch first, exact second, same price. The claim key
signs claim batches and refunds for the payee and holds no funds. `charter-door x402 status | claim | refund`
runs the manager's one-shots for the demo and ops.

**Tick route.** A batch payment is identified by its channel's payer (for the ledger and the payer block)
and is NOT deduplicated by the door: a cumulative voucher re-sent after a refused tick is the right next
voucher, and the scheme's channel state is the authority. No authorization window applies; the host-tick
deadline is now + 300 s minus the settle margin (the scheme's pending reservation lives that long).

**Page.** `web/channel.ts` keeps, per wallet address, a session key and the channel context in
`localStorage` (`charter.x402.<address>`). `payFetchFor` registers both schemes, filters requirements to
the expected amount/asset/payTo on either scheme, prefers batch, and sizes deposits as above. A 402 that
comes back after a batch payment was sent disables batch for the rest of the page session; the ticker's
existing retry then pays that index with `exact`.

**Copy.** README and the lease page: "Your wallet signs once to put a deposit (at least 0.10 USDC) into an
x402 channel. Each interval after that is signed by this page, silently. What you do not use comes back
when the lease ends."

## Limits (documented, not solved)

- One running lease per wallet at a time: two leases share one channel, a concurrent tick comes back as
  a 402, and that page falls back to exact (one prompt per tick) for the rest of its session.
- Losing `localStorage` loses the session key: the page opens a fresh channel (a new deposit); the old
  channel's balance comes back by the door's idle refund.
- PayAI marks batch-settlement experimental.

## Done means

A browser lease on mainnet of at least 3 intervals with ONE wallet prompt, the deposit transaction, a
claim/settle transaction into Drew's Base address, and a refund of the remainder, all linked from
`docs/demo.md`.
