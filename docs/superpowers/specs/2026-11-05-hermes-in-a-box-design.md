# Hermes in a box: a home with Hermes Agent preinstalled

Status: Claude's design, 2026-11-05. Drew deferred the questions ("defer to your recs"), so every
choice below is Claude's call unless it says Drew's. Drew approved the one choice put to him: the
first real use is Edison moving onto the image on its own key; strangers come after the VM grows.

## Intent

The home image shipped on 2026-11-04 and Edison moved into one by hand on 2026-11-05. The move
taught what a bare box costs an agent operator: Hermes's official installer does not fit the 2 GiB
tenant disk (about 1.8 GB: 567 MB of tool bundles, a 512 MB clone, a venv), and the lean recipe
that does fit (`uv sync --locked` with five extras, 297 MB) took a person at a keyboard, two
removals of re-downloaded bundles, and a day. Drew's agreed order is price, Edison onto Charter,
Hermes in a box, then a slop.cash rebalancer. This is the third step.

`charter-hermes` is a second home image: the same box as `charter-home` (SSH over its own onion,
egress only through Charter's Anyone client, a 2 GiB disk kept 7 days, 0.007 USDC an hour) with
Hermes Agent 0.22.7 and the charter CLI already installed in the read-only root filesystem. An
agent operator with a wallet opens it, pays one tick, copies `.env` and `config.yaml` in over SSH,
and has a running gateway. The disk holds only what is the tenant's: `~/.hermes` (config, secrets,
state, logs) and `~/.charter` (the payer key, the channel store, the boot script).

Agents are the audience. The image is distribution: it is what the skill, the agents page, llms.txt
and the Bazaar listing point at when they say "a home for your Hermes agent", and every sentence
they say about it is true on the live host the day it ships.

## Goals

- One open and one tick give a box in which `hermes gateway run` works as installed, and the box
  reaches a running, Telegram-connected gateway once the tenant has copied `.env` and `config.yaml`
  into `~/.hermes` over SSH, with no further command from the tenant.
- The tenant's disk stays mostly free: more than 1 GiB of the 2 GiB after the gateway runs. Hermes
  never downloads its tool bundles into `~/.hermes/tools`.
- The box pays its own rent from its own wallet through one payer process, the `charter payer`
  service that already exists on main, and nothing else in the box signs on that channel.
- Hermes's code and venv live in the image, read-only, shared by every Hermes box on the host, and
  cannot be broken from inside the box.
- Everything fits the box as it is: 1 CPU, 1 GiB of memory, 512 processes, a 2 GiB disk.
- Edison runs from the image on its existing disk, with the Air's gateway stopped, before anything
  is said about the image in public.

## Non-goals

- A second home slot, a bigger disk, more memory or a grown Lima VM. toon2 has 3.4 GB of VM disk
  free and one home slot, and the host refuses a new home disk below a 3 GiB floor, so a stranger's
  new key cannot open a home on toon2 today under either image. Growing the VM (disk to 40 GiB,
  memory to 4 GiB if the Air has it) is Drew's step on a day with no live lease; this design does
  not depend on it, and the docs say the one slot is spoken for.
- Hermes features that need its tool bundles: the WhatsApp bridge and the TUI need its Node, the
  browser tool needs Playwright, voice needs ffmpeg. The box has none of them and the docs say so.
- A tenant choosing Hermes extras. The venv is read-only with a fixed set (below). A tenant who
  needs another extra rents `charter-home` and installs its own Hermes, as Edison did.
- Hermes updates from inside the box. The tree is read-only; a new Hermes is a new image.
- Any change to prices, the interval, the key-set identity, the retention, the onion access or the
  home rules in the 2026-11-04 design. This image inherits all of it.
- A storefront built for the Hermes box. The Rent form's Home choice gains an image selector and
  nothing more.
- Changes to the Hermes plugins (hermes-toon) or the Bazaar text; the catalog text changes on the
  next paid tick when Drew runs it.

## Anti-goals

- A box that fills its own disk. If the gateway's first start pulls 570 MB of bundles, the design
  has failed even if the gateway runs.
- A box whose boot needs a human: a tenant that has to SSH in to start the gateway or the rent
  loop after every restart is back to the bare home.
- Copy that calls the box a hosted Hermes service, or hides that the operator can read the disk
  and that Telegram and the model provider are reached through shared Anyone exits.
