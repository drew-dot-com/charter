# Charter on its own domain: charterhome.dev

Date: 2026-11-24. Status: approved by Drew in conversation (option B, neutral bio).

## Intent

Charter's public face moves to a domain Drew owns, `charterhome.dev` (bought
2026-11-24 at Porkbun, Drew's account, expires 2027-11-24), and becomes the one
place Charter lives. Two things it leaves behind:

- `charter.ar.io`, the landing page as a single Arweave file under an ArNS name.
  Drew no longer wants ARIO/Arweave for Charter. The ArNS lease runs to
  2027-10-20, so until then it shows a "moved" notice.
- `charter.mainnet.toonprotocol.dev`, the storefront name, which is an A record
  in Jonathan's DNS zone. Charter has left TOON (cut-over 2026-11-23) and should
  not depend on another person's zone. The `charter-social` service also refuses
  any site URL containing "toon", so it cannot start until this lands.

## Goals

1. `https://charterhome.dev/` serves the landing page (today's `site/index.html`
   content, updated), as an ordinary web page from the door's box.
2. `https://charterhome.dev` is the canonical base URL for agents: every door
   path (`/agents`, `/llms.txt`, `/openapi.json`, `/v1/*`, `/grants`,
   `/openhuman/SKILL.md`, `/.well-known/*`) works on it.
3. `https://rent.charterhome.dev/` is the browser storefront (the door's current
   `/` page) and also serves every door path.
4. Every default, doc, package and listing that names the old storefront names
   the new one.
5. `charter.ar.io` shows a short notice that Charter moved, linking
   `https://charterhome.dev/`.

## Non-goals

- No change to door behaviour, pricing, payment or host protocol beyond URLs.
- No new hosting provider, CDN, or static host. Same box, same Caddy.
- No redesign of the landing page's look. Content changes only where facts
  changed (see below).
- No Arweave republish of the landing page, ever. The moved notice is the one
  exception, and it is a separate tiny file.

## Anti-goals (a failure even if it works)

- Breaking any existing caller: a host, Edison/OpenHuman home, MCP client or
  scanner still using `charter.mainnet.toonprotocol.dev` must keep working
  during the move. The old names stay served by the same door, unchanged, until
  Drew decides to retire them.
- Loosening the door's security headers for the API or storefront to make the
  landing page fit.
- Naming TOON in Drew's bio, or anything that hints at Drew leaving TOON (the
  exit plan is private).
- Em dashes in anything that ships.

## Constraints (facts from the live system)

- The door runs on the box 167.233.221.236 (IPv6 2a01:4f8:c015:382f::/64),
  container `charter-door` on port 3701, behind the toon-relay Caddy
  (`deploy-caddy-1`). The Caddyfile is a read-only single-file bind mount at
  `/opt/toon-relay/deploy/Caddyfile`: back it up, write in place
  (`cat new > Caddyfile`, never `sed -i`), `docker cp` to
  `deploy-caddy-1:/tmp/Caddyfile`, `caddy reload --config /tmp/Caddyfile`.
  `deploy/door/Caddy.snippet` is the repo copy of the block.
- The door already serves static files from `web/` with extension fallback
  (`/agents` serves `agents.html`).
- The door's CSP is strict: `style-src 'self'`, `font-src 'self'`,
  `script-src 'self'`. Today's `site/index.html` has one inline `<style>` block
  and base64 `data:` fonts, so it would be blocked as-is. The door already
  self-hosts the same IBM Plex faces in `web/fonts/` and loads them from
  `web/style.css`.
- `.dev` is HSTS-preloaded: HTTPS only. Caddy gets certificates by ACME on its
  own once DNS resolves.
