# Charter on charterhome.dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Charter's landing page and door at `charterhome.dev` (storefront at `rent.charterhome.dev`), rename every live reference to the old toon name, republish packages and listings, and point `charter.ar.io` at a moved notice.

**Architecture:** One door, four names, one Caddy block family on the box. The landing page becomes a door static page (`web/home.html`), reached at the apex by a Caddy rewrite of `/` only. The old names stay as aliases. No door code change.

**Tech Stack:** TypeScript (node:test via tsx), Express static, Caddy, Porkbun DNS (web UI), npm/MCP registry/ClawHub CLIs, `@ardrive/turbo-sdk` 1.42.0 + `node-artifacts/arns-set-record.mjs` for the ArNS part.

**Spec:** `docs/superpowers/specs/2026-11-24-charterhome-domain-design.md`

## Global Constraints

- Canonical base URL: `https://charterhome.dev`. Storefront: `https://rent.charterhome.dev/`. Old names `charter.mainnet.toonprotocol.dev` and `charter.167-233-221-236.sslip.io` keep serving unchanged (no redirect in this work).
- Box: 167.233.221.236 and 2a01:4f8:c015:382f::1, ssh alias `toonbox`. Door container `charter-door:3701`, Caddy container `deploy-caddy-1`, Caddyfile `/opt/toon-relay/deploy/Caddyfile` (read-only single-file bind mount: back up, `cat new > Caddyfile`, never `sed -i`, `docker cp` to `/tmp/Caddyfile`, `caddy reload --config /tmp/Caddyfile`).
- Door security headers and CSP stay exactly as in `deploy/door/Caddy.snippet` today, on every name.
- Landing page: no scripts, no inline `<style>`, no `style=` attributes, no `data:` fonts; fonts from `web/fonts/`.
- Who line: "Built and run by Drew Pierson", linked to `https://x.com/mil_itia`; no company, no TOON link.
- No em dashes in anything that ships. Printable ASCII in new copy where practical.
- Historical files keep their text: `docs/demo.md`, `docs/spike-notes.md`, everything in `docs/superpowers/plans/` and `docs/superpowers/specs/` dated before 2026-11-24, `site/` (Arweave record), `web/privacy.html`.
- Never run the Arweave site-write script for the landing page. The moved notice is the one Arweave write.
- Money: the only pre-approved spend is the Solana network fee for one ANT write (~0.000005 SOL) and one Bazaar rent from `~/keys/bazaar-payer` (0.007 USDC). Anything else, stop and ask Drew.
- npm publish needs Drew: `npx -y npm@latest stage publish`, then Drew runs `npm stage approve` in his own terminal tab.

## Review Focus

- A caller still using `https://charter.mainnet.toonprotocol.dev` (hel1, Edison/OpenHuman homes, old MCP installs) gets identical answers after the Caddy change. Owned by Task 3 (curl checks on the old name).
- The landing page under the door's unchanged CSP renders styled, with fonts, and logs no CSP violation. Owned by Task 1 (static asserts) and Task 4 (browser check).
- A live default that still says the old name slips through the rename (a new file added later, a test fixture that pins it). Owned by Task 2 (guard test).
- `charterhome.dev/index.html`, `/agents`, `/v1/offers` and the 402 on `/v1/rent` work on the apex, not only `/`. Owned by Task 3.
- A 402 from the new name names a `charterhome.dev` resource, so Bazaar indexes the new URL. Owned by Task 6.

---

### Task 1: Landing page as a door page

**Files:**
- Create: `web/home.html`, `web/home.css`, `web/home.test.ts`
- Modify: `scripts/build-web.mjs` (copy `home.html`, `home.css`; update its header comment)

**Interfaces:**
- Produces: the door serves `/home` (extension fallback) and `/home.css`. Task 3's Caddy rewrite targets `/home`.

- [ ] **Step 1: Write the failing test `web/home.test.ts`**

Read `web/home.html` and `web/home.css` from disk and assert:
```ts
assert.doesNotMatch(html, /<style|style=|<script|data:font/i);
assert.match(html, /<link rel="stylesheet" href="home\.css">/);
assert.match(html, /<link rel="canonical" href="https:\/\/charterhome\.dev\/">/);
assert.match(html, /property="og:url" content="https:\/\/charterhome\.dev\/"/);
assert.match(html, /href="https:\/\/charterhome\.dev\/agents"/);
assert.match(html, /href="https:\/\/rent\.charterhome\.dev\/"/);
assert.match(html, /<a href="https:\/\/x\.com\/mil_itia">Drew Pierson<\/a>/);
assert.doesNotMatch(html, /toonprotocol\.dev|ar\.io|Arweave|ArNS|COO|cofounder/i);
assert.doesNotMatch(html + css, /—/); // no em dash
assert.doesNotMatch(css, /data:/);
assert.match(css, /url\("fonts\/ibm-plex-[a-z-]+-\d00-normal\.woff2"\)/);
```
Note: the Proof table rows that say "over TOON" are true history and stay; the `toonprotocol.dev` assert does not touch them.

