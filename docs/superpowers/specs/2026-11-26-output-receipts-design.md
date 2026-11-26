# Output receipts and renter-paid pinning: design

Status: APPROVED by Drew 2026-11-26. Built on feat/receipts. One change after the final review, marked below.

## Intent

An agent that rents from Charter should be able to walk away with a durable record of what it did
there, and Charter must never host the agent's content. Drew does not mind building this ahead of
demand; what he will not accept is strangers' files served from Charter's IP or domain.

Two parts:

1. **A receipt.** The door signs a small statement over the SHA-256 of an output. Anyone can check it
   offline against the door's public address.
2. **Pinning the renter pays for.** A command in the home image sends a file to Pinata's x402 door,
   paid from the home's own wallet. Pinata holds the bytes and carries the abuse and takedown work.

## Goals

- A finished fetch or python job can be asked for a receipt that says: this host returned these bytes
  for this lease, which was paid for N hours.
- A running, paid home can be asked for a receipt that says: the holder of this lease declared this
  hash (and, if given, this CID) at this time.
- The two kinds can never be mistaken for each other.
- A receipt is safe to publish: it gives nobody access to the lease.
- One command in a home pins a file and gets the receipt in the same step.

## Non-goals

- Charter storing, serving, proxying or pinning any renter content. No kubo, no gateway.
- Charter paying Pinata, or holding the renter's money for it.
- On-chain receipts, ERC-8004 reputation or validation writes.
- A receipt for a job that did not finish.
- The stdio `charter-mcp` npm package and the ClawHub skill (both need a release by Drew; follow up).
- A hosted "verify this receipt" route. Verification is offline; the docs carry the snippet.

## Anti-goals

- The door signing free text. Every signed field is a fixed-format value (hex, integer, CID, enum),
  so the door's key can never be made to "say" something a caller wrote.
- A receipt that could be replayed as a payment authorization.
- A receipt that leaks the lease id. The lease id is the capability that reads a lease, its output
  and its X opt-in code.
- Copy that reads as "Charter verified the computation". Hosts are not vetted.

## Constraints found in the code

- The lease id alone reads a lease (`GET /v1/leases/:id`, `known()` in `src/door/server.ts`).
- Job output reaches the renter in parts of 48 KiB (`OUTPUT_PART_BYTES`), at most 64 parts through the
  door (`MAX_OUTPUT_PARTS` in `src/tenant/door-host-api.ts`). The door caches each part it has fetched
  under `<dataDir>/output/<leaseId>/<part>.json` as `{ part, parts, data }` with `data` base64.
  A part not yet cached costs one of the lease's paid host reads (`spendRead`).
- A home has no output (`outputParts` is undefined; it never reaches `done`).
- The door's only key is its payer key (`CHARTER_DOOR_PAYER_KEY_FILE`, `payerKey()` in
  `src/door/config.ts`). Its address is already public as `payer` in `GET /v1/door`. The server gets
  the address only (`deps.payer`), not a signer.
- The home image already carries `charter-x402` (`jobs/home/x402-rent.mjs`) with a wallet at
  `~/.charter/x402.key`, `@x402/fetch`, `@x402/evm` and `viem`, and the environment has
  `CHARTER_LEASE_ID` and `CHARTER_DOOR_URL`.
- Pinata's door, checked 2026-11-26: `POST https://402.pinata.cloud/v1/pin/public?fileSize=<bytes>`
  answers 402 with an `exact` USDC price on Base (1200 micro for 1 MiB; 0.10 USDC per GiB for twelve
  months, floor 1000 micro). Paid, it answers `{ url }`; a multipart POST of `file`, `network=public`,
  `name` to that URL answers `{ data: { cid } }`. The working client is `~/src/TOON/lading/src/ipfs.ts`
  (`pinataUploader`), which is the reference for this flow. Pinata's public gateway rate-limited reads
  on 2026-09-08.

## Approaches

**A. The door signs with its existing payer key (picked by Drew).** No new key, no state beyond a
cached job receipt, no gas. Tradeoff: the key that pays hosts also signs statements, handled by the
message format below.

**B. The ERC-8004 identity key signs.** Cleaner story, but that key controls the listing, has no copy
off the box, and would have to move into the internet-facing door. Rejected: A plus a pointer in the
registration file gives the same tie to the listing.

**C. Each receipt written on chain.** Public and permanent with no file to keep, but gas per receipt,
ETH in the door, and every lease made public. Rejected.

## The receipt

Response body of both routes:

```json
{
  "receipt": {
    "v": 1,
    "kind": "job",
    "door": "https://charterhome.dev",
    "leaseRef": "<64 hex>",
    "hostId": "<64 hex>",
    "image": "charter-python",
    "ticksPaid": 1,
    "intervalSeconds": 3600,
    "payer": "0x…",
    "sha256": "<64 hex>",
    "bytes": 1234,
    "at": 1795000000000
  },
  "message": "Charter receipt v1\n{…the receipt as one line of JSON…}",
  "signer": "0x…",
  "signature": "0x…"
}
```

- `kind`: `job` or `declared`. Nothing else.
- `leaseRef`: `sha256("charter-lease:" + leaseId)` as hex. The holder can prove it is theirs by
  showing the lease id; nobody else can read the lease from it.
- `hostId`: from the offer snapshot in the ledger.
- `image`: the job's image name. The ledger does not hold it today (the snapshot only lists what the
  host offers), so `DoorLease` gains an optional `image`, written at open from the job the door built.
  A lease opened before this change has none and its receipt leaves `image` out. The host's own status
  answer is never the source. (Claude's call, after the builder check.)
- `ticksPaid`, `intervalSeconds`: `ticksPaidByRenter` at signing time and the offer snapshot's
  interval. Each host sets its own interval, so the door signs ticks and their length and never a
  count of hours. (Claude's call, after the builder check.)
- `payer`: the lease's payer, lower case, left out when unknown or when it is the grant fund's or the
  biller's address (those are Charter's wallets, not the agent's). (Claude's call.)
- `sha256`, `bytes`: for `job`, of the whole output, meaning the decoded parts joined in order: the
  same bytes a renter gets by reading every part. For `declared`, as the caller gave them (`bytes`
  optional there).
- `cid`: `declared` only, optional. Changed after the final review: the door checks the CID's bytes (version
  0, or version 1 over a sha2-256 digest, raw or dag-pb) and signs it as version 1 in base16 (`f`, then hex).
  Base32 can spell words, so signing the caller's own string would have let a caller put a sentence under
  the door's key, against the anti-goal below. The door still never fetches it.
- `at`: epoch ms the door signed.
- Keys appear in the order above; absent optional keys are simply left out.
- `message` is the literal line `Charter receipt v1`, a newline, then `JSON.stringify(receipt)`.
  `signature` is an EIP-191 personal-message signature of `message` by the door's key. x402 `exact`
  payments are EIP-712 typed data (EIP-3009), so a receipt signature can never be one.
- To verify: recover the signer of `message`, compare it with `signer` and with `receiptSigner` from
  `GET /v1/door`, then read the receipt out of `message` itself (never trust the `receipt` field
  alone).

### `GET /v1/leases/:id/receipt` (job)

- 404 `not_found` for an unknown lease, as the other lease reads.
- A home lease (the ledger has `homeId`) gets 409 `home_lease` with a hint to POST instead.
- 409 `unpaid` when `ticksPaidByRenter` is 0.
- Cached parts first, with no host call: part 0's file carries `parts`, and when every part from 0 to
  `parts - 1` is on disk the door signs from those alone. So a renter who has read its whole output can
  get a receipt after a door restart, or after the host has dropped the lease. (Claude's call, after
  the builder check.)