- DNS is at Porkbun (Drew's account). Records are set through the Porkbun web
  UI; Drew signs in, Claude drives.
- x402 resource URLs follow the request's host (Caddy passes `Host` through), so
  calls to the new name produce resources on the new name. CDP's Bazaar
  re-indexes a resource after a paid call to it.
- `web/well-known/x402list.txt` is x402-list's domain proof for the old name.
- Publishing `charter-mcp` to npm needs Drew's passkey
  (`npx -y npm@latest stage publish`, then Drew runs `npm stage approve` in his
  own terminal tab). ClawHub: `npx -y clawhub@0.27.0 --no-input skill publish`.
  MCP registry: `io.github.drew-dot-com/charter`.
- The ArNS name `charter.ar.io` is controlled by ANT
  `FuwZpApdmM6nJwR5KG2mAz1KFQ3Q9PkLgtgKRbHZ8c6x`, owned by Drew's local Solana
  wallet `DQCzjWps…`. Earlier versions were paid over a TOON channel that is now
  retired. Turbo stores uploads under 100 KiB free.

## Approaches considered

- **A. Landing page only on charterhome.dev**, storefront stays on the toon
  name. Smallest, but leaves Charter in Jonathan's zone and keeps
  `charter-social` blocked. Rejected by Drew.
- **B. Everything on charterhome.dev (chosen).** Landing at the apex, storefront
  at `rent.`, all door paths on both, old names kept as aliases. Ends the
  dependency on Jonathan's zone and unblocks `charter-social`.
- **Static host (Cloudflare Pages, GitHub Pages) for the landing page.**
  Rejected: a second provider and account for one file, while the box already
  serves HTTPS with the right headers.

## Design

### Names and routing (Caddy)

One door, four names. All proxy to `charter-door:3701` with the current headers.

| name | `/` | every other path |
| --- | --- | --- |
| `charterhome.dev` | landing page | door |
| `rent.charterhome.dev` | storefront (door's `/`) | door |
| `charter.mainnet.toonprotocol.dev` | storefront (unchanged) | door |
| `charter.167-233-221-236.sslip.io` | storefront (unchanged) | door |

On `charterhome.dev`, an exact-path match for `/` is rewritten to the landing
page file (for example `/home`), then proxied. Nothing else is rewritten.
`www.charterhome.dev` is not created. The old names stay as aliases with no
redirect in this work; retiring them is Drew's later call.

### Landing page

`site/index.html` moves into the door's `web/` (for example `web/home.html`)
and becomes an ordinary door page. It must pass the existing CSP unchanged:
its CSS goes into a stylesheet file served by the door, and its fonts use the
files already in `web/fonts/` instead of base64. Still no scripts.

Content changes, and only these:

- All links and the canonical/`og:url` point at `https://charterhome.dev/`;
  "For agents" -> `https://charterhome.dev/agents`; "Rent in the browser" ->
  `https://rent.charterhome.dev/`; MCP/x402 and grant curl examples use
  `https://charterhome.dev`.
- **Who:** "Built and run by Drew Pierson", linking `https://x.com/mil_itia`.
  No company named, no TOON node link. Keep "Charter is its own repository
  under its own license."
- **Footer:** drop the Arweave/ArNS sentence. Say it is served from
  `charterhome.dev`, with the updated date; keep "No scripts, no tracking";
  links Storefront (`rent.`) and Code.
- **Proof:** the historical rows that say "over TOON" stay. They are true
  receipts.

`site/index.html` and `site/receipts.json` remain in the repo as the record of
the Arweave versions; the `site/` page is no longer published.

### Rename across the repo

Every `charter.mainnet.toonprotocol.dev` default and doc becomes
`charterhome.dev` (about 88 references in 40 files on 2026-11-24): the
`DEFAULT_DOOR`/`DEFAULT_DOOR_URL` constants (`src/cli.ts`,
`src/host/config.ts`, `src/fund/main.ts`, `mcp/src/core.ts`,
`jobs/home/x402-rent.mjs`, `jobs/hermes/boot-default.sh`,
`scripts/bazaar-tick.mjs`), `src/door/openapi.ts`, the two Bazaar
description strings in `src/door/x402.ts`, `web/agents.html`,
`web/llms.txt`, `web/openhuman/SKILL.md`, the plugin and ClawHub skills,
`mcp/package.json` + `mcp/server.json` homepage/websiteUrl, env examples,
`README.md`, `docs/env.md`, `docs/ops.md`. Historical records (`docs/demo.md`,
old plans/specs, spike notes) are left as written. Tests that pin the old
default move with it; the `charter-social` test that rejects a toon URL stays.

### DNS (Porkbun)

`A charterhome.dev -> 167.233.221.236`, `A rent.charterhome.dev ->
167.233.221.236`, plus AAAA records only if the door's Caddy already answers
on the box's IPv6 (verify first; skip otherwise). Remove any Porkbun default
parking records that conflict. TTL 600.

### Deploy order

1. DNS records, then wait until both names resolve.
2. Caddy block updated live (backup first), certificates issued; check `/`,
   `/agents`, `/llms.txt`, `/v1/offers` on both new names and the old name.
3. Door redeployed from the renamed main (landing page and docs live).
4. Fund and hel1 host config: any explicit `CHARTER_DOOR_URL` moved to
   `https://charterhome.dev`; restart; confirm hel1 still registered and listed.
5. Republish: `charter-mcp` (npm, Drew's passkey), MCP registry, ClawHub, the
   Claude plugin via the pushed repo.
6. Listings: one paid rent on `https://charterhome.dev/v1/rent` so Bazaar
   indexes the new resource; x402-list update with a new domain proof
   (reviewed by them); x402scan updated if it allows.
7. `charter.ar.io` moved notice (below).

### charter.ar.io moved notice

A one-screen HTML page, under 100 KiB, no scripts: "Charter has moved to
charterhome.dev" with a link, plus `<meta http-equiv="refresh">` to
`https://charterhome.dev/` after a few seconds. Uploaded through Turbo's free
tier signed by the ANT owner's Solana wallet, then the ANT's base record set to
the new transaction id. Verify through permagate.io and `charter.ar.io` itself.
Drew pre-approved (11-24) the Solana network fee for the ANT write (about
0.000005 SOL; wallet held 0.0315 SOL), signed from the local keypair with
`node-artifacts/arns-set-record.mjs`. If the upload or the ANT write needs
anything else that costs money or opens Drew's personal wallet in a browser,
stop and ask.

## Left to the builder

- File names for the landing page and its stylesheet, and the Caddy matcher
  syntax.
- Whether the door needs any code change to serve the landing page at all, or
  Caddy's rewrite is enough.
- Exact list of files whose references are historical and stay.
- Wording of the moved notice and the footer date.

## Done means

- `curl -sI https://charterhome.dev/` and `https://rent.charterhome.dev/` answer
  200 with the door's security headers; the landing page renders with no CSP
  violations; `charterhome.dev/v1/rent` answers 402 to a bare call.
- The old storefront name still answers exactly as before.
- No `charter.mainnet.toonprotocol.dev` left in live defaults, served pages,
  npm, MCP registry or ClawHub.
- hel1 is listed in `/v1/offers` after the change.
- A paid rent on the new name settles on Base.
- `charter.ar.io` shows the moved notice.