- [ ] **Step 2: Run it, expect FAIL (files missing)**

Run: `node --test --import tsx web/home.test.ts`

- [ ] **Step 3: Build `web/home.html` and `web/home.css` from `site/index.html`**

Move the `<style>` block to `home.css`; replace each base64 `@font-face` with the matching file in `web/fonts/` (same families/weights as `web/style.css`). Favicon: `<link rel="icon" href="favicon.svg">`. Content edits exactly as the spec's "Landing page" section: all links to the new names, Who line neutral with the X link, footer says it is served from `charterhome.dev` with "updated 2026-11-24", keeps "No scripts, no tracking", links Storefront (`https://rent.charterhome.dev/`) and Code. Add `charterhome.dev` in `<link rel="canonical">`.

- [ ] **Step 4: Add `home.html`, `home.css` to the copy list in `scripts/build-web.mjs`**

- [ ] **Step 5: Run tests, build, and check output**

Run: `npm test && npm run typecheck && npm run build && ls web/dist/home.html web/dist/home.css`
Expected: all pass, both files listed.

- [ ] **Step 6: Commit** `feat(site): landing page served by the door at /home`

### Task 2: Rename the live default to charterhome.dev

**Files:**
- Create: `src/live-urls.test.ts`
- Modify (old name -> `https://charterhome.dev`, `/agents` etc. kept as paths): `src/cli.ts`, `src/host/config.ts`, `src/fund/main.ts`, `src/door/openapi.ts`, `src/door/x402.ts` (both description strings; keep each under 500 chars, the CDP limit), `src/door/x402.test.ts`, `mcp/src/core.ts`, `mcp/src/cli.ts`, `mcp/src/server.test.ts`, `mcp/package.json` (homepage), `mcp/server.json` (websiteUrl), `mcp/README.md`, `jobs/home/x402-rent.mjs`, `jobs/hermes/boot-default.sh`, `jobs/hermes/boot.test.mjs`, `scripts/bazaar-tick.mjs`, `scripts/prove-home-supervision.sh`, `web/agents.html`, `web/llms.txt`, `web/openhuman/SKILL.md`, `plugins/charter/skills/renting-charter-compute/SKILL.md`, `clawhub/charter-compute/SKILL.md`, `deploy/fund/fund.env.example`, `deploy/host/env.example`, `deploy/social/social.env.example` (set the `CHARTER_SITE_URL` example to `https://charterhome.dev`), `deploy/door/docker-compose.yml` (comment), `README.md`, `docs/env.md`, `docs/ops.md`, `docs/deploy-openhuman-home.md`.
- Do not touch: `src/social/config.ts`, `src/social/config.test.ts`, `src/social/replies.test.ts` (they test the toon ban on purpose), and the historical files in Global Constraints.

**Interfaces:**
- Produces: `DEFAULT_DOOR` / `DEFAULT_DOOR_URL` = `'https://charterhome.dev'` in `src/cli.ts`, `src/host/config.ts`, `src/fund/main.ts`, `mcp/src/core.ts`, `jobs/home/x402-rent.mjs`; `AGENTS` = `'https://charterhome.dev/agents'` in `src/door/openapi.ts`.

- [ ] **Step 1: Write the guard test `src/live-urls.test.ts`**

`test('no live file names the old storefront')`: run `git ls-files` (child_process `execFileSync`), drop paths matching the historical list (`^docs/demo\.md$`, `^docs/spike-notes\.md$`, `^docs/superpowers/`, `^site/`, `^web/privacy\.html$`, `^src/social/`) and binary files; read the rest; collect files containing `charter.mainnet.toonprotocol.dev`; `assert.deepEqual(hits, [])`. Exclude `deploy/door/Caddy.snippet` (it keeps the old name as an alias on purpose, Task 3).

- [ ] **Step 2: Update the tests that pin the old default** (`src/door/x402.test.ts:727`, `mcp/src/server.test.ts:329`, `jobs/hermes/boot.test.mjs:196`) to expect `https://charterhome.dev`. Run `npm test` and `(cd mcp && npm test)`: expect the guard and these three to FAIL.

