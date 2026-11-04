# The home image: a box an agent can live in

Status: Claude's design, 2026-11-04. Drew asked for the design and skipped the questions ("You
choose"), so every choice below is Claude's call unless it says Drew's. Not approved yet. Nothing is
built until Drew approves this document.

## Intent

Charter sells an hour of a sandboxed 1 CPU / 1 GiB container for 0.007 USDC, about 5 USDC for 30
days, a price chosen so a model weighing it against a 5 EUR VPS says yes. Today that price buys
nothing to live in: the fetch job and the python job both exit when their work is done, the python
job has no network, and no job keeps a byte once its container is removed. The agents page says so
honestly ("an hour of sandboxed compute at a time, not yet a server to live in").

Drew's decision of 2026-11-02 is that Charter's app is **an agent's home**: an agent rents a box,
pays for it from its own wallet, and lives in it with no signup. The order agreed is price (done
11-04), then Edison off the Air onto a Charter box it pays for, then a "Hermes in a box" image, then
a slop.cash rebalancer. The point of the first tenant is the mesh, not the hosting: a tenant funds
one channel to Drew's edge and pays many sellers from it (rent, per-fetch data, LADING storage, the
paid relay, anything on Jonathan's node a hop away). The milestone is the first real two-hop
payment: Edison, living on Charter, paying for something on Jonathan's node.

This design adds the third rentable job, `charter-home`: a box with outbound network, a disk that
outlives the container, and exactly one way in. It changes how a lease behaves only where a home
differs from a job: a home does not end when a process exits, and it survives a host restart.

## Goals

- A tenant with a wallet and an SSH key gets a box in one open and one tick, and is inside it
  within a few minutes, over the same hidden network the host itself hides behind.
- The box reaches the internet, including its model provider, its chat platforms, Drew's edge
  connector and anything behind it, and reaches nothing on the host's LAN or the host itself.
- The tenant's disk survives the container, a host restart, a lapsed lease and a re-open on the
  same key, and is deleted only after a stated, free retention period.
- A `charter-host` restart does not kill a home. The box is put back on the same disk and the lease
  keeps running; the paid time runs through the outage and nothing is refunded.
- A tenant process inside the box can pay the box's own rent, so the first tenant can be
  self-paying with no help from the Air.
- Everything the agents page, llms.txt and the skill say about the home is true on the live host
  the day it ships, including the limits.

## Non-goals

- A "Hermes in a box" image with Hermes preinstalled. This design gives a bare box with the tools
  to install Hermes over SSH; the packaged image is the next step and will reuse everything here.
- Paid storage, storage tiers, or a disk larger than the fixed 2 GiB. One box, one size.
- Public inbound (a public IP, a domain, port forwards). The only way in is SSH over an onion
  address. A tenant that needs to serve the public runs a reverse tunnel out of the box to a
  rendezvous it owns; that is the tenant's business, not Charter's.
- A second host or moving the host off toon2. The uptime section says what toon2 can promise.
- Any change to the price, the interval, the door's fee or the open and status prices.
- A browser storefront flow built for the home. The door and the agent docs are the front door; the
  storefront grows only a Home choice (SSH keys) and shows the access line on the lease page.

## Anti-goals

- A box whose egress reveals the host's home IP. The fetch job hides it today; the home must not
  undo that. A box that reaches the internet directly is a failure even if the tenant is happy.
- A way in that is also a way into the host: no shared docker socket, no host paths, no reachable
  host service, nothing the operator would not hand a stranger.
- Any copy that calls the box a server with uptime, backups or support. It is a box on a laptop at
  home, and the docs say so.
- The host holding a tenant secret it does not need. Secrets go in over SSH, never through the
  door, the open packet or the lease status.

## Constraints

- The host is `toon2`, a Lima VM (vz, aarch64) on Drew's MacBook Air: 4 CPUs, 3 GiB, a 20 GiB disk
  with about 6.8 GiB free on 2026-11-04 (ext4), Docker 29 with `runc` and `runsc`, at home behind
  an Anyone onion address. The user has passwordless sudo. `CHARTER_MAX_LEASES=2`; each lease is
  one container capped at 1 CPU and 1 GiB.
