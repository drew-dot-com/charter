# Storefront redesign: design

Date: 2026-10-27. Drew asked for Charter to look like the product it is pitched as, and told me to
proceed on my own judgment. The calls below are mine unless marked as his.

## Intent

A VC who clicks "Rent a machine" on the landing should land on a page that looks deliberate, shows
what is happening while a lease runs, and makes the one-signature channel visible. Nothing here
changes what the door or the host do with money; it changes what the page shows and adds two
read-only facts to the door's API.

## Goals

- The storefront and the landing look like one product, in the TOON brand's palette and type
  (Paper, Ink, Wire, Settlement gold; IBM Plex Sans, Plex Sans Condensed, Plex Mono), self-hosted.
- The lease page tells the renter what happened and what happens next: a timeline of observed
  events, the current interval as a countdown, the paid-through time, the on-chain links as they
  land, and the renter's channel (deposited, owed, coming back).
- The home page reads as a marketplace with honest numbers: per host, leases served and the last
  one; a recent-leases list with payer and landing links, from the door's own ledger.
- Loading, empty and error states are designed, not bare sentences.

## Non-goals

- No framework, no router library, no CSS build: the page stays vanilla TypeScript bundled by
  esbuild, with one stylesheet.
- No new payment behaviour. Tick timing (half-interval lead) stays; the page explains it instead.
- No fake supply: one host shows as one host.
- No change to the landing's copy beyond what the domain session owns.

## Anti-goals

- Anything the brand bans: gradients, shadows, glow, blue links, hype words, emoji, em dashes.
- A number the ledger cannot back. Every stat on the page comes from the door's ledger or the
  lease status.

## Constraints

- Brand rules from `toon-protocol/brand` (read 2026-10-27): Paper `#f3efe6` light background, Ink
  `#2b2f36` text, Night `#1c1f24` dark background, Wire `#6b6f76` lines and secondary labels, gold
  `#c9a24a` as a fill only, gold text `#7d5f17` for prices and links on Paper, state greens
  `#2f7a4c` / `#6cc08a`, errors `#b23b32` / `#e07067`. CTAs: Ink fill, Paper text, square corners.
  Labels and chips: Plex Mono 500, uppercase, +6% tracking, Wire-outlined. Sentence case everywhere.
- A built-on-TOON app may not use the TOON symbol as its logo; it may say "runs on TOON".
- CSP from the domain session: `script-src 'self'`, `style-src 'self'`, `font-src 'self'`,
  `img-src 'self' data:`. So fonts are files under `web/fonts/` and no inline styles or scripts.
- Lease ids are capabilities (anyone with one can read the output), so the recent-leases list
  shows a short prefix and never links to the lease page.

## What is built

### Door API (`src/door/server.ts`)

- `GET /v1/offers`: each offer gains `leases` (ledger leases on this host's pubkey with at least one
  renter-paid tick) and `lastLeaseAt` (epoch ms of the newest such lease, or absent).
- `GET /v1/recent`: the newest 12 ledger leases with at least one renter-paid tick, newest first:
  `{ id: first 8 hex, createdAt, ticks, payer?, state?, landing? }`. State and landing come from
  the door's in-memory status cache only, never a paid host read. CORS like the other GETs.

### Page modules (`web/`)

- `style.css`: the token set above, light and dark, Plex `@font-face` rules, components: header,
  chip, card, button, facts, progress, timeline, panel (Night terminal), table, skeleton.
- `timeline.ts` (pure, tested): `observe(events, lease, now)` appends events for each transition
  it sees (opened, created, interval n paid, started, finished, output, landed, closed with reason)
  and seeds "joined with n intervals paid" when the page starts mid-lease.
- `channel.ts`: `readChannels(address, store)` returns the stored channel contexts, and
  `channelSummary(contexts)` folds them into deposited, owed (charged minus claimed) and coming
  back (the rest), as bigint micro-USDC; tested.
- `format.ts`: `shortHex`, `clock` (hh:mm:ss local), `ago`, `offerFreshness` (published / expires
  from `expiresAt` and the 30 minute offer lifetime); tested.
- `app.ts`: home and lease pages rebuilt on the components above. Text goes in as text, as before.

### Build

`scripts/build-web.mjs` copies `web/fonts/` into `web/dist/fonts/`.

## Left to the builder

Exact spacing, the skeleton shapes, and the wording of close reasons, within the brand's voice.