- [ ] **Step 3: Replace the old name in every file listed above.** In prose that explains where things live, say `charterhome.dev` for the API and `rent.charterhome.dev` for the browser storefront.

- [ ] **Step 4: Run** `npm test && npm run typecheck && (cd mcp && npm test && npm run typecheck)`. Expected: PASS, guard reports no hits.

- [ ] **Step 5: Bump versions:** `mcp/package.json` + `mcp/server.json` (both version fields) 0.4.0 -> 0.4.1; `clawhub/charter-compute/SKILL.md` 0.4.0 -> 0.4.1; `plugins/charter/.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` 0.5.0 -> 0.5.1.

- [ ] **Step 6: Commit** `rename: Charter's door is https://charterhome.dev`

### Task 3: DNS and Caddy (live)

**Files:**
- Modify: `deploy/door/Caddy.snippet`

**Interfaces:**
- Consumes: Task 1's `/home` page must be deployed before the apex `/` is useful (Task 4); Caddy can go first, `/` just 404s until then.

- [ ] **Step 1: DNS.** In Porkbun (Drew signed in; the two default parking records `ALIAS charterhome.dev -> pixie.porkbun.com` and `CNAME *.charterhome.dev` deleted by Drew), add TTL 600: `A @ 167.233.221.236`, `AAAA @ 2a01:4f8:c015:382f::1`, `A rent 167.233.221.236`, `AAAA rent 2a01:4f8:c015:382f::1`. Verify: `dig +short A charterhome.dev @1.1.1.1` and the other three return exactly these, and `dig +short CNAME x.charterhome.dev @1.1.1.1` is empty.

- [ ] **Step 2: Rewrite `deploy/door/Caddy.snippet`** as a named snippet plus two sites:
```
(charter_door) {
	encode zstd gzip
	request_body { max_size 64KB }
	header { ...the current six headers, unchanged... }
	reverse_proxy charter-door:3701
}
charterhome.dev {
	@root path /
	rewrite @root /home
	import charter_door
}
rent.charterhome.dev, charter.167-233-221-236.sslip.io, charter.mainnet.toonprotocol.dev {
	import charter_door
}
```
Update the header comment: names, and that `/` on the apex is the landing page.

- [ ] **Step 3: Apply live.** On `toonbox`: back up the Caddyfile (`cp Caddyfile Caddyfile.bak-20261124-precharterhome`), replace the old Charter block with the new text (`cat new > Caddyfile`), `docker exec deploy-caddy-1 caddy validate --config /etc/caddy/Caddyfile` (or the mounted path) first, then `docker cp` + `caddy reload --config /tmp/Caddyfile`.

- [ ] **Step 4: Verify** (wait for certificates):
`for h in charterhome.dev rent.charterhome.dev charter.mainnet.toonprotocol.dev; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h/v1/offers; done` -> all 200.
`curl -sI https://charterhome.dev/agents | grep -i content-security-policy` -> the unchanged CSP.
`curl -s -o /dev/null -w "%{http_code}\n" -X POST https://charterhome.dev/v1/rent` -> 402.
`curl -s https://rent.charterhome.dev/ | grep -c app.js` -> 1 (storefront).
`curl -6 -s -o /dev/null -w "%{http_code}\n" https://charterhome.dev/v1/offers` -> 200.

- [ ] **Step 5: Commit** `deploy: Caddy serves charterhome.dev (landing at /) and rent.charterhome.dev`

### Task 4: Deploy door, fund, hel1

- [ ] **Step 1: Push main** after Tasks 1 to 3 (`git push origin main`).
- [ ] **Step 2: Door.** Per `docs/ops.md` step 3: `cp -a /opt/charter /opt/charter.bak-20261124-precharterhome`, rsync the tree (no `node_modules`, `dist`, `web/dist`, `.git`, `.superpowers`), `docker compose -f /opt/charter/deploy/door/docker-compose.yml up -d --build charter-door`. Do not start `charter-social`.
- [ ] **Step 3: Verify landing.** `curl -s https://charterhome.dev/ | grep -c 'x.com/mil_itia'` -> 1; `curl -s -o /dev/null -w "%{http_code}" https://charterhome.dev/home.css` -> 200; `https://charterhome.dev/llms.txt` names `https://charterhome.dev`. Open `https://charterhome.dev/` in the browser pane, read console: no CSP violation; screenshot for Drew.
- [ ] **Step 4: Fund and hel1.** grep the live env files for the old name (`/root/charter-fund` or the fund env on the box; on hel1 the host env) and set `CHARTER_FUND_DOOR_URL` / `CHARTER_DOOR_URL` to `https://charterhome.dev` where set explicitly (back up each env first). Restart fund; restart hel1's `charter-host` per `docs/ops.md` (check first for opened-but-unstarted leases). Verify: `curl -s https://charterhome.dev/v1/offers` lists hel1's offer, and `/grants` reports the fund.
- [ ] **Step 5: Record** the deploy in `docs/demo.md` as a new dated section (backups, verification output). Commit and push.

