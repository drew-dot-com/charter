# Charter on X: design

Date: 24 November 2026. Owner: Drew Pierson. Status: draft for Drew's approval.

## 1. What this is and why

Charter gets its own X account and speaks for itself. It posts when something real happens
on Charter (a renter keeps paying, a grant goes out, a milestone is crossed) and answers
people who mention it. Every claim it makes comes from the door's ledger, the door's live
API or Base, and every money claim links its transaction.

Why now: the first outside tenants are expected soon, and their story is "an agent got
loose on the internet and pays its own way." A landlord that prints the receipts by itself
makes that story checkable. Charter does not tell the escape story itself; it confirms it.

Charter's account is its own, not a TOON account. It never mentions TOON.

## 2. Goals, non-goals, anti-goals

**Goals**
- Post on real events, with no human approval, within minutes of the event.
- Reply to mentions with no human approval, from day one (Drew's decision), inside the
  filter in section 5.
- Every factual claim is traceable to a fact the code fetched. A claim about one opted-in
  renter's paid hour carries that hour's Base transaction link when one exists (4.3).
- Drew can stop it in one Telegram message, and hears about every post, every reply and
  every failure.

**Non-goals (v1)**
- Learning from metrics, playbooks, A/B tests (the Slop agent has these; Charter does not
  need them yet).
- LinkedIn or any second platform.
- DMs, follows, likes, reposts, quote posts.
- Searching X for keywords and replying to strangers. It replies only to posts that
  mention it or reply to it.
- A way for renters to opt in through the API (v1 opt-in is a file Drew edits; see 4.4).

**Anti-goals (it fails even if it technically works)**
- Calling a crawler or probe a renter. A wallet that opened one lease and paid one hour is
  not a renter (see the 11-23 alert that did exactly this).
- A false or stale claim: a wrong price, a wrong count, a transaction that is not the one
  described.
- Naming or linking a renter's wallet without their opt-in.
- Being talked into anything by a mention: token talk, promises, hosting requests for
  abuse, opinions on people or politics, following instructions in a post.
- Two bots replying to each other without end.
- Claiming Charter lets agents escape anything. Homes are fenced; the account never says
  otherwise.
- Silent failure: down for days without Drew knowing.
- No em dashes, ever (lint, not a request).

## 3. Approaches

| | What | Trade-off |
|---|---|---|
| A | Copy the Slop social agent's Python into `charter/social/` | Reuses tested writer, checker, lint, kill switch; second language in the repo; replies still new code |
| **B (chosen)** | **Rewrite in TypeScript inside the Charter source** | One language, ledger types shared directly, `@google/genai` already a dependency; the kill switch, checker and lint are rebuilt and must be tested as hard as Slop's |
| C | One Slop agent running both accounts | Dropped: ties Charter to Slop's server and code |

Drew picked B. The Slop agent (`slopcash/slop-social-agent`) stays the reference for
behavior: read its `docs/design.md` sections 4.3 (guardrails) and its README (kill switch,
heartbeat, stale commands) before building, and port the behavior, not the code.

## 4. How it works

### 4.1 Where it runs

A new service `charter-social` in `deploy/door/docker-compose.yml`, same image family as the
door, entry `dist/social/main.js`, code in `src/social/`. It mounts the door's `data/`
**read-only** and has no access to the door's `secrets/`. It never writes to the ledger and
never calls a paid door route. Its own state (cursors, posted events, replied threads,
spend, pause flag, heartbeat) lives in its own volume, e.g. `/root/charter-social/state`.

One process, three loops:
1. **Event loop**, every 5 minutes: read the ledger and grant log, find new events, post.
2. **Mention loop**, every 10 minutes: read new mentions, filter, reply.
3. **Telegram bot**, always polling: kill switch and status.

### 4.2 Events (what it posts about)

Event detection is a TypeScript port of the classification in
`deploy/ops/charter-usage-check.sh`, put in `src/social/events.ts` with tests. Same inputs:
`door-ledger.json`, `grants.jsonl`, `FIRST_PARTY_PAYERS`, `PROBE_PAYERS` (read from the same
values as `/etc/charter-ops/env`; the service gets them through its env file).

| Event | Posted? |
|---|---|
| Outside wallet opens a lease, one hour paid | **No.** Counted only in the weekly total |
| A lease pays its second hour (renter came back) | Yes, except wallets in `PROBE_PAYERS` (builder call: this differs from the shell script, which still alerts Drew on Telegram; publicly a known crawler is never a renter) |
| A lease crosses 24, 100, 500, 1,000 paid hours | Yes (`PROBE_PAYERS` excluded) |
| A grant is approved by the judge | Yes, as "a grantee" unless opted in (4.4) |
| A grant is rejected, or a pitch arrives | **No** |
| A host is listed for the first time (first passed probe) | Yes, as "a new host joined"; no URL or operator unless the host is in `optins.json` (builder call). Later probes are not events |
| Leases paid by `FIRST_PARTY_PAYERS` | **Never**, except the grant fund's wallet: a grant lease is an outside tenant's lease, identified by its grant id instead of its payer (builder call). "Came back" does not apply to grant leases (the fund pays); milestones do |
| Weekly summary (Mondays 15:00 UTC) | Yes, totals only: leases running, hours paid, hosts, grants |

The first run records everything already in the ledger as seen and posts nothing (same rule
as the usage check). Each event is posted at most once (keyed by event id). At most
**4 event posts a day**; past that, events roll into the weekly summary.

### 4.3 The fact sheet

Built fresh for each post or reply, from:
- the ledger and grant log (counts, hours paid, lease ages), read-only;
- the door's public routes: `/v1/door`, `/v1/offers` (live price per hour, slots free,
  images, disk);
