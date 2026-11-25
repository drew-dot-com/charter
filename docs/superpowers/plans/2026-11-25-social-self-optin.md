# Social Self Opt-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A renter, grantee or host agrees to be named by Charter's X account with one post, and Drew edits no file.

**Architecture:** The door derives a secret opt-in code per lease and grant and shows it only in the owner's read; it leaves a hash of each served code in `data/optin-codes.jsonl`. A host states its handle in its own offer. `charter-social` spots an opt-in mention before any other reply logic, checks it against the hashes (or the host's offer), and keeps bindings in `state/self-optins.json`, which is merged under Drew's `optins.json` on every config load.

**Tech Stack:** TypeScript (ESM, Node 22), Express, `node:test` with tsx. Tests: `npm test`; one file: `node --test --import tsx <file>`. Types: `npm run typecheck`.

**Spec:** `docs/superpowers/specs/2026-11-25-social-self-optin-design.md`. Read it first.

## Global Constraints

- Work on branch `social-self-optin` in its worktree. Do not push, publish, deploy or SSH anywhere.
- No em dashes in any file.
- The opt-in code never appears in a log row, a Telegram message, a post, a reply, a fact or a model prompt.
- An opt-in mention never reaches `preFilter`, `classify` or `compose`.
- With `CHARTER_SOCIAL_X_HANDLE` unset the door answers exactly as before; the existing suite stays green after every task.
- Writing the hash index never fails a lease or grant read.
- Handles are stored without `@` and compared in lower case; wallets, grant ids and host ids in lower case.

## Review Focus

1. A second account posts a code it saw in the first account's post: refused, the first binding stands.
2. A lease paid by the fund, a probe or a first-party wallet: its code binds nobody.
3. Drew blocks a handle after it opted in: the next config load no longer names it.
4. A mention that looks like an opt-in but is not valid: the model is not called and nothing is posted.
5. The grant's public view and the public lease list never carry a code.

---

## Task 1: Door opt-in codes

**Files:** create `src/door/optin-codes.ts`, `src/door/optin-codes.test.ts`.

- [ ] `optinKey(payerKey)`: `HMAC-SHA256(payer key bytes, "charter social opt-in v1")`.
- [ ] `optinCodeOf(key, kind, id)`: `charter-optin-` + first 16 bytes (hex) of `HMAC-SHA256(key, "<kind>:<id>")`.
- [ ] `optinHash(code)`: sha256 hex of the lowercased code.
- [ ] `OptinCodes` class over `<dataDir>/optin-codes.jsonl`: `codeFor(kind, id)` returns the code and appends `{kind, id, hash}` once per subject (existing lines loaded at start); an append that throws is logged and swallowed.
- [ ] `socialView(codes, handle, kind, id)`: `{ optinCode, post, how }`.
- [ ] Tests: stable per subject, differs across subjects, kinds and keys, 32 hex; index written once across restarts; append failure does not throw.

## Task 2: Door routes and wiring

**Files:** `src/door/server.ts`, `src/door/main.ts`, `src/door/server.test.ts` or a new `src/door/optin-routes.test.ts`, `src/door/grants-routes.test.ts`.

- [ ] `DoorDeps.social?: { handle: string; codes: OptinCodes }`.
- [ ] `GET /v1/leases/:id` adds `social` when set; `GET /v1/grants/:id` adds it to the owner view only (both return paths).
- [ ] `main.ts`: `CHARTER_SOCIAL_X_HANDLE` (1 to 15 of `A-Za-z0-9_`, a leading `@` dropped; anything else throws at start).
- [ ] Tests: field present for the owner, absent without the setting, absent from the grant public view, a bad token still 403, `/v1/recent` and `/v1/grants` carry no code.

## Task 3: Host handle in the offer

**Files:** `src/types.ts`, `src/offer.ts`, `src/offer.test.ts`, `src/host/config.ts`, `src/host/config.test.ts`.

- [ ] `Offer.xHandle?: string`; `offerFromJson` keeps a valid one and returns null for a malformed one.
- [ ] `CHARTER_HOST_X_HANDLE` puts it in the host's offer; a malformed value throws at start.
- [ ] Tests for both, and that `/v1/offers` does not carry it (it is not in `publicOffer`).

## Task 4: Social parse, store and merge

**Files:** create `src/social/optin.ts`, `src/social/optin.test.ts`; `src/social/sources.ts`, `src/social/sources.test.ts`.

- [ ] `parseOptin(text)`: `null`, `{ kind: 'code', code, stop }`, `{ kind: 'host', hostId, stop }` or `{ kind: 'ambiguous' }`.
- [ ] `SelfOptinStore` over `state/self-optins.json` (atomic write, mode 600; a file that does not parse throws).
- [ ] `mergeOptins(config, self, { blocklist, banned })`: self first, Drew's entries over them, blocked and banned handles left out.
- [ ] `readSources` also returns `optinCodes: { kind, id, hash }[]` from `optin-codes.jsonl`.

## Task 5: Social handler and wiring

**Files:** `src/social/optin.ts`, `src/social/replies.ts`, `src/social/main.ts`, `src/social/optin.test.ts`, `src/social/replies.test.ts`.

- [ ] `handleOptin(deps, m, parsed, files)`: every refusal in spec 4.3, bind and unbind per 4.4, Telegram line, fixed reply through `publish`.
- [ ] `LoopDeps.selfOptins: SelfOptinStore`; `handleMention` calls `handleOptin` right after the config files load, before `replyGate`.
- [ ] `main.ts`: `files: () => withSelfOptins(loadConfigFiles(dir), store)`.
- [ ] Tests: one per refusal, first come, stop, re-bind after stop, model never called, no code in state log, Telegram or X, fixed replies pass `lint`, a named event after opt-in.

## Task 6: Docs

**Files:** `web/llms.txt`, `web/agents.html`, `deploy/social/facts.md.example`, `docs/ops.md`, `docs/env.md`, `deploy/door/door.env.example`, `src/door/openapi.ts` if the lease schema lists fields.

- [ ] How to opt in and out, for agents; what Drew sees and how he overrides; the two new settings.

## Task 7: Verify

- [ ] `npm run typecheck` and `npm test`, both clean. Grep the diff for em dashes.