### Task 5: Republish packages

- [ ] **Step 1: npm.** `(cd mcp && npm run build && npx -y npm@latest stage publish)`; Drew runs `npm stage approve` in his own terminal tab. Verify: `npm view charter-mcp version` -> 0.4.1, `npm view charter-mcp homepage` -> `https://charterhome.dev/agents`.
- [ ] **Step 2: MCP registry.** Publish `mcp/server.json` 0.4.1 (same tool and login as the 0.4.0 publish on 11-24). Verify via the registry API that `io.github.drew-dot-com/charter` latest is 0.4.1 with the new websiteUrl.
- [ ] **Step 3: ClawHub.** `npx -y clawhub@0.27.0 --no-input skill publish clawhub/charter-compute` (version 0.4.1). Verify it shows as submitted.
- [ ] **Step 4: Plugin** ships via the pushed repo (0.5.1). Verify `.claude-plugin/marketplace.json` on GitHub main shows 0.5.1.

### Task 6: Listings

- [ ] **Step 1: Bazaar.** `BAZAAR_KEY_FILE=~/keys/bazaar-payer CHARTER_DOOR_URL=https://charterhome.dev node scripts/bazaar-tick.mjs --rent`. Before paying, read the 402's `resource` field: it must be `https://charterhome.dev/v1/rent`. Verify settle tx on Base (status 1) and, after indexing, the CDP Bazaar discovery list shows the `charterhome.dev` resource.
- [ ] **Step 2: x402-list.** Start the update at `https://x402-list.com/services/charter/update` in the browser pane with the new URL; it issues a domain-proof token: put it in `web/well-known/x402list.txt`, redeploy the door (Task 4 Step 2 procedure), submit. Their review is out of our hands; record the state.
- [ ] **Step 3: x402scan.** Check whether its Charter entry can be updated to the new URL; if it re-crawls from Bazaar, note that and do nothing else.
- [ ] **Step 4:** Update memory `project_charter_domain.md` with what is live and what awaits third parties.

### Task 7: charter.ar.io moved notice

**Files:**
- Create: `site/moved.html`, `node-artifacts/turbo-upload-solana.mjs` (in `~/src/TOON/node-artifacts`, not the charter repo)
- Modify: `site/receipts.json` (append the upload record)

- [ ] **Step 1: Write `site/moved.html`.** Under 2 KiB, no scripts: title "Charter has moved", one line "Charter has moved to charterhome.dev." linking `https://charterhome.dev/`, `<meta http-equiv="refresh" content="5; url=https://charterhome.dev/">`, `<link rel="canonical" href="https://charterhome.dev/">`. Check: `wc -c` < 102400, no em dash.
- [ ] **Step 2: Write the upload script** `turbo-upload-solana.mjs <file>`: `TurboFactory.authenticated({ privateKey: <bs58 of ~/.config/solana/id.json>, token: 'solana' })`; first `getUploadCosts({ bytes: [size] })` and abort unless the winc cost is `'0'`; then `uploadFile` with tag `Content-Type: text/html`; print the id.
- [ ] **Step 3: Upload** and append `{date, file, bytes, sha256, txid, paid: "free (Turbo under 100 KiB)"}` to `site/receipts.json`. Verify `https://permagate.io/<txid>` serves the page (retry on 404: propagation).
- [ ] **Step 4: Set the ANT.** Dry run first, then live: `ANT_ID=FuwZpApdmM6nJwR5KG2mAz1KFQ3Q9PkLgtgKRbHZ8c6x TX_ID=<txid> node arns-set-record.mjs` (see the script's header for the live flag). Verify the Solana tx confirmed and `https://charter.ar.io/` shows the notice (gateway cache may lag up to the TTL, 900 s).
- [ ] **Step 5: Commit** `site: charter.ar.io now points at a moved notice` and push. Update memory `feedback_charter_site_no_ario.md` (the one exception happened, the date, the txid).