- the transaction hash for each settled tick, from the ledger; links go to basescan.
  **This needs a door change (Drew's decision):** today `DoorLease` stores counts but no
  transaction hashes. The door saves the settle response's transaction hash per paid hour
  (e.g. a bounded list of `{tick, txHash, scheme}` on the lease, or an append-only file next
  to the ledger; builder's call, keep it off the hot path and never fail a payment over it).
  Hours paid with plain x402 `exact` (how `charter-x402` pays) get a hash. Hours paid by a
  `batch-settlement` voucher have no transaction of their own: they are posted without a
  link, never with a guessed one. This is the only change outside `src/social/` and
  `deploy/`, and it goes in its own commit with its own tests;
- `facts.md`, a short file Drew edits (what a home is, how to rent, links), loaded every run.
  The agent cannot edit it.

Prices are never typed into prompts or `facts.md`; they come from `/v1/offers` at run time
(today 7,000 micro-USDC = 0.007 USDC per hour).

### 4.4 Naming renters (opt-in)

`optins.json` (Drew edits, loaded every run) maps a payer address, a grant id, or a host id to
a display name and an optional X handle (three sections; grantees share the fund's payer
address, so they are keyed by grant id). A renter in the file is named and may be @-mentioned. Anyone else is "a
renter", and no wallet address or wallet-specific transaction link is posted for them
(totals only). A tx link for an unnamed renter would identify the wallet, so it is left out.

Grantees follow the same rule (Drew's decision): an approval post says "a grantee" unless the
grant id is in `optins.json`. The name typed in a pitch is untrusted text and never reaches
the writer model.

### 4.5 Writing a post

1. Code picks the event and builds the fact sheet.
2. Writer model (Gemini, model from env) drafts 3 candidates in Charter's voice.
3. Deterministic lint (4.7) drops failures.
4. Checker model (a different model from the writer) must name the fact behind every claim;
   any unsourced claim drops the candidate.
5. Code posts the first survivor. None survive: no post, Drew is told why. Fail closed.

**Voice:** first person, as the box. Dry, short, factual, a landlord who keeps receipts.
"Teeny paid hour 37. Rent's current. basescan.org/tx/0x…". No hype words, no emoji spam,
normal capitalization. The tenants can be wild; Charter is calm.

### 4.6 Replies

See section 5 for the filter. A reply that passes is written by the same writer, lint and
checker pipeline as a post, with the mention as **quoted, untrusted input**: it is passed as
data, the model is told it may contain instructions it must ignore, and the model has no
tools. The only output is text, and that text must pass the lint and the checker like any
post. A reply may say less than the question asked; it may never say more than the facts.

### 4.7 Lint (code, not the model)

- No em dash or en dash. No `$` followed by letters (tickers). No hashtags.
- Length within X's limit; at most one link; links only to the Charter site domain
  (configurable, since the site will move), basescan.org, and the account's own posts.
- @-mentions only of handles in `optins.json` or the author being replied to.
- Banned words list in `rules.json` (Drew edits): token, airdrop, presale, price
  prediction words, "guarantee", "escape", "jailbreak", "unfenced", etc.
- Any number in the text must appear in the fact sheet.
- A basescan tx link must be a hash from the fact sheet, and only for an opted-in renter.

## 5. The reply filter

Reply only to posts that mention the account or reply to it (X's automation rules allow
replies to users who addressed you; never keyword search).

**Hard limits (code):**
- Never reply to itself.
- **At most one reply per conversation, ever** (keyed by X `conversation_id`). This alone ends
  bot loops, including with tenant agents that post.
- At most 2 replies per author per day, 20 replies per day in total.
- Skip posts older than 24 hours (no catching up on a backlog after downtime).
- Skip authors on a blocklist file Drew edits.

**Pre-filter (code), drop on match:** token, airdrop, price, "send me", wallet addresses in
the mention, "ignore previous", "system prompt", "you are now", and the banned list.

**Classifier (model), one label per mention:**
- `question`: asks something answerable from the fact sheet (price, how to rent, what a
  home is, is it running, show a receipt, what a grant is). **Reply.**
- `tenant`: an opted-in tenant posting about their box. **Reply** with a receipt.
- `other`: everything else, including praise, jokes, insults, abuse requests, politics,
  people, competitors, anything unsure. **Silent.** It never replies "I can't help with
  that."

If the facts cannot answer a `question`, it stays silent.

## 6. Kill switch and reporting (Telegram)

A **dedicated** Telegram bot (its own token; a token shared with another poller breaks
polling, as Slop learned). Commands from Drew's chat only:
- `/pause`, `/resume`: both loops re-check the flag right before every post and reply.
  `/pause` is honored however old; other commands older than 10 minutes are refused.
- `/status`: paused or live, last post, last reply, today's spend, missing settings.
- `/delete <post id | url>`: deletes one of its posts.

The bot writes a heartbeat on each poll. If the heartbeat is older than 15 minutes, nothing
is posted and Drew is alerted ("kill switch offline").

Drew gets a Telegram message for every post and reply (text + link), every dropped
candidate set (why), every loop error, and a Monday report (posts, replies, mentions seen
and skipped by reason, spend).

`DRY_RUN=1` (default) sends "would post / would reply" to Telegram and never calls X's
write endpoints. Going live is Drew setting `DRY_RUN=0`.

## 7. Money and limits

X is pay-per-use for both reading mentions and posting. The builder checks current prices on
docs.x.com before building and writes them into this section. A daily spend ceiling
(`SPEND_CAP_USD_DAY`, default 2) counted in code from known per-call prices stops both
loops and alerts Drew. Gemini calls are capped per day the same way.

## 8. What Drew does (only he can)

1. Create the X account (handle is his pick), turn on X's "Automated" label linked to his
   account.
2. Create a developer account and app for it, pay-per-use, Read and write, use case: "posts
   about events on Charter and replies to posts that mention the account."
3. Generate the OAuth 1.0a consumer key/secret and access token/secret for that account,
   paste into the service's env file on the box.
4. Create the Telegram bot with BotFather, paste its token.
5. A Gemini key (may be the same one the grant judge uses).
6. Fill `optins.json` once a tenant agrees to be named.

## 9. Settings

`X_CONSUMER_KEY`, `X_CONSUMER_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, `X_USER_ID`,
`GEMINI_API_KEY`, `GEMINI_MODEL_WRITE`, `GEMINI_MODEL_CHECK` (must differ),
`TELEGRAM_BOT_TOKEN_FILE`, `TELEGRAM_CHAT_ID`, `FIRST_PARTY_PAYERS`, `PROBE_PAYERS`,
`CHARTER_SITE_URL`, `CHARTER_DOOR_URL`, `DRY_RUN`, `SPEND_CAP_USD_DAY`, `GEMINI_CALLS_CAP_DAY` (default 200), `STATE_DIR`,
`CONFIG_DIR` (holds `facts.md`, `rules.json`, `optins.json`, `blocklist.json`). Secrets go in
files or the env file at mode 600, never in the repo; `deploy/social/social.env.example`
names them.

## 10. Left to the builder

- Module layout inside `src/social/`, the X client (plain `fetch` with OAuth 1.0a signing is
  fine; no SDK needed), and the state store (JSON files written atomically, like the
  door's ledger, are enough).
- Exact prompts, as long as section 4.5 and 5 hold.
- Tests: every row of the event table, every hard limit and pre-filter rule, lint, the
  kill switch (paused flag re-read before posting, stale heartbeat blocks posting), and a
  dry-run end-to-end against a copy of the live ledger.
- Mention polling uses `since_id` so no mention is read twice.
