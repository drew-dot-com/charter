# Plain-SSH homes on charter-host-hel1

Status: draft for Drew's approval, 2026-11-21. Builder check done; Drew answered its three open questions.

## Why

Charter's homes run today on toon2, a Lima VM on Drew's MacBook Air at home. They have no public address:
the only way in is a per-home onion address published by Charter's own anon (`charter-anon`), and the host's
toon node is itself reached by the edge over an onion. Three problems came out of that:

1. **Agents turn it down.** The mystery-shopper agents that looked for Charter on their own named the
   onion-only door as a reason not to rent.
2. **It is flaky.** On 2026-11-21 the first granted home was unreachable for 11 hours while toon2's anon took
   introductions and never completed them; a restart fixed it, and a second restart left it down again for
   over 10 minutes. Paid packets over the onion hop to toon2 have taken 2 to 15 s (10-24).
3. **The Air cannot grow.** 8 GiB across three VMs; toon2 carries 2 home slots.

Drew bought a second server for this: **charter-host-hel1**, Hetzner CPX32, Helsinki, 37.27.86.235, x86_64,
4 shared vCPU, 8 GB RAM (7.6 GiB usable), 150 GB disk, Ubuntu 24.04.5. SSH as root with `~/.ssh/charter_host`
(its own key; the old box's key is not on it).

## Decisions taken with Drew

- **The Air retires as a Charter host.** hel1 becomes the only host, for homes and jobs. toon2 stops serving
  Charter; its edge channel (E63rPn, dry around 11-24) is not refilled.
- **One public port per home** is the way in: `ssh -p <port> tenant@37.27.86.235`. The alternative, one routed
  port 22 (an SSH proxy such as sshpiper picking the home by username), was set aside for now: real new
  software in every login path, and admin SSH would have to move. It can be added later if the next
  mystery-shopper run shows agents failing on blocked ports.
- **Homes keep exiting through anon.** Tenant traffic must not come from hel1's IP, so abuse complaints never
  land on Drew's Hetzner account.
- Price, interval, disk, retention and image list stay as they are (0.007 USDC per hour, 2 GiB, 7 days).
- **toon2 stopped opening homes on 2026-11-21** (Drew's answer to the builder check): `CHARTER_ALLOW_IMAGES`
  dropped `charter-home,charter-hermes` and `CHARTER_MAX_HOMES=0` (env backup
  `~/.config/charter/env.bak-20261121-prenohomes`); jobs still run there. The door's offer now has no home
  block, so grants the judge approves wait for hel1. The two kept home disks on toon2 stay until retirement
  (with homes off, the host does not sweep them).
- **Anyone's terms:** Drew accepts `AgreeToTerms 1` for hel1's anon.
- **Budget (Drew, in principle; each transfer still waits for his go):** about 6 USDC plus a little gas:
  hel1's toon wallet (about 0.001 ETH + 1 USDC on Base, 0.01 SOL + 1 USDC on Solana), the edge-to-hel1
  channel (about 2 USDC on Solana) and hel1's own relay-write channel (about 2 USDC).

## Approaches considered

1. **Mirror toon2 on hel1, one public port per home (chosen).** Same programs and units as toon2
   (charter-host, a toon node, charter-anon, charter-home-net, gVisor), plus a setting that publishes each
   home's existing fixed port on the public address. Small code change; one tenant can never reach another,
   since each home runs its own sshd in its own gVisor sandbox. Cost: some networks block outgoing
   connections to unusual ports.
2. **Mirror toon2, one routed port.** As 1, with an SSH proxy on :22 routing by username. Gets through any
   network that allows SSH; cost is a new security-critical component and moving admin SSH. Deferred.
3. **Containerize the host.** Ruled out: the host needs the machine's loop devices, firewall, docker socket
   and gVisor runtime directly; it would be a rewrite.

## Goals

- A tenant reaches a home on hel1 with plain `ssh -p <port> tenant@37.27.86.235`, from any network that
  allows outbound TCP to that port, within a minute of the open (no publish wait).
- The edge reaches hel1's toon node over https (clearnet), not an onion, so paid packets to the host are fast.
- Everything a tenant runs leaves hel1 through anon, as on toon2.
- The door, the grant fund and the existing clients (charter-mcp, the `charter` CLI, `charter-x402`, the
  `renting-charter-compute` skill) work unchanged against hel1, apart from showing the new address.
- toon2 stops being a Charter host with no paid lease cut short.
- The agent-facing docs say "plain SSH" first.

## Non-goals

- The routed single-port proxy (approach 2).
- Moving any home's disk from toon2. Nothing live is there: the proof home lapsed 11-21 and Edison's old
  home's kept disk expires 11-23. Both are left to expire.
- A domain name for homes. The IP is the address, and `CHARTER_HOME_PUBLIC_HOST` takes only an IPv4 address (docker binds it). A name needs a small later change: bind the IP, show the name.
- Changing prices, the grant fund, or the door's payment paths.

## Anti-goals (would make this a failure even if it works)

- A tenant can reach another home, the host's own ports, the toon node's admin surface, or the machine's
  network directly.
- Any tenant traffic leaves hel1 from its own IP.
- hel1 exposes anything beyond: admin SSH (key only), the home port range, and the toon node's https.
- A paid lease on toon2 is cut short by the switch, or the grant fund pays for a home that cannot be reached.

## The design

### Code (charter repo)

- **A public address setting for the host.** New optional variable, e.g. `CHARTER_HOME_PUBLIC_HOST`
  (an IPv4 address; a name is a later change, see Non-goals). When set:
  - the home container's sshd port is bound on that public address instead of `127.0.0.1`
    (today `-p 127.0.0.1:${rec.port}:2222` in `src/host/runner.ts`);
  - `homeAccess(homeId)` returns `{ ssh: { host: <public host>, port: rec.port, user: 'tenant' } }` at once,
    with no wait on anon;
  - the onion is not published by default (see next point).
  When unset, behaviour is exactly today's (toon2 keeps working until it is stopped).
- **Onion optional, off by default on hel1.** A home's onion is published only when the host is configured
  for it (e.g. `CHARTER_HOME_ONION=1`, or simply leaving `CHARTER_ANON_HS_DIR` unset turns it off; builder's
  call which). Reason for off: every onion publish sends anon a HUP, which resets its circuits and stalls
  every home's outbound traffic (seen on toon2, commit 712a185 avoided needless HUPs). When on, the access
  record carries the onion as a second entry next to the public one; the shape of that extra field is the
  builder's, and must stay backward compatible (existing readers use `access.ssh`).
- **Home ports.** Ports already come from `HOME_PORT_BASE = 22000` and stay fixed per home across re-opens.
  hel1 must keep every home inside the firewall's range (22000 to 22099); the builder makes sure the
  allocator cannot hand out a port outside it, or makes the range a setting.
- **The home watch.** `charter-home-watch.sh`'s onion probe becomes a probe of whatever address the lease
  publishes. Claude's call on how the outside view learns which homes exist, with no new trust link and no
  new port on hel1: the Hetzner box's ops check reads live homes from the door's own ledger (every
  door-opened lease, grants included) and their `access` from the door's free `GET /v1/leases/:id`, then
  reads the SSH banner on `host:port`. Homes opened directly over TOON (none by third parties so far) are
  covered by hel1's own watch probing its public address from inside. Lapse and late-tick checks stay in
  the host-side watch on hel1. Same rule as today: alert after 3 misses in a row, no automatic restarts.
- **Clients that read `access` today assume an onion** (`sshLine` in `src/cli.ts` ignores the port and always
  prints the onion `ProxyCommand`; `mcp/src/core.ts` says the host is an onion address). They must print
  `ssh -p <port> tenant@<host>` for a public address and keep the onion line for an onion one. Claude's call
  on timing: updated clients and docs are released before hel1 takes its first outside lease, so no agent is
  ever shown a command that fails.
- **Docs and clients.** `web/llms.txt`, `web/agents.html`, `web/index.html`, `README.md`, `docs/env.md`,
  `plugins/charter/skills/renting-charter-compute/SKILL.md`, and the text in `mcp/src` and `mcp/README.md`
  describe plain SSH first (`ssh -p <port> tenant@<host>`), with the onion as an option only where a host
  publishes one. charter-mcp gets a version bump; publishing it needs Drew's approval as always.

### hel1 setup (ops, mostly Claude; Drew's steps marked)

- Docker, gVisor (`runsc`, registered with docker; `CHARTER_RUNTIME=runsc` for every job, since homes and
  `charter-job-python` run renters' code), Node 22, charter-host as a systemd user service, the
  `charter-home` network and firewall unit, `charter-anon` for home egress (its SOCKS/HTTP/DNS on the home
  bridge only, exactly as `deploy/host/install-home.sh` sets up on toon2).
- **anon on hel1** (Claude's call): a clearnet node runs no overlay, so `install-home.sh` cannot copy the anon
  binary and GeoIP from it. hel1 installs Anyone's pinned release itself. Fetch jobs
  (`charter-job-fetch`, whose egress today goes through the node's anon via `charter-socks-connect`) use
  `charter-anon` too, on the home bridge's SOCKS port; the firewall change that allows it is the builder's.
  One anon for homes and jobs is fine at this size. Its anonrc carries `AgreeToTerms 1`, which Drew approved.
- Images built on hel1 (x86): `charter-job-fetch`, `charter-job-python`, `charter-home`, `charter-hermes`.
- **A toon node in clearnet mode, pinned to toon 0.3.0** (Claude's call: the version toon2 runs, whose
  embedded connector 18da529 is proven against the edge; the edge is pinned to `rust-2026.09.29.1-mfee` and
  connectors from 11.02.1 on refuse its vouchers, so a fresh `toon up` must not pull a newer connector).
  `toon_cli` has had `--clearnet <host>` since 0.1.0; if 0.3.0 cannot run clearnet, the fallback is the
  hidden mode toon2 uses (homes still get plain SSH; only the edge-to-host hop stays onion). Behind TLS, since plaintext
  peering is refused (CF-18). A Caddy front with an sslip.io name (`37-27-86-235.sslip.io`, as the old box
  did before it had names) is enough. Its wallet needs the funds `toon up` asks for (Drew).
- **Peering (Drew's go, Drew's money):** the edge peers to hel1's node over https with a Solana channel
  funded from the edge, the same operator write used for toon2 and Edison (`POST /peers` with
  `"chain":"solana"` and a deposit), and the edge routes for charter-open, charter-tick and charter-status
  point at hel1.
- **Door:** `CHARTER_DOOR_HOSTS` swaps toon2's `<pubkey>=<ilpBase>` for hel1's (step 4 below).
- **hel1's own payer channel:** the host pays for its offer writes to the relay (about 1000 units a write),
  so it needs its own funded channel to the edge, like toon2's `8oBnwH4u`, and the box's ops check moves its
  `HOST_CHANNEL_ID` to it.
- **Firewall on hel1:** inbound only admin SSH 22 (key only, as Hetzner set it up), 22000 to 22099 tcp for
  homes, 80/443 for the node's TLS. Home containers cannot reach the host's own ports or start connections
  anywhere except anon. Known break: today's `DOCKER-USER -i br-… -j DROP` rule drops the *replies* of a
  publicly published home port, because public traffic goes through FORWARD (loopback binding never did).
  The rules need an established/related exception for traffic answering an inbound connection to the home's
  sshd, while still dropping every connection a home starts itself.
- **Capacity to start:** `CHARTER_MAX_HOMES=4`, `CHARTER_MAX_LEASES=6`; raise after watching real use.

### Cut-over order

1. **Done 2026-11-21: toon2 stopped opening homes** (its home slots went to 0; jobs keep running). Approved grants then wait,
   as designed, in `approved_waiting` (up to 14 days) instead of landing on toon2, whose edge channel runs
   dry around 11-24. `CHARTER_MAX_LEASES=0` is refused by today's config parser, so the full stop at step 4
   uses stopping charter-host rather than a zero. Approved grants wait at most 14 days, so hel1 should be live
  well inside that.
2. hel1 fully set up and proven first-party end to end: a home opened through the door, `ssh -p` from
   outside, egress through anon, two ticks paid, a host restart that leaves it alone, a fetch job.
3. Updated CLI, charter-mcp (Drew approves the publish) and docs ship.
4. The door switches hosts in one change: hel1 in, toon2 out. No period with both listed (the door picks the
   cheapest offer and breaks ties by id, so two equal hosts would not share leases anyway). charter-host on
   toon2 stops; the `toon` VM (Edison's node) is not touched. Waiting grants open on hel1.
5. The success test: a fresh mystery-shopper run against the live docs.

## Constraints

- Mainnet only; no test infrastructure.
- Plaintext peering is refused (CF-18): the node needs TLS.
- "ILP routes, x402 settles": hel1 is paid over TOON like toon2; nothing here changes settlement.
- Drew does secrets, payments and signups; every money move and every operator write to the edge waits for
  his go.
- No em dashes in anything that ships.

## Left to the builder

- Variable names and the exact shape of the optional onion entry in `access`.
- Firewall tooling (Hetzner Cloud Firewall, nftables or ufw), as long as the inbound list above holds.
- Where the outside SSH probe lives, if not the Hetzner box's ops check.
- How the port range is enforced.
- The install script layout for hel1 (a new `deploy/host` script or extending `install-home.sh`).