- Two signers on one channel store. The box runs exactly one `charter payer`; `renew` and every
  Hermes plugin pay through it with `CHARTER_PAYER=url`. A fallback to the in-process
  `toon-client` payer exists only when the service is absent, never beside it.
- A tenant secret in the image, the open body or the lease status.

## Constraints

- Everything in the home design's constraints holds: toon2 (Lima, aarch64, 4 CPUs, 2.9 GiB of
  memory, 1.7 GiB available with Edison's box up at 690 MiB), Docker 29.1.3 with `runsc`, the
  legacy builder (no buildx, so no BuildKit mounts), `--read-only`, `--cap-drop ALL`, user
  `tenant` uid 10001, the home bridge and proxies, `--restart unless-stopped`.
- toon2 disk: 15 GB used of 19, 3.4 GB free; `charter-home` is 709 MB; `charter-job-fetch` 3.45 GB
  shares layers with the playwright base. Nothing tagged is pruned.
- Hermes 0.22.7 (tag `v0.22.7`): `requires-python >=3.11,<3.15`, but its lock covers Python 3.14
  only (`[tool.uv] environments = ["python_version >= '3.14'"]`, and every core dependency carries
  a `python_version >= '3.14'` marker: "3.11 is an install bridge for pre-PM updaters, never a
  runtime"). Debian bookworm's 3.11 cannot run it. Edison's box venv runs a uv-managed CPython
  3.14.9 (86 MB under `~/.local/share/uv/python`), which `uv sync` downloaded on its own. Its
  package manager (`pm/`) downloads bundles in two places: `prepare_launch`
  (a self-managed source install whose venv is not current re-syncs at every launch, which is what
  bit Edison's box) and lazy installs at first use. `hermes_cli/venv_sync.py` `check_runtime` and
  `prepare_launch` both skip a tree that has a `.git` entry and no `install-stamp.json` with
  `updateMechanism: "self"` ("a developer's checkout does not owe managed products"). The official
  Hermes Docker image sets `HERMES_DISABLE_LAZY_INSTALLS=1`; the tenant-facing switch is
  `security.allow_lazy_installs` in `config.yaml`. Hermes resolves `node` only through its own
  store (`_pm_tool_path`), so the image's Node 22 does not make its Node-backed features work;
  nothing in the chat gateway path needs them.
- The `charter payer` service (main, 2026-11-05, `src/payer-service.ts`): `charter payer` listens
  on `127.0.0.1:3510`, pays with the `toon-client` payer from `CHARTER_TOON_KEY_FILE`,
  `CHARTER_TOON_CHANNEL_STORE`, `CHARTER_TOON_CHAIN`, optional `CHARTER_TOON_RPC_URL_FILE`, and the
  box's `CHARTER_CONNECTOR_URL`; `GET /health` names the payer address and the channel headroom;
  everything else pays with `CHARTER_PAYER=url`. Inside a box the toon-client payer needs an
  explicit RPC URL (`https://mainnet.base.org`): the client cannot read the ETH balance through
  its default RPC from there.
- Edison's box today (homeId `ac83e7d58faf521d`, lease `5ec56ea8…`): `~/.hermes` with
  `.env`, `config.yaml`, `SOUL.md`, a 297 MB venv at `~/.hermes/venv` and the installer's clone;
  `~/charter` (dist and node_modules, 150 MB); `~/.charter/payer.key`, `channels.json`,
  `rpc-url`, `payer.env`, `boot.sh`, `start-payer.sh`, `start-renew.sh`, `restart-gateway.sh`
  (the parallel session's work). Its `du` shows the 2 GiB image fully allocated: freed blocks stay
  allocated in a sparse file, which is harmless.
- No em dashes in anything written. Copy for agents is honest and never baits. Claude never moves
  Drew's funds. Mainnet only.

## The design

### A second home image, not a second kind of home (Claude's call)

`charter-hermes` is built `FROM charter-home` (an `ARG BASE` so the image test can name its own
base tag). It inherits the user, sshd, `home.sh`, the proxies and every flag; it adds Hermes, the
charter CLI, ripgrep and a default boot. On the host it is the same `JobProfile` as the home and
goes through the same open, tick and status apps at the same prices.

`src/images.ts` gains `HERMES_IMAGE = 'charter-hermes'` and `HOME_IMAGES = [HOME_IMAGE,
HERMES_IMAGE]`; `isHome(lease)` is membership in `HOME_IMAGES`; `JOB_PROFILES` has one shared home
profile object under both names; `CHARTER_ALLOW_IMAGES` lists it; the config check "a home image
is allowed but `CHARTER_MAX_HOMES` is 0" covers both. `homeId`, the disk, the onion, the port, the
retention and the slot count are keyed by the key set alone, never by the image: the same keys
open the same disk under either image. That is how Edison moves (below) and how a tenant moves
back if the image fails it. The lease carries the image in `job.image`, so a host restart
re-creates the box from the right one.

Open body: `home: { sshKeys: string[], image?: "charter-home" | "charter-hermes" }`, default
`charter-home`; `jobFromBody` refuses any other value. Over TOON the job is `{ "image":
"charter-hermes", "args": { "SSH_KEYS": "..." } }`, unchanged in shape. The door's existing
`image_not_offered` check covers a host that does not list it. The CLI: `charter rent --home
keys.pub --image charter-hermes`. The storefront's Home choice shows a select with the two images
when the offer lists both ("Home · SSH", "Hermes home · SSH") and no select when it lists one.

`charter-hermes` is one moving tag, not a name per Hermes version. The Dockerfile pins the version
(0.22.7 now) and the agents page states it; a new Hermes is a rebuild of the same tag, and a
running box keeps the image it was created from until its container is re-created (a host restart
leaves it alone; a VM reboot or a deliberate `docker rm -f` by the operator, with the tenant's
say, moves it). Hermes migrates its own `config.yaml` across versions (`_config_version`), and
`~/.hermes` is the tenant's either way. The docs say: "the Hermes version is the host's; today
0.22.7; a host rebuild moves your box to the new one at its next re-create". Why not a name per
version: `HOME_IMAGES`, `CHARTER_ALLOW_IMAGES`, the storefront, the door check and the docs would
all grow a list, on a host whose disk holds two versions at most.

Why not a new lease kind or a flag on the home: the 11-04 design's argument holds; a second image
costs the shape nothing, and `images` in the offer is already how an agent learns what a host runs.

### What the image adds (Claude's call)

`jobs/hermes/Dockerfile`, built from the repository root (`docker build -f jobs/hermes/Dockerfile
-t charter-hermes .`) after `npm run build`, with a root `.dockerignore` that keeps `node_modules`, `.git`
and the test and docs trees out of the context (the door's Dockerfile builds from the root too, so
the list is what both need, below). The legacy builder commits each
`RUN` as a layer, so each step below cleans up in the same `RUN` it dirties.

1. `apt-get install ripgrep` (bookworm's 13.0). No ffmpeg, no compiler, no libatomic.
2. `/opt/hermes/app`: the `v0.22.7` source tarball from GitHub (`archive/refs/tags/v0.22.7.tar.gz`),
   SHA-256 `91bf15f50ce61e7da8a7890c11b202b904c3d7c0e2688a6dc6bcb42a2fe8b91d` (90 MB), unpacked
   (280 MB), with `tests` (80 MB), `tests-js`, `website` (30 MB), `evals` and `apps` (59 MB, the
   desktop app's sources, read only by Hermes's own source-build and update code) removed, leaving
   about 110 MB. `web` (4 MB) stays: the gateway's web UI reads it. Then `git init -q` in it and no `install-stamp.json`: that is the shape
   Hermes reads as a developer's checkout, so `check_runtime` and `prepare_launch` skip it and
   the package manager never re-syncs the tree at launch. The Dockerfile says so in a comment,
   and names the two functions.
3. `/opt/hermes/python`: `UV_PYTHON_INSTALL_DIR=/opt/hermes/python uv python install 3.14.9`, the
   CPython Edison's venv runs (86 MB). Then `/opt/hermes/venv`: `UV_PROJECT_ENVIRONMENT=/opt/hermes/venv
   uv sync --locked --no-default-groups --python 3.14.9 --extra telegram --extra discord --extra
   google --extra mcp --extra web`, the recipe that ran Edison's gateway (300 MB), with the uv
   cache removed in the same step and the venv's `python` symlink checked to resolve inside
   `/opt/hermes/python`, never under a home directory. Then `python3 -m compileall -q` over the app
   and the venv, so the read-only root needs no `__pycache__` writes and a 1 CPU box does not
   recompile at every start.
4. `/opt/charter`: `package.json`, `package-lock.json`, `npm ci --omit=dev`, `dist/`; a wrapper
   `/usr/local/bin/charter` (`exec node /opt/charter/dist/cli.js "$@"`) and
   `/usr/local/bin/hermes` (a symlink to the venv's console script). Edison's hand copy was
   150 MB; this is the same package.
5. The TOON plugins for Hermes (hermes-toon: `web-toon`, `toon-node`, `charter-tool`) are not
   installed in the image: a Hermes plugin lives under `~/.hermes/plugins`, which is the tenant's
   disk, and its enabled state is the tenant's. What the image does is make their install work on a
   read-only venv: their only Python dependency is `httpx`, which Hermes's core already pins, so
   `hermes plugins install --ref <sha> https://github.com/drew-dot-com/hermes-toon#src/<name>`
   runs from inside the box with nothing to add to the venv (git honours `HTTPS_PROXY`). The
   default boot exports `TOON_PAYER_URL`, `CHARTER_PAYER_URL` (both `http://127.0.0.1:3510`),
   `CHARTER_BIN=/usr/local/bin/charter` and `CHARTER_OFFER_ID` to the gateway, so an installed
   plugin pays through the box's payer with no further setting. The docs give the three install
   lines with the pinned sha and say plainly: a plugin whose Python dependencies are not already
   in the venv cannot be installed in this image; rent `charter-home` for that.
6. `ENV HERMES_DISABLE_LAZY_INSTALLS=1 HERMES_HOME=/home/tenant/.hermes`; `home.sh` (the base
   image's, so `charter-home` is rebuilt too) adds both names to the list it writes into
   `~/.ssh/environment`, so a session and `boot.sh` see them. A tenant's `config.yaml` cannot
   re-enable lazy installs past the variable, which is the point: the disk is the tenant's, the
   image is not.
7. Entrypoint `/app/hermes-home.sh`, run as `tenant`: if `~/.charter/boot.sh` is absent, copy
   `/app/boot-default.sh` there (executable; the tenant owns it and may edit or replace it), then
   `exec /app/home.sh`. A tenant's existing `boot.sh` is never touched.

Expected size on arm64: about 700 MB of new layers on top of `charter-home`'s shared base (Python
3.14 86 MB, the tree 110 MB, the venv 300 MB, the charter package 150 MB, ripgrep and compiled
bytecode); the Dockerfile's first comment records the measured number, as the home's
does. toon2 keeps about 2.7 GB free after the build, which is enough because Edison's disk already
exists and nothing else needs the floor.

Why the venv in the image and not on the disk: 300 MB of the tenant's 2 GiB, a 20 minute `uv
sync` on 1 CPU at every first boot, and a venv the tenant can break. Why no `hermes pm`-managed
install: its store wants 567 MB of bundles the box cannot hold and would re-download. Why a
developer-checkout shape and not the Docker image's sealed layout: the sealed stamp expects a
manifest and a bundled interpreter; the checkout path is two conditions Hermes reads at launch and
is what Edison's box ran as, minus the stamp that made it self-managed.

### The default boot: payer, renew, gateway (Claude's call)

`/app/boot-default.sh`, copied to `~/.charter/boot.sh` on first start and run by `home.sh` at
every start (output in `~/.charter/boot.log`). It is written so that each part waits for what it
needs instead of failing, because the box starts before the tenant has copied anything in:

1. Sources `~/.charter/payer.env` if present (the tenant's overrides); otherwise uses the defaults
   `CHARTER_TOON_KEY_FILE=~/.charter/payer.key`, `CHARTER_TOON_CHANNEL_STORE=~/.charter/channels.json`,
   `CHARTER_TOON_CHAIN=evm`, `CHARTER_TOON_RPC_URL_FILE=~/.charter/rpc-url` (written with
   `https://mainnet.base.org` when absent), `CHARTER_PAYER_URL=http://127.0.0.1:3510`.
2. If `~/.charter/payer.key` is absent, makes one (32 random bytes, mode 0400) and logs where it
   is. The key is the box's own wallet, made on the box's own disk; it never leaves the disk
   unless the tenant copies it out. Starts `charter payer` in the background (log
   `~/.charter/payer.log`), waits for `GET /health`, and writes the payer address from `/health`
   to `~/.charter/payer.address` and to the log, so the operator knows what to fund. Today
   `/health` names the address only inside `channel.payer`, which is absent when the headroom read
   fails (an unfunded key has no channel yet): `/health` gains a top-level `payer` field, the
   address whatever the channel's state, a two-line change in `src/cli.ts`.
3. Starts the rent loop in the background: `CHARTER_PAYER=url charter renew --offer
   <hostPubkey>:<id> --lease "$CHARTER_LEASE_ID" --max-intervals 720`, the offer ref read with
   `jq` from `CHARTER_OFFER_JSON`, in a `while` loop that sleeps 5 minutes between exits (log
   `~/.charter/renew.log`). An unfunded wallet makes `renew` fail at its first due tick and try
   again; until the address holds USDC and a little Base ETH, the box lives on the ticks paid
   from outside, which the docs say.
4. Waits for `~/.hermes/.env` to exist (polling every 10 seconds, forever), then runs `hermes
   gateway run` in the foreground of the script, so a gateway that exits is restarted by the
   script after 30 seconds, with a note in the log. The gateway's own logs go to `~/.hermes/logs`.
   `config.yaml` is optional: Hermes writes a default one, and a tenant whose provider and
   platform are env variables alone needs only `.env`; the docs say which lines a Telegram box
   needs (the model provider key, `TELEGRAM_BOT_TOKEN`, and the allowed user ids).

Memory, measured in Edison's box on 2026-11-05: the gateway 348 MB RSS, `charter payer` 153 MB,
`charter renew` 140 MB, sshd 16 MB; the container at 690 MiB of its 1 GiB. The docs give those
numbers and say "one gateway; do not run a second agent or a heavy tool in the box". Folding
`renew` into the payer process would give 140 MB back; it is not done here.

Why `renew` through the service and not the in-process payer: one writer per channel store, the
rule the payer service was built for; the Hermes plugins in the box (web-toon, toon-node,
charter-tool 0.4.0) point at the same URL. Why the box makes its own key: an operator that only
has to fund an address is the "one open and one tick" promise; a tenant that wants its own key
copies it to `~/.charter/payer.key` before the first boot, or edits `payer.env`.

### Edison's move (Claude runs it on Drew's go; Drew moves nothing, the secrets are on the disk)

1. Build and test the image on toon2 (below); deploy the host and the door.
2. In Edison's box over SSH from Edison's node: stop the box's `renew` so the lease lapses at its
   paid-through (within the hour), and stop the gateway at the end of that hour. Edison is offline
   from then until step 4, about ten minutes if the open is ready; the Air's gateway stays stopped.
3. The lease closes `missed_tick`; the disk and onion are kept. Open again from Edison's node with
   the same key and `--image charter-hermes`, one tick from the node (0.008 USDC).
4. In the box: the default boot finds `~/.charter/boot.sh` (Edison's own, from the parallel
   session) and runs it; it already starts the payer, `renew` and the gateway in the right order.
   Replace its gateway line with the image's `hermes` and its `charter` with `/usr/local/bin/charter`,
   or replace the file with the image's default plus Edison's `payer.env`: the builder decides
   from what is in the file. Then delete `~/.hermes/venv`, the installer's clone and `~/charter`
   (about 1 GB back). Check: gateway up, Telegram answers, `df` shows more than 1 GiB free, the
   next tick paid by the box.
5. Record it in `docs/demo.md` section 14 with the lease id, the time and the free disk.

If the image fails Edison, open again with the same key on `charter-home`: the disk is untouched
until step 4's deletions, which come last.

### The door, the storefront and the docs

- Door: `home.image` validated in `jobFromBody`; nothing else changes. `GET /v1/offers` lists the
  image in `images` when the host allows it.
- Storefront: the image select in the Home choice; `JOB_NAME` gains the Hermes name; the lease page
  is unchanged (a home is a home).
- Agents page, llms.txt and the skill (step 8) gain a "Hermes in a box" subsection: what is
  preinstalled (Hermes 0.22.7 on its own Python 3.14, the five extras, the charter CLI, ripgrep,
  Node 22, Debian's Python 3.11),
  what the tenant brings (`.env` with the provider key and bot token, optionally `config.yaml`
  and `SOUL.md`, over `scp`), what the box does at boot (payer, renew, gateway once `.env` is
  there), the address to fund and what it costs (about 5 USDC for 30 days plus a little Base ETH
  for the channel open, 2 USDC runs it about ten days), the limits (1 GiB of memory, one gateway,
  no WhatsApp, browser or voice, shared Anyone exits that Telegram and the provider may
  rate-limit), and that the one home slot is Edison's while Edison lives there. The README's job
  list and build order gain the image; `docs/ops.md` "Homes" gains the build order (`charter-home`
  first, then `charter-hermes` from the repo root) and the image facts; `docs/env.md` the
  `CHARTER_ALLOW_IMAGES` row. The plugin's version goes to 0.4.0. `site/index.html` is committed
  with one line; the republish is Drew's paid write.

## What changes, by file

- `jobs/hermes/`: `Dockerfile`, `hermes-home.sh`, `boot-default.sh`, `hermes.test.mjs`; root
  `.dockerignore`. `jobs/home/home.sh` adds the two env names.
- `src/images.ts`: `HERMES_IMAGE`, `HOME_IMAGES`, `JOB_IMAGES` with four. `src/lease.ts`: `isHome`
  over `HOME_IMAGES`. `src/jobs.ts`: `homeJob(keys, image)`, `jobFromBody` with `home.image`.
  `src/host/runner.ts`: the shared home profile under both names. `src/host/config.ts`: the
  `CHARTER_MAX_HOMES` check over `HOME_IMAGES`. `src/cli.ts`: `--image`. `web/app.ts`: the select
  and the name. `src/door/server.ts`: nothing but the body type.
- Tests beside each, and the image test.
- `web/agents.html`, `web/llms.txt`, `plugins/charter/skills/renting-charter-compute/SKILL.md`,
  `plugins/charter/.claude-plugin/plugin.json`, `README.md`, `docs/ops.md`, `docs/env.md`,
  `docs/demo.md` (section 14), `site/index.html`, `deploy/host/env.example`.

## Deploy order (Claude runs it; Drew's go before the paid steps)

1. Local: `npm test`, typecheck, build; commit on main as the home image did (worktree, task by
   task, reviewed).
2. toon2: `docker system df` first; copy the tree in over `~/src/charter` as before; `docker build
   -t charter-home jobs/home` (the base changed), then the Hermes image from the repo root;
   `CHARTER_IMAGE_TESTS=1 node --test jobs/hermes/hermes.test.mjs` under runsc. Prune nothing
   tagged; if the build does not fit, stop and raise the Lima disk with Drew.
3. Host env: `charter-hermes` in `CHARTER_ALLOW_IMAGES`; `systemctl --user restart charter-host`
   (a restart leaves Edison's running home alone; check no lease is awaiting its first tick); the
   published offer lists four images.
4. Door: rsync, `compose up -d --build`; `GET /v1/offers` lists the image; a bare `POST
   /v1/leases` with `home.image: "charter-hermes"` and a throwaway key answers `boot_failed`
   `no disk` on toon2 as it stands (the floor) or `awaiting_first_tick` after the VM grows: either
   is the truth and is recorded.
5. Edison's move, above.

## Left to the builder

- The measured sizes (tree after trimming, venv, image), written into the Dockerfile's comments.
- Whether `uv sync` wants `--python 3.14.9`, `UV_PYTHON` or finds the installed interpreter by
  itself, and that it downloads no second one (Edison's box ran this command on this base, so
  every wheel exists for 3.14 on arm64).
- Whether Hermes writes anything under `/opt/hermes/app` at gateway start on a read-only root
  (the image test runs `hermes --version` and a `gateway run` long enough to log its startup, with
  `HERMES_HOME` on the disk, and asserts no "out of sync", no `~/.hermes/tools`, and a clean
  startup log). `PYTHONPYCACHEPREFIX=/tmp/pycache` is the fallback if compileall leaves gaps.
- The field names for the offer ref in `CHARTER_OFFER_JSON` (`hostPubkey` and `id` in
  `offerFromJson`), and whether `renew` inside a box resolves `<pubkey>:<id>` from that variable
  alone (it does for Edison's box today).
- The image test's shape: it builds `charter-home` from `jobs/home` with a test tag, then the
  Hermes image with `--build-arg BASE=<that tag>`, and reuses the home test's disk, loop device
  and ssh helpers (extract them to a shared `jobs/image-test-lib.mjs` if that is cleaner than
  copying).
- The `.dockerignore` list: `deploy/door/Dockerfile` also builds from the repository root and
  copies `package.json`, `package-lock.json`, `tsconfig.json`, `src`, `web` and `scripts`, so the
  ignore file excludes only `node_modules`, `.git`, `.worktrees`, `test-results`,
  `playwright-report`, `docs`, `site`, `e2e`, `plugins` and the `*.bak*` trees, and the builder
  checks both Dockerfiles' `COPY` lines against it. Also that `npm run build` precedes the Hermes
  build (the Dockerfile fails with a clear message when `dist/cli.js` is missing).
