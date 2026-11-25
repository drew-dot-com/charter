# Self-service opt-in to be named on X: design

Date: 25 November 2026. Owner: Drew Pierson. Status: built on branch `social-self-optin`, not deployed.
Amends `2026-11-24-charter-x-account-design.md` section 4.4 (its non-goal "a way for renters to opt in
through the API" is lifted).

## 1. What this is and why

Charter's X account names a renter, grantee or host only when their id is in `optins.json`, a file Drew
edits by hand. The file is empty, so every post says "a renter". A payment is not consent, so naming
cannot be automatic, but the hand edit does not scale and an agent cannot do it for itself.

This lets the subject agree by itself, with two proofs and no trust in anything typed:

- **control of the record**: a secret opt-in code only the lease or grant owner can read (or, for a
  host, a handle the host serves at its own URL);
- **control of the X handle**: a post from that handle that mentions Charter's account.

## 2. Goals, non-goals, anti-goals

**Goals**
- A renter, a grantee or a host can opt in and opt out with one post, with no action from Drew.
- Drew hears about every opt-in and opt-out on Telegram and can override any of them.

**Non-goals**
- A free-text display name. The name is the X handle itself.
- Opt-in by API call, at rent time, or by DM.
- A Telegram command to edit opt-ins (Drew uses `blocklist.json` or `optins.json`).

**Anti-goals**
- The bot naming or @-mentioning someone who did not ask (a stranger typing someone else's handle).
- A wallet address, an opt-in code or any text from the mention reaching a post, a reply, a fact or a
  model prompt.
- Naming a probe wallet, a first-party wallet or the fund's wallet as a renter.

## 3. Approaches

| | What | Trade-off |
|---|---|---|
| A | "Announce me as @x" field at rent or pitch time | One step, but unverified: anyone could make the bot name a third party. Dropped |
| B | Signed message from the payer wallet, posted to the door | Proves the wallet, not the handle; agents on x402 clients rarely expose raw signing. Dropped |
| **C (chosen)** | **Secret code from the door, posted in a mention from the handle** | Two proofs, no new write route on the door, reuses the mention loop. The code becomes public once posted, so it locks to the first handle (4.4) |

Two changes to the proposal this started from, both found in the code:

1. **Hosts get no code.** `POST /v1/hosts` is open to anyone for any URL, so the door has no channel only
   the host can read. The proof is turned around: the host states its handle in its own offer
   (`GET {hostUrl}/v1/offer`, field `xHandle`, set with `CHARTER_HOST_X_HANDLE`), and that handle posts
   the host's public id. Serving the offer proves the URL; the post proves the handle.
2. **The code is called an "opt-in code"**, not a claim code: "claim" already means the x402 channel
   claim key in this repo.

## 4. How it works

### 4.1 The door: opt-in codes

- On when `CHARTER_SOCIAL_X_HANDLE` is set (the account's handle, no `@`). Unset: nothing below is served.
- A code is `charter-optin-` plus 32 hex characters: the first 128 bits of
  `HMAC-SHA256(key, "<kind>:<id>")`, kind `lease` or `grant`. The key is itself
  `HMAC-SHA256(door payer key, "charter social opt-in v1")`, so there is no new secret to manage, the code
  is the same on every read, and nothing in `data/` can rebuild it. (Builder call: a rotated payer key
  changes every unposted code; posted ones keep working through the index below.)
- Shown only where the owner already reads:
  - `GET /v1/leases/<full leaseId>`: field `social: { optinCode, post, how }`. The full lease id is
    already the secret that reads a lease (public views show 8 characters).
  - `GET /v1/grants/<id>` with the right `x-grant-token`: the same field. Never in the public view.
- The first time a code is served, the door appends `{kind, id, hash}` (sha256 hex of the code) to
  `data/optin-codes.jsonl`. `charter-social` mounts `data/` read-only and learns only hashes: it can check
  a posted code but cannot make one. Writing this line never fails the read.
- Hosts: `Offer` gains an optional `xHandle` (1 to 15 of `A-Z a-z 0-9 _`). The door keeps it in the host's
  registry record with the rest of the offer. It is not added to `/v1/offers`.

### 4.2 The post

- Renter or grantee: `@charterhomedev charter-optin-<32 hex>`
- Host: `@charterhomedev charter-host-<hostId>` from the handle in its offer.
- Opt out: the same post with the word `stop`.

### 4.3 charter-social: handling the mention

A mention whose text holds a `charter-optin-...` or `charter-host-...` word is an **opt-in mention**. It is
handled in code, first, and never reaches the pre-filter, the classifier, the writer or the checker,
whether or not it turns out to be valid. Only three things are read from it: the code or host id, whether
the word `stop` is present, and the author's handle.

Refused in silence (a log row, no reply, never retried):
- no author handle, the account itself, a handle on `blocklist.json`, a handle containing a banned word;
- more than one opt-in word in the post;
- a code whose hash is not in `optin-codes.jsonl`; a lease that is gone, has no payer yet, belongs to a
  grant, or whose payer is a first-party or probe wallet; a grant that is gone;
- a host that is gone or dropped, or whose offer does not name the author's handle;
- a subject already bound to a different handle (4.4); a `stop` from a handle that is not the bound one.

The 24 hour age limit and the reply caps do not gate the binding: it is a consent record, not a reply.

What a valid one binds: a lease code binds the handle to the lease's **payer address** (all of that
wallet's leases), a grant code to the **grant id**, a host post to the **host id**.

Drew gets a Telegram line for every bind and unbind (handle, kind, short id; never the code).

After a bind or unbind the account answers once with fixed text, through the same `publish` gate as any
reply (pause, kill switch, caps, spend, one reply per conversation). If that reply is refused the binding
still stands. A refused or repeated opt-in gets no reply, so a stranger cannot make the account talk.

### 4.4 Where bindings live, and who wins

- `state/self-optins.json`, written only by `charter-social`. `config/optins.json` stays Drew's and
  read-only to the service.
- The effective opt-ins are the self opt-ins with Drew's file laid over them: **his entry wins** for the
  same wallet, grant or host.
- `blocklist.json` beats everything: a blocked handle is never bound, and an existing binding to it is
  ignored on every read. A binding whose handle contains a word since added to the banned list is ignored
  the same way.
- The display name is the handle. No other text from the subject is stored.
- **A subject has one handle, first come.** The code is public once posted, so a later post of the same
  code by another account is refused. Only the bound handle can `stop`; after that the code can be used
  again.
- A self-optins file that does not parse fails closed: config loading throws, posts and replies wait, and
  Drew is alerted (the existing "config files do not load" path).

### 4.5 Known limits (accepted)

- A wallet shared by several people (a custodial payer) is named by whoever opts in first. Drew can lay
  an `optins.json` entry over it or block the handle.
- If the opt-in post is never read (more than 100 mentions arrive in one 10 minute window, which the
  mention read does not page through), the posted code is public and unbound. The owner posts again; the
  Telegram line shows Drew who bound.
- A host on old `charter-host` software cannot state a handle; it stays on `optins.json`.

## 5. What ships

- Door: `src/door/optin-codes.ts`, the two read routes, `main.ts` wiring, `CHARTER_SOCIAL_X_HANDLE`.
- Offer and host: `xHandle` in `Offer`, `offerFromJson`, `CHARTER_HOST_X_HANDLE`.
- Social: `src/social/optin.ts` (parse, store, merge, handler), `sources.ts` (code hashes), `replies.ts`
  (route opt-in mentions first), `main.ts` (wiring).
- Docs: `web/llms.txt`, `web/agents.html`, `deploy/social/facts.md.example`, `docs/ops.md`, `docs/env.md`,
  `deploy/door/door.env.example`.

## 6. Tests

Every refusal in 4.3, first-come and stop in 4.4, Drew's file and blocklist winning, code never in a log
row, Telegram line, reply or model prompt (the model is never called for an opt-in mention), the fixed
replies passing the lint, the door showing the code only to the owner and only when the feature is on,
code stability and 128 bits, the hash index written once, `xHandle` parsing.
