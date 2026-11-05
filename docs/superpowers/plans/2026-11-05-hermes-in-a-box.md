# Hermes in a Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `charter-hermes`, a second home image with Hermes Agent 0.22.7 and the charter CLI preinstalled read-only, whose default boot starts the box's payer, pays its own rent and runs the Hermes gateway once the tenant's `.env` arrives, so an agent operator gets a running gateway from one open and one tick.

**Architecture:** `charter-hermes` is built `FROM charter-home` and adds `/opt/hermes` (CPython 3.14.9 from uv, the 0.22.7 tree in developer-checkout shape so Hermes's package manager never re-syncs it, a `uv sync --locked` venv with five extras), `/opt/charter` (the CLI) and a default `boot.sh`. On the host it is a second name in `HOME_IMAGES` sharing the home `JobProfile`; `isHome` is membership; the open body gains `home.image`. The key set stays the home's identity, so the same keys open the same disk under either image, which is how Edison moves.

**Tech Stack:** TypeScript on Node 22, `node --test` with `tsx`, express; Debian bookworm-slim, Docker 29 legacy builder on toon2 (aarch64, `runsc`), uv 0.13.7, Hermes 0.22.7, the `charter payer` service on main.

**Spec:** `docs/superpowers/specs/2026-11-05-hermes-in-a-box-design.md`

## Global Constraints

- Image name `charter-hermes`, `FROM ${BASE}` with `ARG BASE=charter-home`; built from the repository root with `docker build -f jobs/hermes/Dockerfile -t charter-hermes .` after `npm run build`.
- Hermes source: `https://github.com/NousResearch/hermes-agent/archive/refs/tags/v0.22.7.tar.gz`, SHA-256 `91bf15f50ce61e7da8a7890c11b202b904c3d7c0e2688a6dc6bcb42a2fe8b91d`, at `/opt/hermes/app` with `tests`, `tests-js`, `website`, `evals` and `apps` removed, then `git init -q` and no `install-stamp.json`.
- Python: `UV_PYTHON_INSTALL_DIR=/opt/hermes/python uv python install 3.14.9`. Venv: `UV_PROJECT_ENVIRONMENT=/opt/hermes/venv uv sync --locked --no-default-groups --extra telegram --extra discord --extra google --extra mcp --extra web`, then `compileall` over app and venv; uv cache removed in the same `RUN`.
- `/opt/charter`: `package.json`, `package-lock.json`, `npm ci --omit=dev`, `dist/`; `/usr/local/bin/charter` wraps `node /opt/charter/dist/cli.js`; `/usr/local/bin/hermes` is the venv's console script.
- Image env: `HERMES_DISABLE_LAZY_INSTALLS=1`, `HERMES_HOME=/home/tenant/.hermes`; both names added to the list `jobs/home/home.sh` writes into `~/.ssh/environment`.
- Default boot (`/app/boot-default.sh`, copied to `~/.charter/boot.sh` when absent): payer.env defaults `CHARTER_TOON_KEY_FILE=$HOME/.charter/payer.key`, `CHARTER_TOON_CHANNEL_STORE=$HOME/.charter/channels.json`, `CHARTER_TOON_CHAIN=evm`, `CHARTER_TOON_RPC_URL_FILE=$HOME/.charter/rpc-url` (written with `https://mainnet.base.org` when absent), `CHARTER_PAYER_URL=http://127.0.0.1:3510`; key made as 32 random bytes hex, mode 0400; `charter payer` started unless `/health` already answers; `payer.address` from `/health`'s `payer`; `CHARTER_PAYER=url charter renew --offer <ref> --lease "$CHARTER_LEASE_ID" --max-intervals 720` in a loop sleeping 300 s between exits; the gateway waits for `$HERMES_HOME/.env`, runs `hermes gateway run`, restarts after 30 s if it exits; exports `TOON_PAYER_URL`, `CHARTER_PAYER_URL`, `CHARTER_BIN=/usr/local/bin/charter`, `CHARTER_OFFER_ID=<ref>` to the gateway. `<ref>` is `<hostPubkey>:<id>` from `CHARTER_OFFER_JSON`, or `<id>` alone when `hostPubkey` is empty.
- Open body `home: { sshKeys: string[], image?: 'charter-home' | 'charter-hermes' }`, default `charter-home`; any other `image` value is `null` from `jobFromBody` (a 400). `homeId` ignores the image.
- `JOB_IMAGES` is four names; `HOME_IMAGES = [HOME_IMAGE, HERMES_IMAGE]`; both home names share one `JobProfile` object.
- `/health` of `charter payer` gains a top-level `payer` (the address or `null`).
- Plugin version `0.3.0` to `0.4.0`.
- No em dashes in anything that ships. Copy is honest: the Hermes version is the host's (0.22.7); the one home slot is Edison's while Edison lives there; no WhatsApp, browser or voice; shared Anyone exits; the operator can read the disk; measured memory numbers.
- `npm test` and `npm run typecheck` green before each commit. Existing tests that assert three images are updated, not deleted.
- Claude never moves Drew's funds; mainnet only.

## Review Focus

- `home.image` with an unknown value (`"charter-job-python"`, `""`, `5`) must be refused, never fall back to `charter-home`. Pinned in Task 1.
- The same keys under the two images name one home: a live `charter-home` lease makes a `charter-hermes` open on the same keys answer `home_in_use`. Pinned in Task 2.
- A `charter-hermes` open on a host whose `CHARTER_ALLOW_IMAGES` lacks it must answer `boot_failed` with `image_not_allowed`, creating nothing. Pinned in Task 2.
- `boot.sh` run twice (a tenant restarts it) must not start a second `charter payer` on the same store: when `/health` already answers, it uses the running one. Pinned in Task 5.
- The gateway must start only once `~/.hermes/.env` exists, however late, and come back after it exits; `renew` must not spin when the wallet is unfunded. Pinned in Task 5.

---

### Task 1: The second home image name, `isHome`, and `home.image` in the body

**Files:**
- Modify: `src/images.ts`, `src/lease.ts:42-44`, `src/jobs.ts:62-85`
- Test: `src/jobs.test.ts`, `src/lease.test.ts`

**Interfaces:**
- Produces in `src/images.ts`: `export const HERMES_IMAGE = 'charter-hermes'`; `export const HOME_IMAGES = [HOME_IMAGE, HERMES_IMAGE]`; `JOB_IMAGES = [FETCH_IMAGE, PYTHON_IMAGE, HOME_IMAGE, HERMES_IMAGE]`.
- Produces in `src/lease.ts`: `isHome(l)` is `HOME_IMAGES.includes(l.job.image)`.
- Produces in `src/jobs.ts`: `export function homeJob(normalized: string[], image: string = HOME_IMAGE): JobSpec`; `export function isHomeImage(v: unknown): v is string` (true for the two names); `jobFromBody` reads `home.image`, default `HOME_IMAGE`, `null` when `isHomeImage` fails.

- [ ] **Step 1: Write the failing tests**

```ts
// jobs.test.ts: update the first test's expected list to the four names, then:
test('jobFromBody: home.image picks the hermes image, defaults to the home, and refuses anything else', () => {
  const ok = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 c';
  const keys = normalizeSshKeys([ok])!;
  assert.deepEqual(jobFromBody({ home: { sshKeys: [ok], image: 'charter-hermes' } }), { image: 'charter-hermes', args: { SSH_KEYS: keys.join('\n') } });
  assert.deepEqual(jobFromBody({ home: { sshKeys: [ok] } }), homeJob(keys));
  assert.equal(jobFromBody({ home: { sshKeys: [ok] } })!.image, 'charter-home');
  for (const image of ['charter-job-python', '', 5, null, 'charter-hermes ']) {
    assert.equal(jobFromBody({ home: { sshKeys: [ok], image } }), null, String(image));
  }
  assert.deepEqual(HOME_IMAGES, ['charter-home', 'charter-hermes']);
});
// lease.test.ts
test('a hermes home is a home: same homeId rules, never done on exit', () => {
  const keys = normalizeSshKeys([KEY])!;
  const l = newLease('c'.repeat(32), OFFER, homeJob(keys, 'charter-hermes'), 1000, homeIdOf(keys));
  assert.equal(isHome(l), true);
  assert.equal(l.homeId, newLease('d'.repeat(32), OFFER, homeJob(keys), 1000, homeIdOf(keys)).homeId);
  const running = onTick(l, 0, 1000, 60_000).lease;
  assert.equal(onJobExit(running, 0), running);
});
```

- [ ] **Step 2: Run** `node --test --import tsx src/jobs.test.ts src/lease.test.ts`; expected: the new tests fail (`HOME_IMAGES` undefined, `image` ignored).
- [ ] **Step 3: Implement** the exports above. `isHomeImage` is an exact string match against `HOME_IMAGES` (no trim).
- [ ] **Step 4: Run** the two files; expected PASS. Then `npm test` to find every test that asserted three images and update it.
- [ ] **Step 5: Commit** `feat(jobs): charter-hermes, a second home image named in the open body`.

---

### Task 2: The host: shared profile, the allow check, and `home_in_use` across images

**Files:**
- Modify: `src/host/runner.ts:136-145`, `src/host/config.ts:100-104`
- Test: `src/host/runner.test.ts`, `src/host/config.test.ts`, `src/host/server.test.ts`

**Interfaces:**
- Produces in `runner.ts`: `const HOME_PROFILE: JobProfile = { ... }` (the current home profile object) and `JOB_PROFILES = { [FETCH_IMAGE]: ..., [PYTHON_IMAGE]: ..., [HOME_IMAGE]: HOME_PROFILE, [HERMES_IMAGE]: HOME_PROFILE }`.
- Produces in `config.ts`: the `CHARTER_MAX_HOMES` check runs when `allowImages.some((i) => HOME_IMAGES.includes(i))`, error text `a home image (charter-home or charter-hermes) is allowed but CHARTER_MAX_HOMES is 0: set it to at least 1`.

- [ ] **Step 1: Write the failing tests**

```ts
// runner.test.ts, beside the existing home create test (line ~405): the same argv shape under the hermes name
test('a hermes home is created with the home args and the hermes image last', async () => {
  // copy the setup of the existing 'home create' test; allow: ['charter-hermes']
  await r.create('l1', { image: 'charter-hermes', args: { SSH_KEYS: KEY } });
  const a = create.args;
  has('--network', 'charter-home'); has('--pids-limit', '512'); has('--restart', 'unless-stopped');
  assert.equal(a[a.length - 1], 'charter-hermes');
});
test('a hermes home on a host that allows only charter-home is image_not_allowed', async () => {
  await assert.rejects(r.create('l2', { image: 'charter-hermes', args: { SSH_KEYS: KEY } }), { code: 'image_not_allowed' });
});
// config.test.ts
test('charter-hermes alone also needs CHARTER_MAX_HOMES', () => {
  assert.throws(() => loadConfig({ ...ENV, CHARTER_ALLOW_IMAGES: 'charter-job-fetch,charter-hermes' }), /CHARTER_MAX_HOMES/);
  assert.deepEqual(loadConfig({ ...ENV, CHARTER_ALLOW_IMAGES: 'charter-home,charter-hermes', CHARTER_MAX_HOMES: '1', ...HOME_ENV }).offer.images, ['charter-home', 'charter-hermes']);
});
// server.test.ts, in the style of 'open for a home refuses ... a home already in use'
test('the same keys under the two home images are one home: the second open is home_in_use', async () => {
  // open charter-home with KEYS, tick 0; then open charter-hermes with the same KEYS
  assert.equal(second.body.closedReason, 'home_in_use');
  assert.equal(runner.created.length, 1);
});
```

- [ ] **Step 2: Run** the three files; expected: the runner rejects `charter-hermes` as `image_not_allowed` even when allowed (no profile falls back to fetch's: `profileFor` returns the fetch profile, so `SSH_KEYS` is `arg_not_allowed`), config does not throw, server passes already or fails on image.
- [ ] **Step 3: Implement**: `HOME_PROFILE`, the two keys, the config check over `HOME_IMAGES`.
- [ ] **Step 4: Run** the three files and `npm test`; expected PASS.
- [ ] **Step 5: Commit** `feat(host): charter-hermes shares the home profile and the home rules`.

---

### Task 3: The CLI: `rent --image`, and the payer's address in `/health`

**Files:**
- Modify: `src/cli.ts:215-240` (rent options), `src/cli.ts:160-175` (payer health), `src/payer-service.ts:432-446`
- Test: `src/cli.test.ts`, `src/payer-service.test.ts`

**Interfaces:**
- Produces: `charter rent ... --home <keys file> [--image charter-home|charter-hermes]`; `--image` without `--home` is a `UsageError('--image goes with --home')`; a value outside `HOME_IMAGES` is a `UsageError`. The usage text in `cli.ts` line 17 names it.
- Produces: `payerService` deps gain `payerAddress?: string | null`; `/health` JSON gains `payer: <address or null>` at top level (the `channel.payer` field stays).

- [ ] **Step 1: Write the failing tests**

```ts
// cli.test.ts, beside the existing --home test (line ~243)
test('rent --home --image charter-hermes opens the hermes image; --image needs --home and a home image', async () => {
  const r = await run(['rent', '--offer', 'o1', '--home', keysFile, '--image', 'charter-hermes', '--max-intervals', '1', '--relay', RELAY], HOME_HERMES);
  assert.deepEqual(r.h.opens[0].job.image, 'charter-hermes');
  assert.equal((await run(['rent', '--offer', 'o1', '--urls', 'https://a.com', '--image', 'charter-hermes', '--max-intervals', '1', '--relay', RELAY])).code, 2);
  assert.equal((await run(['rent', '--offer', 'o1', '--home', keysFile, '--image', 'charter-job-python', '--max-intervals', '1', '--relay', RELAY])).code, 2);
});
// payer-service test
test('/health names the payer address at top level, even when the channel cannot be read', async () => {
  // build the handler with payerAddress: '0xabc', channel: async () => { throw new Error('no rpc') }
  assert.equal(body.payer, '0xabc');
  assert.equal(typeof body.channel.error, 'string');
});
```

- [ ] **Step 2: Run** `node --test --import tsx src/cli.test.ts src/payer-service.test.ts`; expected FAIL (unknown option `--image`; `payer` undefined).
- [ ] **Step 3: Implement**: the option, its two checks, `homeJob(keys, image)`; `payerAddress` through `payerService`'s deps and the health object; `cli.ts` passes `address ?? null`.
- [ ] **Step 4: Run** the files and `npm test`; expected PASS.
- [ ] **Step 5: Commit** `feat(cli): rent --image for a hermes home; /health names the payer address`.

---

### Task 4: The door body and the storefront's image choice

**Files:**
- Modify: `src/door/server.ts:366` (the body type comment only; `jobFromBody` does the work), `web/app.ts:21,310,418-500`
- Test: `src/door/server.test.ts`

**Interfaces:**
- Produces in `web/app.ts`: `const HERMES_IMAGE = 'charter-hermes'`; `JOB_NAME[HERMES_IMAGE] = 'Hermes home · SSH'`; in `rentForm`, when `mode === 'home'` and the offer lists both home images, a `<select id="home-image-<key>">` with the two names (labels `charter-home: a bare box` and `charter-hermes: Hermes Agent preinstalled`), default `charter-home`; the submitted body is `{ home: { sshKeys, image } }` with `image` only when the select exists and is not `charter-home`. One home image listed: no select, `image` omitted.

- [ ] **Step 1: Write the failing door tests**

```ts
test('a home body with image charter-hermes reaches the host as that image; an offer without it is image_not_offered', async () => {
  // offer A lists ['charter-home', 'charter-hermes']; offer B lists ['charter-home']
  const a = await post('/v1/leases', { offerId: A, home: { sshKeys: [key], image: 'charter-hermes' } });
  assert.equal(host.opened.at(-1)!.image, 'charter-hermes');
  const b = await post('/v1/leases', { offerId: B, home: { sshKeys: [key], image: 'charter-hermes' } });
  assert.equal(b.status, 400);
  assert.equal(b.body.error, 'image_not_offered');
});
```

- [ ] **Step 2: Run** `node --test --import tsx src/door/server.test.ts`; expected: the first assertion fails only if Task 1 did not land (it did), so expect PASS for the host path and PASS for `image_not_offered`; if both pass, the test still documents the door and stays.
- [ ] **Step 3: Implement** the storefront change in `web/app.ts`; `npm run typecheck` and `npm run build:web`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`; expected PASS. Open the dev door (`npm run dev:door`) once and confirm the select appears only when both images are listed (the fake host's offer in `scripts/dev-door.ts` lists the images; add `charter-hermes` to it).
- [ ] **Step 5: Commit** `feat(door,web): the home choice names its image`.

---

### Task 5: The image: `jobs/hermes/`, the default boot, and its tests

**Files:**
- Create: `jobs/hermes/Dockerfile`, `jobs/hermes/hermes-home.sh`, `jobs/hermes/boot-default.sh`, `jobs/hermes/boot.test.mjs`, `jobs/hermes/hermes.test.mjs`, `.dockerignore`
- Modify: `jobs/home/home.sh:12-13` (the env name list)

**Interfaces:**
- Consumes: the Global Constraints' Dockerfile recipe and boot recipe, verbatim.
- Produces: `boot-default.sh` reads `CHARTER_LEASE_ID`, `CHARTER_OFFER_JSON`, `HERMES_HOME`, `HOME`, and optionally `CHARTER_BOOT_PAYER_WAIT_S` (default 60, how long to wait for `/health`), `CHARTER_BOOT_RENEW_SLEEP_S` (default 300), `CHARTER_BOOT_GATEWAY_SLEEP_S` (default 30), `CHARTER_BOOT_ENV_POLL_S` (default 10): the four exist so the test runs in seconds; production never sets them. Logs one line per stage to stdout (`boot: payer address 0x…`, `boot: renew started`, `boot: waiting for ~/.hermes/.env`, `boot: gateway started`, `boot: gateway exited (<code>), restarting in 30 s`).
- Produces: `.dockerignore` with `node_modules`, `.git`, `.worktrees`, `test-results`, `playwright-report`, `docs`, `site`, `e2e`, `plugins`, `*.bak*`, `dist.bak*`; the builder diffs it against `deploy/door/Dockerfile`'s `COPY` lines (`package.json`, `package-lock.json`, `tsconfig.json`, `src`, `web`, `scripts`) and `jobs/hermes/Dockerfile`'s (`package.json`, `package-lock.json`, `dist`, `jobs/hermes`).

- [ ] **Step 1: Write the failing boot test** `jobs/hermes/boot.test.mjs` (runs anywhere with `sh`, `node` and `jq`; no docker):

```js
// Stubs on PATH in a temp dir: `charter` (node script) that for `payer` serves /health on the
// port in CHARTER_PAYER_LISTEN with {"payer":"0xabc"} and records argv to $STUB_LOG, for `renew`
// records argv and env CHARTER_PAYER then exits 1; `hermes` records argv, sleeps 1 s, exits 3.
test('boot-default: payer, address, renew, then the gateway once .env exists, restarted after it exits', async () => {
  // HOME=tmp, HERMES_HOME=tmp/.hermes, CHARTER_LEASE_ID=abc, CHARTER_OFFER_JSON={"id":"o1","hostPubkey":"f".repeat(64), ...}
  // CHARTER_BOOT_* all 1, CHARTER_PAYER_LISTEN=127.0.0.1:<free port>, CHARTER_PAYER_URL=http://127.0.0.1:<that port>
  // spawn sh boot-default.sh; after 4 s kill it
  assert.match(readFileSync(`${home}/.charter/payer.key`, 'utf8'), /^[0-9a-f]{64}\n?$/);
  assert.equal(statSync(`${home}/.charter/payer.key`).mode & 0o777, 0o400);
  assert.equal(readFileSync(`${home}/.charter/rpc-url`, 'utf8').trim(), 'https://mainnet.base.org');
  assert.equal(readFileSync(`${home}/.charter/payer.address`, 'utf8').trim(), '0xabc');
  const log = readFileSync(stubLog, 'utf8');
  assert.match(log, /charter payer/);
  assert.match(log, new RegExp(`charter renew --offer ${'f'.repeat(64)}:o1 --lease abc --max-intervals 720 CHARTER_PAYER=url`));
  assert.doesNotMatch(log, /hermes gateway/);          // no .env yet
  // write .env, wait 3 s
  assert.match(log, /hermes gateway run/);
  assert.ok(log.match(/hermes gateway run/g).length >= 2, 'the gateway is restarted after it exits');
  assert.match(log, /TOON_PAYER_URL=http:\/\/127.0.0.1:\d+ .*CHARTER_BIN=\/usr\/local\/bin\/charter/);
});
test('boot-default: a payer already answering /health is reused, not started again', async () => {
  // start a stub /health server first, then boot; assert the stub log has no `charter payer` line and payer.address is written
});
test('boot-default: an offer with no hostPubkey gives --offer <id>', async () => { /* CHARTER_OFFER_JSON hostPubkey "" -> --offer o1 */ });
```

- [ ] **Step 2: Run** `node --test jobs/hermes/boot.test.mjs`; expected FAIL (no script).
- [ ] **Step 3: Write** `boot-default.sh` (POSIX `sh`, `set -u`, no `set -e` past the setup so a failing stage is logged and retried), `hermes-home.sh` (copy the default when `~/.charter/boot.sh` is absent, `chmod 700`, `exec /app/home.sh`), and the `home.sh` env list change. The renew loop runs in the background; the gateway loop is the script's foreground.
- [ ] **Step 4: Run** the boot test; expected PASS. `sh -n` both scripts.
- [ ] **Step 5: Write** `jobs/hermes/Dockerfile` per the Global Constraints: `FROM ${BASE}`, `USER root` for the install, back to `USER tenant`; comment lines name the two Hermes functions the `.git` entry satisfies (`check_runtime`, `prepare_launch` in `hermes_cli/venv_sync.py`), and leave `# Image size:` for Task 7 to fill. `COPY dist /opt/charter/dist` must fail clearly when `dist/cli.js` is absent: a `RUN test -f /opt/charter/dist/cli.js || { echo 'run npm run build first' >&2; exit 1; }` line right after it.
- [ ] **Step 6: Write** `jobs/hermes/hermes.test.mjs`, gated like `jobs/home/home.test.mjs` (`CHARTER_IMAGE_TESTS=1`, docker, mkfs, sudo; skipped otherwise). It builds `jobs/home` as `charter-home-test:<pid>`, then `-f jobs/hermes/Dockerfile --build-arg BASE=charter-home-test:<pid> -t charter-hermes-test:<pid> .` from the repo root, makes a disk as the home test does, starts the box with the home flags plus `-e CHARTER_OFFER_JSON={"id":"o1","hostPubkey":""}` and asserts over ssh: `hermes --version` prints `0.22.7` and its stderr has no `out of sync`; `charter --help` exits 0; `rg --version` exits 0; `readlink -f /opt/hermes/venv/bin/python` starts with `/opt/hermes/python/`; `~/.charter/boot.sh` exists with mode 700 and `~/.charter/boot.log` has `boot:` lines within 60 s; `test ! -e ~/.hermes/tools`; `python3 -c 'import telegram, discord, mcp, fastapi'` through `/opt/hermes/venv/bin/python` exits 0; `df -m ~` shows more than 1800 MiB free; the session env has `HERMES_DISABLE_LAZY_INSTALLS=1`. Then a `docker restart` keeps `~/.charter/boot.sh` as the tenant edited it (write a marker line first). Reuse the home test's helpers by extracting `sh`, `docker`, `pause`, `start`, `waitSsh` into `jobs/image-test-lib.mjs` if that is cleaner than copying; either is acceptable.
- [ ] **Step 7: Run** `node --test jobs/hermes/hermes.test.mjs` without docker; expected: skipped with the reason. `npm test` green.
- [ ] **Step 8: Commit** `feat(image): charter-hermes, Hermes 0.22.7 and the charter CLI in a home, with a default boot`.

---

### Task 6: Documents: agents page, llms.txt, the skill, README, ops, env, landing source

**Files:**
- Modify: `web/agents.html` (after the "Paying for the box from inside the box" h3, before "What to tell your operator"), `web/llms.txt` (Home section, a `## Hermes in a box` after it), `plugins/charter/skills/renting-charter-compute/SKILL.md` (step 8 gains "A Hermes home", the description line names it), `plugins/charter/.claude-plugin/plugin.json` (`0.4.0`), `README.md` (lines 11-18 and 130), `docs/ops.md` ("Homes": build order and the image facts), `docs/env.md` (line 13), `deploy/host/env.example` (line 4), `site/index.html` (line 76: one sentence).

**Interfaces:**
- Consumes: the spec's "The door, the storefront and the docs" list, and these fixed facts for the copy: Hermes 0.22.7 on its own Python 3.14; extras `telegram`, `discord`, `google`, `mcp`, `web`; the charter CLI at `/usr/local/bin/charter`; ripgrep; Node 22; the tenant brings `~/.hermes/.env` (provider key, `TELEGRAM_BOT_TOKEN`, allowed user ids) and optionally `config.yaml` and `SOUL.md` by `scp`; the boot order and the files it writes (`~/.charter/payer.key`, `payer.address`, `rpc-url`, `channels.json`, `boot.log`, `payer.log`, `renew.log`); fund the address with USDC and a little Base ETH (2 USDC runs it about ten days; about 5 USDC for 30 days); memory 348 MB gateway, 153 MB payer, 140 MB renew of 1 GiB; one gateway; no WhatsApp, browser tool or voice (they need Hermes's own tool bundles, which the box cannot hold); shared Anyone exits; plugins install from inside with `hermes plugins install --ref <sha> https://github.com/drew-dot-com/hermes-toon#src/<web-toon|toon-node|charter-tool>` and a plugin needing Python dependencies outside the venv cannot be installed; the Hermes version is the host's and a rebuild moves the box at its next re-create; the one home slot is Edison's while Edison lives there; a tenant whose keys already name a `charter-home` opens the same disk under `charter-hermes`.

- [ ] **Step 1: Write** each document's section. The open body example: `{"offerId": "…", "home": {"sshKeys": ["ssh-ed25519 AAAA…"], "image": "charter-hermes"}}`; over TOON `{"image": "charter-hermes", "args": {"SSH_KEYS": "…"}}`; CLI `charter rent --offer <pubkey>:<d> --home keys.pub --image charter-hermes --max-intervals 1`.
- [ ] **Step 2: Check** `grep -rnP '\x{2014}' web/agents.html web/llms.txt plugins README.md docs/ops.md docs/env.md site/index.html` prints nothing; every number above appears as given; `npm run build:web` and `npm run typecheck` pass (the agents page is static, so build only copies it).
- [ ] **Step 3: Commit** `docs: Hermes in a box, for agents and operators`.

---

### Task 7: Build and test the image on toon2 (Claude runs it)

**Files:**
- Modify: `jobs/hermes/Dockerfile` (the measured `# Image size:` comment), `docs/demo.md` (section 14, the build line)

- [ ] **Step 1:** On the Mac: `npm test`, `npm run typecheck`, `npm run build`; tar `dist`, `src`, `web`, `scripts`, `tsconfig.json`, `package.json`, `package-lock.json`, `jobs`, `deploy`, `.dockerignore` and copy into toon2's `~/src/charter` over `ssh air` and `limactl copy` or a piped tar, keeping `~/src/charter/dist.bak-<date>-prehermes` first.
- [ ] **Step 2:** In toon2 (`ssh air`, then `~/.local/lima/bin/limactl shell toon2`, docker through `sg docker -c "..."`): `docker system df` and `df -h /` recorded; `docker build -t charter-home jobs/home` (the base's `home.sh` changed); `docker build -f jobs/hermes/Dockerfile -t charter-hermes .`; `docker image ls charter-hermes` for the size. Stop and report if `df` shows less than 1.5 GB free at any point; prune nothing tagged. Note the legacy builder caches by layer: a failed `uv sync` layer is retried, not rebuilt from the base.
- [ ] **Step 3:** `CHARTER_IMAGE_TESTS=1 node --test jobs/hermes/hermes.test.mjs` in toon2 (runsc); expected exit 0. Fix and rebuild until it does; every fix goes back into the repo.
- [ ] **Step 4:** Write the measured sizes into the Dockerfile's first comment; commit `build(image): charter-hermes measured on toon2`.

---

### Task 8: Deploy the host and the door (Claude runs it; no lease awaiting its first tick)

- [ ] **Step 1:** toon2: back up `~/.config/charter/env`; add `charter-hermes` to `CHARTER_ALLOW_IMAGES`; `jq '.[] | select(.state=="awaiting_first_tick" or .state=="booting")' ~/.local/share/charter/leases.json` prints nothing; `systemctl --user restart charter-host`; the journal shows the offer republished with four images; Edison's container `StartedAt` unchanged and its lease `restarts` unchanged.
- [ ] **Step 2:** Door (Hetzner, as in `docs/demo.md` section 13): back up `/opt/charter`, rsync, `docker compose up -d --build`; `curl -s https://charter.mainnet.toonprotocol.dev/v1/offers | jq '.[0].images'` lists four; the agents page and llms.txt serve the new sections.
- [ ] **Step 3:** A bare `POST /v1/leases` through the door with `home.image: "charter-hermes"` and a throwaway key: record the answer in `docs/demo.md` (on toon2 as it stands, `boot_failed` with `no disk` from the floor is the expected truth; if it says `awaiting_first_tick`, let it lapse unpaid, which removes the disk).
- [ ] **Step 4:** Commit `docs(demo): charter-hermes deployed to toon2 and the door`.

---

### Task 9: Edison moves onto the image (Claude runs it on Drew's go; Edison is offline up to an hour)

- [ ] **Step 1:** From Edison's node (the `toon` VM on the Air) over its SOCKS port into Edison's box: read `~/.charter/boot.sh`, `payer.env`, `start-payer.sh`, `start-renew.sh`, `restart-gateway.sh`; note `cat /charter/paid-through`. Stop the box's `renew` (its pid from `renew.log` or `pgrep -f 'cli.js renew'`, never a `pkill -f` whose own command line matches). Do not stop the payer or the gateway yet.
- [ ] **Step 2:** Wait for the lease to close `missed_tick` (10 s past `paid-through`): `jq` the lease on toon2. The container is removed by the host; Edison is offline from here.
- [ ] **Step 3:** From Edison's node: `charter rent --offer cde9138b…:toon2-fetch-1 --home ~/.ssh/charter-edison-home.pub --image charter-hermes --max-intervals 1 --relay wss://relay.mainnet.toonprotocol.dev` (0.008 USDC from the node). Record lease id, homeId (must be `ac83e7d58faf521d`), onion (must be unchanged).
- [ ] **Step 4:** SSH in. `~/.charter/boot.sh` is Edison's own and ran at start: check `boot.log`, `pgrep -af 'cli.js payer|cli.js renew|hermes gateway'`. If Edison's script started `~/.hermes/venv/bin/hermes` and `~/charter/dist/cli.js`, edit it to `/usr/local/bin/hermes` and `/usr/local/bin/charter` (or replace it with `/app/boot-default.sh` plus Edison's `payer.env`, whichever is smaller), restart the gateway, and confirm Telegram answers (Drew sends one message, or Claude reads the gateway log for the Telegram connect line).
- [ ] **Step 5:** Only after the gateway answers from the image's Hermes: `rm -rf ~/.hermes/venv ~/.hermes/hermes-agent ~/charter ~/.local/share/uv`; `df -m ~` shows more than 1 GiB free; the next tick appears in `renew.log` paid through the box's payer.
- [ ] **Step 6:** `docs/demo.md` section 14: times, lease id, free disk before and after, memory from `docker stats`, the first self-paid tick. Memory file `project_charter.md`: a RESUME block for the Hermes image (what is live, the slot and VM-growth question for strangers, the plugin install lines). Commit `docs(demo): Edison runs from the charter-hermes image`.
