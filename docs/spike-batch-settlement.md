# Spike: x402 batch-settlement for browser renters (Task 12, step 1)

Date: 2026-10-20. Question: can a browser renter pay one tick every 30 s without a wallet
pop-up each time, using what the door already depends on?

## Answer: yes on both counts

1. `@x402/evm` 2.25.0 (the version in `package.json`) ships `batch-settlement` as a first-class
   scheme: `@x402/evm/batch-settlement/client` and `/server`, plus a facilitator part. The client
   has no Node-only imports (file storage is a separate export), so esbuild can bundle it for the page.
2. The client takes a `voucherSigner` separate from the wallet: "EIP-712 vouchers are signed with
   this key; deposits still use the main signer." The channel's `payerAuthorizer` becomes that key's
   address. So the page can hold a session key and sign ticks silently.

## How the scheme works (from the package source)

- A channel is `ChannelConfig(payer, payerAuthorizer, receiver, receiverAuthorizer, token,
  withdrawDelay, salt)` on the x402 `batch-settlement` contract, `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`
  on Base (the same contract every TOON channel uses since ADR 0075).
- First paid request: the wallet signs ONE EIP-3009 `receiveWithAuthorization` for the deposit,
  bundled with the first voucher. The facilitator submits it on chain. The money sits in the contract,
  not with the door.
- Every later request: a cumulative voucher (`maxClaimableAmount` = charged so far + this tick) signed
  by the session key. The door verifies it locally (`verifyVoucherLocally`) and skips the facilitator
  for both verify and settle: no chain call per tick.
- When the running total would pass the channel balance, the client asks the wallet for a top-up
  deposit (one more pop-up).
- Claiming: the door's `BatchSettlementChannelManager.claim()` sends the latest voucher per channel to
  the facilitator in a batch; `settle()` moves claimed funds to the receiver (payTo). `refund()` /
  `refundIdleChannels()` returns an idle channel's unclaimed balance to the payer cooperatively, so the
  renter does not wait out `withdrawDelay`.
- The server side needs a `receiverAuthorizerSigner`: an EVM key that signs claim batches and refunds
  for the receiver. The library accepts a facilitator-advertised authorizer instead, but PayAI does not
  advertise one (see below), so the door must hold its own. That key can only direct claims to the
  channel's receiver (payTo) or refund the payer; it never holds funds.

## Facilitator

`https://facilitator.payai.network/supported` (the door's default) lists `batch-settlement` on
`eip155:8453` (Base mainnet), marked `experimental`, with policy:

| field | value |
| --- | --- |
| asset | USDC `0x8335…2913` |
| minInitialDeposit | 100000 (0.10 USDC) |
| maxInitialDeposit | 100000000 (100 USDC) |
| withdrawDelay | 3600 to 86400 s |
| depositAttemptsPerMinute | 5 |

No `receiverAuthorizer` in its extra. `x402.org/facilitator` has batch-settlement on Base Sepolia only.

## Consequences for the design

- The client's default deposit is 5 x the request (0.025 USDC at tick 5000), under PayAI's minimum.
  The page must size the deposit itself: `max(0.10 USDC, maxIntervals x tickPrice)`.
- A short lease leaves most of a 0.10 USDC deposit unspent. The door refunds idle channels
  cooperatively (`refundIdleChannels`) so the renter gets it back without the hour's wait.
- The channel id is derived from the config with a fixed default salt, so one wallet has ONE channel
  to the door across all its leases: deposit once, rent many times. Channel context and the session key
  live in `localStorage` so a reload keeps the channel.
- `exact` stays registered as the fallback (and for wallets that cannot sign for a session key).

## Not verified yet

- A real deposit, claim, settle and refund through PayAI on Base mainnet. Costs: the renter's 0.10 USDC
  deposit (refundable) and nothing from the door, assuming PayAI pays gas as it does for `exact`.
- Whether PayAI's `experimental` flag hides any rate limit beyond `depositAttemptsPerMinute`.