- Jobs run with `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a pids cap, and
  the `runsc` runtime (gVisor). The home keeps all of that.
- The node's own Anyone client (`anon` 0.4.10.2, run by `toon up`) listens on a loopback SOCKS port
  that moves at every `toon up`; `charter-socks.service` relays docker0:9150 to it for the fetch job.
- A tenant pays over TOON: today with the `toon` binary (the skill, Edison's node in the `toon` VM)
  or through the door's x402 endpoint with USDC on Base. The door itself pays the host with the
  `@toon-protocol/client` library (`src/payer.ts`), which needs no toon node: a key, a channel to
  Drew's edge connector and HTTPS.
- A lease today: `booting` (container created) to `awaiting_first_tick` to `running` (tick 0 paid,
  container started) to `done` (the container exited) or `closed` (`missed_tick`, `boot_failed`,
  `host_restart`, `busy`, `max_intervals`). `reconcile` at host boot closes every lease whose
  container is not running. `windowTick` runs every second.
- No em dashes in anything written to disk. Agents are the audience; copy is honest and never baits.
  Claude never moves Drew's funds. Mainnet only.

## The design

### One image, a few lease rules of its own (Claude's call)

The home is a third job image, `charter-home`, with a `JobProfile` in `src/host/runner.ts` like the
other two, and it goes through the same open, tick and status apps at the same prices. It is not a
new kind of lease on the wire: an agent that can rent the python job can rent a home with one
different body. What differs is a small set of rules keyed on the image, kept in `src/lease.ts` as
`isHome(lease)`:

| | fetch and python | home |
| --- | --- | --- |
| container exits | lease becomes `done`, output is read | container is restarted by docker; the lease stays `running` |
| `charter-host` restarts | lease closed `host_restart` | container found running is kept; one not running is re-created on the same disk and started; `restarts` counts it |
| close (missed tick, max intervals) | container removed, `/out` kept as output | container removed, disk and onion kept for the retention period |
| open body | `urls` or `python.script` | `home.sshKeys` |
| status | `outputParts` | `access` (onion host, port, user), `restarts`, `homeId` |

Why one image and not a new lease kind: the three apps, the door, the skill, the storefront and the
Bazaar listing all know one shape of lease, and that shape already has what a home needs (a paid
clock, a start on tick 0, a close on a missed tick). A new kind would double every surface for one
difference, "exit is not done", that fits in a predicate.

### What is in the box

`jobs/home/Dockerfile`, Debian bookworm-slim, arm64 on toon2, built on the host like the other two:

- `openssh-server`, `python3`, `python3-venv`, `python3-pip`, `uv`, Node 22 (the official tarball),
  `git`, `curl`, `jq`, `rsync`, `tmux`, `ca-certificates`, `procps`. No compiler. About 500 MB.
  Enough to install Hermes (which needs Python 3.11+ and `uv`) and the charter tenant CLI (Node 22).
- One unprivileged user, `tenant`, uid 10001. There is no root in the box: `sshd` runs as `tenant`
  too (OpenSSH runs unprivileged and then logs in only its own user), so `--cap-drop ALL` and
  `no-new-privileges` hold. `sshd` listens on 2222 inside the container.
- `/home/tenant` is the persistent disk (below). The root filesystem is read-only; `/tmp` and
  `/run` are tmpfs (`/tmp` capped at 256 MiB).
- The entrypoint `home.sh`, run as `tenant` at every start: writes `~/.ssh/authorized_keys` from
  the `SSH_KEYS` arg (the key set is the home's identity, below, so the file is always exactly
  those keys; a key added from inside the box is gone at the next start), generates SSH host keys
  into `~/.ssh/host/` once (they persist with the disk, so the box's fingerprint is stable across
  restarts and leases), runs `~/.charter/boot.sh` in the background if it exists (output to
  `~/.charter/boot.log`), then runs `sshd -D -e`. `boot.sh` is how a tenant makes its agent come
  back after a restart.
- Environment inside the box: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY=socks5h://…`, `NO_PROXY`
  and `NODE_USE_ENV_PROXY=1` for the egress below; `CHARTER_LEASE_ID`, `CHARTER_HOME_ID`,
  `CHARTER_OFFER_JSON` (the host's published offer, which holds everything a payer needs: `ilpBase`,
  `sealKey`, `sealUrl`, the prices and the interval, so nothing in the box has to read the relay),
  `CHARTER_CONNECTOR_URL` (where the box's own payer sends packets, below), and
  `CHARTER_PAID_THROUGH_FILE` naming a file the host rewrites on every tick (so a process in the
  box can see its own clock without a paid status read). The file lives in a small host directory
  bind-mounted read-only at `/charter`, since the root filesystem is read-only and the disk is the
  tenant's.
- Limits: 1 CPU, 1 GiB, `--pids-limit 512` (a gateway, a shell and a few tools; the python job's
  256 is too tight for an agent), `--restart unless-stopped`.

### The way in: SSH over an onion address (Claude's call)

Charter runs its own Anyone client in toon2, `charter-anon.service`, from the same `anon` binary
the node ships, with its own `anonrc`. It is a system unit running as the host's user with
`AmbientCapabilities=CAP_NET_BIND_SERVICE` (a user unit cannot bind the DNS port), installed by the
same root step as the firewall unit below. It does three things for the host:

1. **One onion service per home.** The host writes `hs.d/<homeId>.conf` with `HiddenServiceDir
   <dataDir>/homes/<homeId>/hs` and `HiddenServicePort 22 127.0.0.1:<port>` and sends anon a HUP;
   the `anonrc` has `%include` on that directory. The container publishes its 2222 on
   `127.0.0.1:<port>` only (22000 upward, one per home). The onion hostname appears in the service
   directory within a minute of the first publish and is returned in the lease status as
   `access: { ssh: { host: "<56 chars>.anyone", port: 22, user: "tenant" } }`; until then
   `access` is `null` and the tenant polls. The service keys live beside the disk, so the same home
   has the same onion address every time it is opened.
2. **A SOCKS and an HTTP CONNECT proxy for the box** (below).
3. **A DNS port for the box**, so names resolve over the Anyone network and never through the Air's
   resolver.

The tenant connects with any Anyone client (a toon node has one): `ssh -o ProxyCommand="nc -x
127.0.0.1:<socks> %h %p" tenant@<onion>.anyone`. The skill and the agents page give that line and
say plainly that a tenant without an Anyone client cannot reach its box. There is no clearnet way
in and no way in for the host: the operator can enter any container on the machine with `docker
exec`, and the docs say that too.

Why SSH and not a paid exec over TOON or a reverse tunnel: an agent moving in needs to copy files,
install software and keep a session, which is SSH's job; a paid exec per command would make every
`apt` line a packet; a reverse tunnel needs the tenant to own a public endpoint, and an agent that
is renting its first home has none. An exec over TOON can come later as a second door for agents
with no Anyone client; it is not needed for Edison.

Why Charter's own anon and not the node's: the node's SOCKS port moves on every `toon up`, its
config is owned by `toon`, and adding hidden services to it means editing a file another program
rewrites. One more `anon` costs about 60 MB of toon2's memory and nothing else.

### Egress: everything through the Anyone network, nothing direct (Claude's call)

The box is attached to a user-defined bridge, `charter-home`, with gateway `172.19.0.1`. The host's
`anon` binds `SocksPort 172.19.0.1:9050`, `HTTPTunnelPort 172.19.0.1:9080` (anon's own HTTP CONNECT
proxy, so no third proxy program) and `DNSPort 172.19.0.1:53`. A root-installed unit
`charter-home-net.service` creates the network if missing and installs two firewall rules at boot:

- `DOCKER-USER`: forwarded traffic from `charter-home` to anywhere is dropped. The box cannot reach
  the internet, the LAN, docker0 or any other container directly.
- `INPUT`: traffic from `charter-home` to the host is dropped except TCP 9050 and 9080 and UDP/TCP
  53 on the gateway, and replies on established connections (the published SSH port arrives
  through docker's proxy and must answer). The box cannot reach the VM's sshd, the toon node or
  anything else on toon2. The subnet is chosen at install to miss docker0 and the toon node's own
  compose network.

The container runs with `--dns 172.19.0.1`, so docker's embedded resolver forwards to anon and the
Air's resolver never sees the box's lookups. Programs that honour `HTTPS_PROXY` (curl, pip, uv, git,
npm, Python requests and httpx) work as they are; programs that honour `ALL_PROXY` get SOCKS with
remote DNS; anything that opens a raw socket to the internet fails, and the docs say so. Node's
`fetch` ignores the proxy variables unless told (`NODE_USE_ENV_PROXY=1` on recent Node, or an
`EnvHttpProxyAgent`); the box sets the variable and the docs name it.

Why not direct egress with the proxy offered as an option: a box that can reach the internet
directly leaks the Air's home address to every service the tenant talks to, which breaks the one
thing the hidden host promises. Why not an internal docker network: docker does not publish ports
on internal networks, and the onion needs the published SSH port.

Honest costs: an Anyone circuit adds seconds of latency and exits are shared, so a model provider or
a chat platform can rate-limit or refuse an exit. The fetch job has lived with this since 10-05.
The agents page says: "slow, hidden, sometimes refused by a service that dislikes shared exits".

### The disk: 2 GiB, keyed by the tenant's keys, kept 7 days free (Claude's call)

The disk is an ext4 image file, `<dataDir>/homes/<homeId>/disk.img`, 2 GiB, sparse, made with
`truncate` and `mkfs.ext4` (no root needed), and handed to docker as a named volume
`charter-home-<homeId>` through the `local` driver (`type=ext4`, `device=<file>`, `o=loop`), mounted
at `/home/tenant`. A full disk fails inside the box and cannot grow past 2 GiB or touch the VM's
free space beyond it. The host checks free space before creating a disk and refuses the open
(`boot_failed`, "no disk") when less than 3 GiB would remain.

`homeId` is the first 16 hex digits of the SHA-256 of the normalized, sorted `sshKeys` (key type
and key material; comments are dropped). The same key set opens the same home: a tenant that lost
its lease (missed tick, host outage, chose to stop) opens again with the same keys and is back on
its disk and its onion address. No resume token, no account. The key set is the home's identity for
good: there is no way to rotate keys and keep the disk, a different set is a different home, and a
lost private key is a lost home once the retention runs out. A tenant that wants two boxes uses two
key pairs (Edison and, later, the slop rebalancer each get their own). Two live leases on one
`homeId` are refused with `closedReason: home_in_use` (a new close reason).

**Slots.** A home never ends while it pays, so it cannot share the two lease slots freely or one
tenant's home plus one stranger's would make the fetch and python jobs `busy` for good. The host
gets `CHARTER_MAX_HOMES` (1 on toon2), counted inside `CHARTER_MAX_LEASES` (2): one home and one
job at a time. An open for a home past the cap answers `busy` as today. The offer says
`home.slots: 1` so an agent reads it where it reads the price; the docs say the one slot is spoken
for while Edison lives there and that a second home means a second host.

**Unpaid homes.** The disk is made at open (docker needs the volume to create the container; a
sparse 2 GiB file and `mkfs` cost nothing) and the onion service only at start, on tick 0. A home
whose lease closes with no tick paid is deleted at close, disk and all: an open costs the caller
0.001 USDC, and the 90 second first-tick grace would otherwise let random keys leave thousands of
retained disks a week. The retention below is for a home that paid at least one tick.

What this costs honestly: anyone who knows your public keys can open a lease on your home. They
cannot log in (no private key), the box runs only `sshd` and your own `boot.sh`, and the egress is
the same Anyone network, so what they get is your `boot.sh` running and your home held `in_use`
until their lease lapses. The docs say so; a tenant that cares adds a second key only it knows,
which changes the `homeId`. A signed resume (`ssh-keygen -Y sign` over a nonce) is the fix if that
ever bites; it is not built now.

Retention: when a home's last lease closes, `homes.json` records `lastClosedAt`. A sweep once an
hour deletes the disk, the onion service keys and the record of any home with no live lease and
`lastClosedAt` older than **7 days**. Free. Why 7 and not paid: a paid hold would need a fourth
priced app and a second clock; 7 days covers a weekend outage, a wallet running dry and a tenant
that forgot, and a tenant that wants more pays a tick a week (0.007 USDC) to keep the lease live.
The offer carries `home: { diskGiB: 2, retentionDays: 7 }` so an agent reads the terms where it
reads the price.

The disk is plaintext on toon2. The operator can read it. The docs say: treat it as you would any
VPS whose provider you have not met; encrypt what matters; keep a copy elsewhere (LADING, over the
same channel, is the natural second seller).

### Secrets: over SSH, never through Charter (Claude's call)

The open body carries public keys only. Everything else a tenant's agent needs (API keys, bot
tokens, a payer key) goes in through the SSH session, by `scp` or `ssh … 'cat > ~/.env'`, and lives
on the tenant's disk. The host, the door, the relay and the lease status never carry a tenant
secret. The skill says this in one line and gives the `scp` form.

### What the host promises about uptime: nothing, in writing (Claude's call)

toon2 is a VM on a laptop at home. It has gone down for a Helius outage (29 hours of red canary in
October, the door's side), a spent host channel (15 minutes) and every deliberate restart. The home
design makes a `charter-host` restart harmless and lets docker bring the box back on a VM reboot
before the host even runs, but a reboot or a network loss that outlasts the paid time still closes
the lease (`missed_tick`, 10 seconds past `paidThrough`), and nothing is refunded for time already
paid.

The agents page, llms.txt and the skill state it as a list, not a promise:

- No uptime figure. Expect restarts. Your disk survives them; your processes do not, so put what
  must run in `~/.charter/boot.sh`.
- A tick pays an hour from the end of the paid time. Pay the next tick half an hour early (the
  tenant loop already does) so a short outage does not end the lease. Paying several ticks ahead
  buys that much patience and nothing else; a lease that closes refunds nothing.
- A closed home keeps its disk and onion address for 7 days. Open again with the same keys.

Operationally: `docs/ops.md` gains a home section (restart is now safe for homes; what the sweep
deletes and when; how to read `homes.json`; how to grow the Lima disk). Before the first home lease
Drew grows toon2's disk (a `limactl` stop and edit, which closes every live lease, so it happens on
a day with none), to 40 GiB if the Air has it. Claude asks first; Drew runs it.

### Paying for the box from inside the box

The tenant CLI (`charter rent`) opens, pays tick 0 and keeps paying through the `toon` binary. A
box has no toon node (the node needs docker and systemd), so the CLI gains:

- a second payer, the `@toon-protocol/client` one the door already uses (`src/payer.ts`), chosen by
  `CHARTER_PAYER=toon-client` with the door's key, channel store and connector variables. It seals
  by `sealKey` from the offer and needs only a path to Drew's edge connector, which the box has:
  `CHARTER_CONNECTOR_URL` is set by the host from its own `CHARTER_TENANT_CONNECTOR_URL`, the
  edge's clearnet `/ilp` URL through the HTTP proxy by default, or the edge's `.anyone` URL through
  the SOCKS port if the client's bundled SOCKS support proves out in step 5 (preferred, since it
  keeps the box's packets off shared exits). The offer comes from `CHARTER_OFFER_JSON`, so no
  relay read (a WebSocket, which ignores the proxy variables) is needed from inside. This is "the
  tenant funds one channel": the box's channel to the edge pays rent, fetches, storage and anything
  a hop beyond. Opening that channel is one on-chain deposit, so the tenant key also needs a little
  Base ETH for gas, which the docs say beside the 2 USDC.
- `charter renew --lease <id> --from <index> --max-intervals <n>`: attach to a lease someone else
  opened and keep paying it. The first open and tick 0 come from outside (the box does not exist
  yet); once the tenant is inside, `renew` in `boot.sh` pays the rest from the box's own wallet.

Both are small: the payer exists, and `renew` is `runLease` without the open.

### The first tenant: Edison

Edison today is a Hermes gateway on the Air (Gemini, Telegram, Discord) with crons, paying Drew's
node per fetch through a payer sidecar and renting Charter through a bridge into the `toon` VM.
The move, once the home image is live:

1. Open a home from the `toon` VM with the skill (Edison's node pays open and tick 0: 0.008 USDC).
2. Drew SSHes in over the node's Anyone SOCKS port, installs Hermes with `uv`, copies `~/.hermes`
   config and `.env` by `scp` (Drew moves the secrets; Claude never sees them), installs the charter
   CLI, and writes `boot.sh`: start the gateway, run `charter renew` with a Base channel key Drew
   funds (2 USDC, Drew's transfer).
3. The Air's gateway is stopped. Edison answers from the box. Rent is paid from the box.
4. **The milestone**: from the box, one paid packet to Jonathan's node through Drew's edge (a paid
   write to `g.toon.relay`, price 2, or a tip to spaceturtle once his hub routes it): box, edge,
   Jonathan. Two hops, one channel. Recorded with the fulfil and the relay event id in `docs/demo.md`.

Known risks, stated not solved: Gemini and Telegram over shared Anyone exits may rate-limit; Hermes
on arm64 Linux in 1 GiB is untested (its gateway idles around 300 MB on the Air); the `toon-client`
payer under Node's proxy handling needs one proof. Each is checked in step 2 before the Air's
gateway is stopped, and the Air stays as it is until the box has answered a message and paid a tick.

### The door, the storefront and the docs

- Door: `POST /v1/leases` takes `{ offerId, home: { sshKeys: string[] } }` (1 to 8 keys, each an
  `ssh-ed25519`, `ecdsa-sha2-*` or `ssh-rsa` line under 1 KiB, comment restricted to safe
  characters, validated in `src/jobs.ts` like the python script). `GET /v1/leases/:id` passes
  `access`, `restarts` and `homeId` through. Nothing about payment changes.
- Storefront: the Rent form gets a third choice, Home, with one textarea for keys; the lease page
  shows the SSH line once `access` is set and the restart count. Minimal, since agents rent homes.
- `web/agents.html`, `web/llms.txt`, the skill (`renting-charter-compute`, plugin 0.2.0 to 0.3.0),
  the README and `site/index.html` (committed, republish is Drew's paid write): a Home section with
  the open body, the status shape, the `ssh` line, the proxy variables, the disk and retention
  terms, the uptime list, the "anyone with your public key" note, the "operator can read your disk"
  note, and "what to tell your operator" (5 USDC a month, 2 USDC in a channel if the box pays its
  own rent). The sentence "not yet a server to live in" is replaced with what is true.
- Hermes plugin (`charter-tool`) and the Bazaar description: out of scope here; the home is
  reachable through them already by body shape, and the catalog text changes on the next paid tick.

## What changes, by file

- `jobs/home/`: `Dockerfile`, `home.sh`, `sshd_config`, a test that builds the image and proves
  SSH login as `tenant` with a generated key, a restart keeps the host key, `boot.sh` runs, and a
  raw connection to the internet fails while a proxied one succeeds (run on a Linux docker host;
  skipped where there is none, like the other image tests).
- `src/jobs.ts`: `HOME_IMAGE`, `isSshKeys`, `homeJob`, `jobFromBody` accepting `home`.
- `src/host/runner.ts`: the home profile (`args: ['SSH_KEYS']`, network `home`, flags for the
  volume, the published port, `--dns`, `--pids-limit 512`, `--restart unless-stopped`, the env);
  `Runner` gains `ensureHome(homeId)` (disk, volume, onion config, HUP), `homeAccess(homeId)` (reads
  the onion hostname) and `removeHome(homeId)`; `create` for a home re-creates on the same volume.
- `src/lease.ts`: `isHome`, `restarts`, `homeId`, `access`, `home_in_use`; `onJobExit` is a no-op
  for a home.
- `src/host/loop.ts`: no exit watch for a home; `reconcile` keeps or re-creates a home; a
  `homeSweep` once an hour; the paid-through file rewritten on tick.
- `src/host/server.ts`: `home_in_use` and the home slot cap on open, `access` in status.
- `src/host/anon.ts`: writes `hs.d/<homeId>.conf`, HUPs `charter-anon`, reads `hostname`.
- `src/types.ts`: `Offer.home` (`diskGiB`, `retentionDays`, `slots`), `Lease.homeId`,
  `Lease.restarts`, `Lease.access`; `reconcile` treats a home in `awaiting_first_tick` like a job
  (no tick paid, close it).
- `src/cli.ts`, `src/tenant/run-lease.ts`: `--home <keys file>`, `renew`, `CHARTER_PAYER`.
- `src/door/server.ts`, `web/`: the body, the status fields, the Home choice.
- `deploy/host/`: `charter-anon.service` (system unit, ambient bind capability), `anonrc`,
  `charter-home-net.service` (root), an install script for both, `env.example` (`CHARTER_MAX_HOMES`,
  `CHARTER_HOME_DIR`, `CHARTER_ANON_PIDFILE`, `CHARTER_TENANT_CONNECTOR_URL`, `CHARTER_ALLOW_IMAGES`
  with the home).
- `docs/ops.md`, `docs/env.md`, `docs/demo.md` (section 8: the first home, Edison's move, the
  two-hop proof), `web/agents.html`, `web/llms.txt`, `README.md`, `plugins/charter/…/SKILL.md`,
  `site/index.html`.

## Deploy order (Claude runs it, Drew pays what is paid and moves every secret)

1. Build and test locally; build the home image in toon2 and run the image test there.
2. toon2, with no live lease: install `charter-anon.service` and `charter-home-net.service`, start
   both, confirm the proxies and DNS answer on the gateway and a plain container on `charter-home`
   cannot reach anything else. Grow the Lima disk first if Drew agrees.
3. New host code and env (`CHARTER_ALLOW_IMAGES` gains `charter-home`), restart `charter-host`,
   read the published offer (`images` lists three, `home` terms present).
4. Door: rsync, rebuild, `GET /v1/offers` shows the home; a bare `POST /v1/leases` with `home`
   answers `awaiting_first_tick`.
5. Proof over TOON from the `toon` VM: open a home with a test key, one tick, `access` within a
   minute, SSH in over the node's SOCKS port, `curl https://example.com` through the proxy
   succeeds and `curl --noproxy '*' https://example.com` fails, write a file, restart `charter-host`
   and find the box back with the file, let the tick lapse and open again with the same key to
   find the file. About 0.02 USDC.
6. Edison's move (above), on Drew's go, with Drew at the keyboard for the secrets.

## Left to the builder

- The HUP mechanics and how long until the `hostname` file appears. Checked 2026-11-04 on toon2:
  `anon 0.4.10.2-live --verify-config` accepts `SocksPort`, `HTTPTunnelPort`, `DNSPort`,
  `HiddenServiceDir` and `HiddenServicePort` in one file ("Configuration was valid"), and the
  node's own `anonrc` already uses `%include` of a `services.d` directory with one `.conf` per
  service (`HiddenServiceDir`, `HiddenServiceVersion 3`, `HiddenServicePort`), so Charter's
  `hs.d/` follows that form exactly.
- Whether unprivileged `sshd` under `runsc` needs `StrictModes no` or a `PidFile none`; the image
  test decides.
- The exact `iptables` or `nft` lines for the two rules on toon2's kernel, and how the root unit
  survives a docker restart (DOCKER-USER is preserved; the INPUT rule is ours).
- Node's proxy handling for the `toon-client` payer in the box (`NODE_USE_ENV_PROXY` on the
  installed Node, else `EnvHttpProxyAgent`), proven in step 5 with one paid status read from
  inside the box.
- Port allocation above 22000 and what happens when a home's port is taken after a restart
  (re-allocate and rewrite the onion config; the onion address does not change).
- Test doubles for anon and the volume in `runner.test.ts` and `loop.test.ts`, following the exec
  double the runner tests already use.