- Otherwise the door reads the lease status: 409 `no_output` unless it is `done` with `outputParts`
  at least 1. It then reads each missing part through the same path as `GET …/output/:part`, spending
  the lease's read budget; a budget or host failure answers as that route does, and the parts fetched
  so far stay cached for the next try. Receipt reads are not exempt from the budget: best effort is
  accepted for a lease that never read its own output. (Claude's call.)
- Joins the decoded bytes, hashes, signs.
- The signed answer is written once to `<dataDir>/receipts/<leaseId>.json` (0600, temp file then
  rename) and served from there afterwards, so a repeat costs nothing and returns the same `at`.
- Shares the existing per-IP GET limit on `/v1/leases`.

### `POST /v1/leases/:id/receipt` (declared)

- Body: `{ "sha256": "<64 lower hex>", "cid"?: "<CID>", "bytes"?: <non-negative safe integer> }`.
  Any other key, or a value off format, is 400 `bad_request`. `cid` must match a CIDv0 (`Qm` + 44
  base58) or CIDv1 base32 (`b` + lower base32, 50 to 120 characters) shape; nothing else is accepted.
- 409 `not_a_home` unless the lease is a home lease; 409 `not_running` unless its state is `running`
  and `paidThrough` is in the future; 409 `unpaid` when `ticksPaidByRenter` is 0.
- Signs and answers. Nothing is stored.
- At most 60 declared receipts per lease per hour (in memory, `slidingLimit`), 429 `rate_limited`
  past it. (Claude's call: signing is cheap and the label makes a spam receipt worthless.)
- The lease status used here is the door's usual cached read (`leaseStatus`).

### Signer

- New optional server dep `receiptSigner: { address, signMessage({ message }) }`, built in
  `src/door/main.ts` from the payer key. Left out (tests, `free-for-tests`): both routes are not
  mounted and `/v1/door` carries no `receiptSigner`.
- `GET /v1/door` gains `receiptSigner: "0x…"`.
- `web/well-known/agent-registration.json` gains a service
  `{ "name": "receipts", "endpoint": "https://charterhome.dev/v1/door" }`. (Claude's call: a service
  entry rather than a new top-level key, since directories already tolerate custom service names.)
- New module `src/door/receipts.ts` holds the pure parts: building the receipt, the message, the CID
  and body checks, `leaseRefOf`, and `verifyReceipt` (used by tests and the CLI below).

## The home command

`jobs/home/x402-rent.mjs` gains two subcommands:

- `charter-x402 receipt <file>`: hashes the file, POSTs `{ sha256, bytes }` to the door for
  `CHARTER_LEASE_ID` (or `--lease`), prints the signed receipt and saves it to
  `~/.charter/receipts/<sha256>.json`. No money moves. This is the pure "leave a record" path.
- `charter-x402 pin <file>`: probes Pinata unpaid for the price, refuses when it is over
  `CHARTER_X402_MAX_PIN` (micro-USDC, default 10000 = 0.01 USDC, about 100 MiB), pays from the home's
  wallet, uploads, prints the CID and `https://gateway.pinata.cloud/ipfs/<cid>`, then asks the door
  for the declared receipt with the CID in it and saves it as above. `--no-receipt` skips the door.
  A file over the price cap is refused before anything is signed. The command reads no balance (the
  home has no Base RPC): an empty wallet shows up as Pinata refusing the signed payment, nothing
  settles, and the command prints the address to fund, as `renew` does today. (Claude's call, after
  the builder check.)
- Payment policy for `pin`: only `exact`, USDC on Base, to the `payTo` the unpaid 402 named, at no more
  than the cap; the same shape as `onlyDoorExact`. `PINATA_402_URL` overrides the door for tests.
- No read-back loop in v1: Pinata's answer with a CID is the proof. The command prints a line saying
  the public gateway can take minutes and may rate-limit. (Claude's call.)
- Usage text, the header comment and `home.test.mjs`'s usage check are updated.

A renter outside a home (a job renter) uses the docs recipe: `GET` the receipt, and pin with any x402
client if it wants the bytes public.

## Remote MCP

`src/door/mcp.ts` gains one free tool, `charter_receipt`: input `leaseId`; it calls
`GET /v1/leases/:id/receipt` over loopback and returns the signed receipt, or the door's error name.
It does not declare (a declared receipt needs a hash the caller computed in its home, where
`charter-x402` is the tool).

## Docs

`web/llms.txt`, the agents page, `README.md`, `src/door/openapi.ts` and `docs/ops.md` gain a short
section each. The copy must say, in plain words:

- a job receipt means the host returned those bytes for a paid lease, and hosts are not vetted;
- a declared receipt is the renter's own claim with the door's timestamp;
- pinning is a purchase from Pinata, a third party, paid by the renter; the file becomes public for
  twelve months; Charter never sees it;
- how to verify (six lines of viem).

The live-URLs test (`src/live-urls.test.ts`) must keep passing. No em dashes anywhere.

## Testing

- `src/door/receipts.test.ts`: message format is byte-stable; sign then verify; a tampered field
  fails; `leaseRef` never contains the lease id; body and CID checks.
- `src/door/server.test.ts`: both routes, every refusal above, the cached job receipt, the declared
  rate limit, `/v1/door` carrying `receiptSigner`, routes absent without a signer.
- `src/door/mcp.test.ts`: the new tool.
- `jobs/home/x402-rent.test.mjs`: `receipt` and `pin` against stub door and stub Pinata, including the
  price cap refusal and the payment policy.
- Whole suite and typecheck clean before anything is called done.

## Rollout (each step needs Drew's go-ahead; none is part of the build)

1. Deploy the door (backup first, as `docs/ops.md` says).
2. Rebuild the home image on hel1 so new homes carry the new subcommands.
3. Run `deploy/identity/set-uri.mjs` so directories re-read the registration file (a few cents of
   gas from the identity key).
4. Live proof for `docs/demo.md`: one job receipt verified offline, and one `charter-x402 pin` from a
   test home (about 0.001 USDC from that home's wallet).

## Left to the builder

- Exact error strings beyond the names above, and helper names.
- Whether the job route streams parts or reads them one after another (64 parts at most).
- Wording of the docs sections, within the rules above.
