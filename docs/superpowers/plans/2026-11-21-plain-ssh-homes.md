# Plain-SSH Homes on charter-host-hel1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Homes on the new server hel1 are reached with `ssh -p <port> tenant@37.27.86.235`, hel1 becomes Charter's only host, and toon2 on the Air retires.

**Architecture:** The host gains a public-address setting: a home's fixed sshd port is published on that address and its `access` is known at once, with the onion optional and off. Every client that prints a login line learns the public shape. hel1 is set up like toon2 (charter-host, a clearnet toon 0.3.0 node behind TLS, charter-anon for egress, gVisor) and the door switches hosts in one change.

**Tech Stack:** TypeScript (Node 22, NodeNext ESM, `node --test --import tsx`), bash, Docker + gVisor (`runsc`), iptables, Anyone `anon`, toon 0.3.0, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-21-plain-ssh-homes-design.md` (approved 2026-11-21).

## Global Constraints

- hel1: `37.27.86.235`, SSH `ssh -i ~/.ssh/charter_host root@37.27.86.235`, Ubuntu 24.04.5, x86_64, 4 vCPU, 7.6 GiB.
- Home ports: base `22000` (`HOME_PORT_BASE`), last `22099`; fixed per home across re-opens. Firewall opens exactly `22000-22099/tcp` for homes.
- hel1 inbound: 22 (admin, key only), 22000-22099/tcp, 80/443 (node TLS). Nothing else.
- Every byte a home or job sends out leaves through anon; never from hel1's own IP.
- Onion off by default on hel1; a home's onion is published only when configured. No needless anon HUP (a HUP resets every circuit).
- toon pinned to **0.3.0** on hel1 (embedded connector 18da529). The edge runs `connector:rust-2026.09.29.1-mfee`; connectors from 11.02.1 on refuse its vouchers.
- hel1 capacity to start: `CHARTER_MAX_HOMES=4`, `CHARTER_MAX_LEASES=6`, `CHARTER_RUNTIME=runsc`.
- Price, interval, disk and retention unchanged: 7000 micro-USDC per 3600 s, 2 GiB, 7 days.
- Unset public address = exactly today's behaviour (toon2 keeps working until it stops).
- Existing readers of `access.ssh` keep working; any added field is optional.
- Drew does secrets, payments, signups, npm publishes and every edge operator write; each waits for his go. Budget agreed: about 6 USDC plus gas.
- No em dashes in anything that ships. Mainnet only.

## Review Focus

1. A home published on the public address whose replies the firewall drops: ssh from outside hangs. Expect a login prompt from a machine outside hel1 (Task 7 step: outside ssh).
2. A home (or job) connecting to another home's public port, to hel1's own public IP, or straight to the internet: expect it to fail; only anon answers (Task 7 step: isolation checks).
3. A lease whose `access` is the old onion shape read by an updated client: expect the onion ProxyCommand line, unchanged (Task 3 tests `onion access still prints the ProxyCommand line`).
4. A home opened with onion off: expect no hs.d conf written and no SIGHUP sent (Task 2 test `onion off: publish and retire never touch anon`).
5. A home whose port would land past 22099: expect the open to fail with a clear error, not a home outside the firewall (Task 1 test `allocatePort refuses past 22099`).

---

### Task 1: Host config for a public address, onion optional, bounded ports

**Files:**
- Modify: `src/host/config.ts` (the `home` block, lines ~19-31 and ~107-124)
- Modify: `src/host/homes.ts` (`HOME_PORT_BASE`, `allocatePort`, `HomeError` codes)
- Test: `src/host/config.test.ts`, `src/host/homes.test.ts`
- Docs: `docs/env.md` (host variables table), `deploy/host/env.example`

**Interfaces:**
- Produces: `HostConfig.home.publicHost?: string`; `HostConfig.home.onion: boolean`; `HostConfig.home.anonHsDir?: string` and `anonPidFile?: string` (required only when `onion` is true); `HOME_PORT_LAST = 22099`; `allocatePort(taken: Iterable<number>): number` throws `HomeError('no_port', …)` past `HOME_PORT_LAST`.

- [ ] **Step 1: Write the failing tests**

In `config.test.ts` (reuse the file's existing env fixture with homes on):
```ts
test('CHARTER_HOME_PUBLIC_HOST sets home.publicHost and turns the onion off by default', () => {
  const c = loadConfig({ ...homeEnv, CHARTER_HOME_PUBLIC_HOST: '37.27.86.235', CHARTER_ANON_HS_DIR: '', CHARTER_ANON_PIDFILE: '' });
  assert.equal(c.home?.publicHost, '37.27.86.235');
  assert.equal(c.home?.onion, false);
});
test('CHARTER_HOME_ONION=1 with a public host keeps the onion and needs the anon paths', () => {
  assert.throws(() => loadConfig({ ...homeEnv, CHARTER_HOME_PUBLIC_HOST: '37.27.86.235', CHARTER_HOME_ONION: '1', CHARTER_ANON_HS_DIR: '' }), /CHARTER_ANON_HS_DIR/);
  const c = loadConfig({ ...homeEnv, CHARTER_HOME_PUBLIC_HOST: '37.27.86.235', CHARTER_HOME_ONION: '1' });
  assert.equal(c.home?.onion, true);
});
test('no public host: onion on and anon paths required, as today', () => {
  const c = loadConfig(homeEnv);
  assert.equal(c.home?.publicHost, undefined);
  assert.equal(c.home?.onion, true);
});
test('CHARTER_HOME_PUBLIC_HOST must be a bare IPv4 address or hostname', () => {
  for (const bad of ['http://37.27.86.235', '37.27.86.235:22', 'a b', '999.1.1.1']) {
    assert.throws(() => loadConfig({ ...homeEnv, CHARTER_HOME_PUBLIC_HOST: bad }), /CHARTER_HOME_PUBLIC_HOST/, bad);
  }
});
```
In `homes.test.ts`:
```ts
test('allocatePort refuses past 22099', () => {
  const all = Array.from({ length: 100 }, (_, i) => 22000 + i);
  assert.equal(allocatePort(all.slice(0, 99)), 22099);
  assert.throws(() => allocatePort(all), (e: unknown) => e instanceof HomeError && e.code === 'no_port');
});
```
(`loadConfig`/`homeEnv` stand for the names the existing tests use; match them.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test --import tsx src/host/config.test.ts src/host/homes.test.ts`
Expected: the five new tests FAIL.

- [ ] **Step 3: Implement**

`CHARTER_HOME_PUBLIC_HOST` parsed only when `maxHomes > 0`: an IPv4 dotted quad (each octet 0-255) or a hostname (`/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i`), else throw naming the variable. `onion = publicHost === undefined || flag(env, 'CHARTER_HOME_ONION')`. `need()` the two anon variables only when `onion`. Add `'no_port'` to `HomeError`'s codes and `HOME_PORT_LAST`. Document both variables in `docs/env.md` and as commented lines in `deploy/host/env.example`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test --import tsx src/host/config.test.ts src/host/homes.test.ts`
Expected: PASS. Then `npx tsc --noEmit` clean (later tasks will fix call sites only if the optional anon paths break a type; fix them here if they do).

- [ ] **Step 5: Commit**

`git commit -m "host: a public address for homes, onion optional, ports bounded at 22099"`

---

### Task 2: The runner publishes homes on the public address

**Files:**
- Modify: `src/host/runner.ts` (`HomeRunnerOpts`, `homeArgs` ~line 167-190, `publishHome`/`retireHome`/`homeAccess`/`removeHome` ~line 421-445)
- Modify: `src/host/main.ts` (wiring of `home` into the runner, ~line 74-84)
- Modify: `src/types.ts` (`HomeAccess`)
- Test: `src/host/runner.test.ts`

**Interfaces:**
- Consumes: Task 1's `HostConfig.home.publicHost`, `.onion`, optional anon paths.
- Produces: `HomeRunnerOpts.publicHost?: string`; `HomeRunnerOpts.anon?: AnonDeps` (absent when onion is off); `HomeAccess = { ssh: { host: string; port: number; user: string }; onion?: { host: string; port: number; user: string } }`. With a public host: `access.ssh = { host: publicHost, port: rec.port, user: 'tenant' }`, and `access.onion` only once an onion is published. Without: today's `{ ssh: { host: <onion>, port: 22, user: 'tenant' } }`.

- [ ] **Step 1: Write the failing tests** (in `runner.test.ts`, with its existing fake exec and fake anon)

```ts
test('public host: the sshd port is published on that address', async () => { /* run a home; assert docker run args contain '-p', '37.27.86.235:22000:2222' and no '127.0.0.1:22000:2222' */ });
test('no public host: the sshd port stays on loopback', async () => { /* assert '-p', '127.0.0.1:22000:2222' */ });
test('public host: homeAccess answers at once with host, the home port and tenant', async () => {
  assert.deepEqual(await runner.homeAccess(homeId), { ssh: { host: '37.27.86.235', port: 22000, user: 'tenant' } });
});
test('onion off: publish and retire never touch anon', async () => { /* no anon deps; publishHome + retireHome + removeHome resolve; fake kill never called; no file under hsDir */ });
test('public host with onion on: access carries both, ssh first', async () => {
  assert.deepEqual(await runner.homeAccess(homeId), {
    ssh: { host: '37.27.86.235', port: 22000, user: 'tenant' },
    onion: { host: `${'a'.repeat(56)}.anyone`, port: 22, user: 'tenant' },
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test --import tsx src/host/runner.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

In `homeArgs`, bind `${h.publicHost ?? '127.0.0.1'}:${rec.port}:2222` (update the "Loopback only" comment). `publishHome`/`retireHome` return at once when `h.anon` is undefined; `removeHome` skips `retireHiddenService` then. `homeAccess` follows the Interfaces block. `main.ts` passes `publicHost` and builds `anon` only when `cfg.home.onion`. The loop's existing `access == null` fill (`src/host/loop.ts` ~127) needs no change: with a public host it fills on the first pass.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test --import tsx src/host/runner.test.ts src/host/loop.test.ts src/host/server.test.ts` then `npm test` and `npx tsc --noEmit`.
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

`git commit -m "host: publish a home's sshd on the public address; onion optional"`

---

### Task 3: Every client prints the right login line

**Files:**
- Modify: `src/cli.ts` (`sshLine`, ~line 225)
- Modify: `web/keys.ts` (`sshLine`, ~line 24), `web/app.ts` (comment ~line 890 and the pending text if it says onion)
- Modify: `mcp/src/core.ts` (`how`, ~line 265), `mcp/src/server.ts` (tool descriptions ~lines 74, 389, 472)
- Test: `src/cli.test.ts`, `web/keys.test.ts`, `mcp/src/core.test.ts` (create a test file only where none exists)

**Interfaces:**
- Consumes: Task 2's `HomeAccess`.
- Produces: in each of `src/cli.ts` and `web/keys.ts`, `sshLine(access)` returns `ssh -p <port> tenant@<host>` for a public shape (host an IPv4 address or hostname that is not `*.anyone`, user `tenant`, integer port 1-65535), and the existing ProxyCommand line, unchanged, for the onion shape. `web/keys.ts` still returns `undefined` for anything else.

- [ ] **Step 1: Write the failing tests**

```ts
test('public access prints ssh -p', () => {
  assert.equal(sshLine({ ssh: { host: '37.27.86.235', port: 22003, user: 'tenant' } }), 'ssh -p 22003 tenant@37.27.86.235');
});
test('onion access still prints the ProxyCommand line', () => {
  const host = `${'a'.repeat(56)}.anyone`;
  assert.equal(sshLine({ ssh: { host, port: 22, user: 'tenant' } }), `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${host}`);
});
// web/keys.ts only:
test('a public host with a bad port or user is pending', () => {
  assert.equal(sshLine({ ssh: { host: '37.27.86.235', port: 0, user: 'tenant' } }), undefined);
  assert.equal(sshLine({ ssh: { host: '37.27.86.235', port: 22003, user: 'root' } }), undefined);
  assert.equal(sshLine({ ssh: { host: 'a b', port: 22003, user: 'tenant' } }), undefined);
});
```
MCP (`core.test.ts`): a lease view with a public `ssh` has `how` equal to `'Plain SSH: ssh -p 22003 tenant@37.27.86.235'`; with an onion host, `how` keeps today's onion sentence.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test --import tsx src/cli.test.ts web/keys.test.ts` and `cd mcp && npm test`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

Branch on the host: `/^[a-z2-7]{56}\.anyone$/` is the onion shape, anything else that passes the public check is public. MCP `how` follows the same branch. Rewrite the three MCP tool descriptions so plain SSH comes first; keep the onion sentence only as "some hosts publish an onion address instead". Keep charter-mcp at version 0.3.0 (still unpublished); `mcp/server.json` unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`, `npx tsc --noEmit`, `cd mcp && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

`git commit -m "clients: print ssh -p for a public home, the ProxyCommand line for an onion one"`

---

### Task 4: Agent-facing docs say plain SSH first

**Files:**
- Modify: `web/llms.txt`, `web/agents.html`, `web/index.html`, `README.md`, `plugins/charter/skills/renting-charter-compute/SKILL.md`, `mcp/README.md`, `docs/ops.md` (Homes section)
- Test: `web/*.test.ts` that assert copy (run them; update any assertion that pinned onion wording)

**Interfaces:**
- Consumes: the login line from Task 3 (`ssh -p <port> tenant@<host>`).

- [ ] **Step 1: Rewrite each home passage**

Plain SSH first, with the command shape `ssh -p <port> tenant@<host>` and where the port and host come from (the lease's `access.ssh`). Outbound traffic still leaves through Anyone (say so: some sites block it). The onion appears only as "a host may also publish an onion address". Slot count: say homes are limited and an open answers busy when full; do not state a number. No em dashes.

- [ ] **Step 2: Verify**

Run: `npm test` (web copy tests), `grep -n -i "onion\|anyone" web/llms.txt web/agents.html web/index.html README.md plugins/charter/skills/renting-charter-compute/SKILL.md mcp/README.md` and read every hit: each must be the optional mention or about egress. `grep -c '—'` on each file: 0.

- [ ] **Step 3: Commit**

`git commit -m "docs: homes are reached with plain SSH; onion is optional"`

---

### Task 5: Host-side scripts for a public host

**Files:**
- Modify: `deploy/host/charter-home-net.sh` (DOCKER-USER rules, ~line 34)
- Modify: `deploy/host/anonrc` (a host-only SOCKS port), `deploy/host/charter-socks-connect`, `deploy/host/install-home.sh` (anon source)
- Create: `deploy/host/install-host.sh` (hel1 base install)
- Modify: `deploy/host/charter-home-watch.sh` (`probe`/`onion_check`)
- Test: `deploy/host/` has no test harness; each step below carries its own check, and Task 7 proves them on hel1.

**Interfaces:**
- Produces: anon listens on `127.0.0.1:9152` (SOCKS, for host processes and the job egress relay) besides the bridge ports; `charter-socks-connect` uses `CHARTER_SOCKS_UPSTREAM` (`host:port`) when set, else today's node-anonrc lookup; `install-home.sh` takes `ANON_BIN`, `ANON_GEOIP`, `ANON_GEOIP6` from the environment when set, else today's node-overlay lookup; `install-host.sh` installs docker, gVisor `runsc` (registered with docker), Node 22 and Anyone's anon release pinned by version and sha256, and prints the anon/GeoIP paths to pass to `install-home.sh`.

- [ ] **Step 1: Firewall: answer inbound, start nothing**

In `charter-home-net.sh`, insert in DOCKER-USER, above `-i $br -j DROP`: `-i $br -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`. Keep idempotent (`-C` before `-I`) and keep the ip6tables side matching. Check: `bash -n deploy/host/charter-home-net.sh`.

- [ ] **Step 2: Job egress through charter-anon**

`anonrc`: add `SocksPort 127.0.0.1:9152`. `charter-socks-connect`: `exec socat STDIO "TCP:${CHARTER_SOCKS_UPSTREAM}"` when set. Document `CHARTER_SOCKS_UPSTREAM=127.0.0.1:9152` for hel1 in `charter-socks.service` (an `Environment=` line left commented, set by install on hel1). Check: `bash -n`/`sh -n` on both scripts.

- [ ] **Step 3: anon from a pinned release**

`install-home.sh` prefers `ANON_BIN`/`ANON_GEOIP`/`ANON_GEOIP6`; `install-host.sh` downloads the release (version and sha256 written as constants at the top of the script, checked before install), installs docker from Docker's apt repo, gVisor from its apt repo and registers `runsc`, Node 22 from NodeSource, creates the host user `charter` with linger enabled, and is safe to rerun. Check: `bash -n deploy/host/install-host.sh`.

- [ ] **Step 4: The host-side watch probes the published address**

In `charter-home-watch.sh`, read the lease's `.access.ssh.host` and `.port` (add both to the jq row). Public host: probe with `timeout 30 nc -N -w 20 "$host" "$port"`, banner must start `SSH-`. Onion host: today's SOCKS probe through the node's anon, or through `127.0.0.1:9152` when the node has none. Same 15 min grace, 3 misses, no restarts. Check: rerun the fake-data harness from the 11-21 session (fake `HOME_ONION_PROBE`) with a public and an onion lease; both print `ok`.

- [ ] **Step 5: Commit**

`git commit -m "deploy/host: public homes answer inbound, jobs egress via charter-anon, pinned anon install, watch probes the published address"`

---

### Task 6: The outside SSH check on the Hetzner box

**Files:**
- Create: `deploy/ops/charter-home-ssh-check.sh`
- Modify: `deploy/ops/charter-ops-check.sh` (call it with `--alert`), `deploy/ops/install-box.sh` (install it), `deploy/ops/env.example` (its settings)

**Interfaces:**
- Consumes: the door's `door-ledger.json` (`[{ leaseId, createdAt, offer, offerId, ticksPaidToHost, stopped, … }]`) under `CHARTER_DOOR_DATA`, and the door's free `GET /v1/leases/:id` (answers `{ lease: { state, access, paidThrough, homeId, … }, offer, stopped }`).
- Produces: alerts under key `home-ssh-<homeId>` through `charter-alert.sh`: fail after 3 misses in a row, one "recovered" when it answers.

- [ ] **Step 1: Write the script**

For each ledger entry whose offer is a home image and whose paid time (createdAt + ticksPaidToHost x interval from the entry's `offer`) has not ended and is not `stopped`: read `access` once with `GET /v1/leases/:id` and cache it in `$CHARTER_OPS_STATE/home-ssh-<leaseId>.access` (a home's address does not change, and each read costs the door a paid host status read). Skip onion-only access. Probe `timeout 30 nc -N -w 20 host port`, banner `SSH-`. Count misses in `$CHARTER_OPS_STATE`; drop state of leases no longer live. With `--alert` call `charter-alert.sh`; without, print one line per home.

- [ ] **Step 2: Check it**

Run on the box without `--alert` against the live ledger: prints nothing or `skip` lines while no hel1 home exists. With a hand-made ledger in a temp `CHARTER_DOOR_DATA` and a fake `GET` (`CHARTER_DOOR_URL` pointing at a local `python3 -m http.server` serving a canned JSON): one `ok` line for a reachable banner (`nc -l` on a test port answering `SSH-2.0-test`), one `miss` for a closed port.

- [ ] **Step 3: Commit**

`git commit -m "ops: probe live homes' SSH from the box, from the door's ledger"`

---

### Task 7: hel1 bring-up and first-party proof (Claude on the server; Drew for money)

No new code. Record every id, tx and timing in `docs/demo.md` (new section 17). toon2 keeps running jobs; the door does not list hel1 yet.

- [ ] **Step 1: Base.** Copy `deploy/host` to hel1; `sudo bash install-host.sh`; firewall (ufw or nftables): allow 22, 22000-22099/tcp, 80, 443; deny the rest inbound. Check `runsc --version`, `docker run --rm --runtime runsc hello-world`.
- [ ] **Step 2: toon node, pinned 0.3.0, clearnet behind TLS.** Install toon 0.3.0 for user `charter`; `toon init`/`toon up` in clearnet mode with host `37-27-86-235.sslip.io`, Caddy terminating TLS for it in front of the node's http port. If 0.3.0 has no clearnet mode, run it hidden as toon2 does (spec fallback) and note it. **Drew funds** the node wallet when `toon up` asks (about 0.001 ETH + 1 USDC on Base, 0.01 SOL + 1 USDC on Solana). Record ILP address, seal key, `httpEndpoint`.
- [ ] **Step 3: Homes.** `sudo ANON_BIN=… ANON_GEOIP=… ANON_GEOIP6=… bash install-home.sh`; `charter-socks` with `CHARTER_SOCKS_UPSTREAM=127.0.0.1:9152`. Build images on hel1 from the repo: `charter-job-fetch`, `charter-job-python`, `charter-home`, `charter-hermes` (build order in docs/ops.md, Homes).
- [ ] **Step 4: charter-host.** `~/.config/charter/env` from `deploy/host/env.example` with: a new `CHARTER_OFFER_ID` (`hel1-1`), `CHARTER_HOME_PUBLIC_HOST=37.27.86.235`, no anon hs.d vars, `CHARTER_MAX_HOMES=4`, `CHARTER_MAX_LEASES=6`, `CHARTER_RUNTIME=runsc`, the node's ILP base/seal key/seal URL, `CHARTER_HIDDEN_HOST` unset, `CHARTER_PROXY=socks5://172.17.0.1:9150`. Start the user service; `charter-host offer --print` shows `home.slots 4`. Home watch timer on with ops.env (Telegram token copy, Drew's chat id).
- [ ] **Step 5: Peering (Drew's go for each write and the deposit).** From the box: `sign-write.sh … POST /peers {"id":"hel1","url":"https://37-27-86-235.sslip.io/ilp","fee":0,"max_packet_amount":1000000,"chain":"solana","deposit":2000000}`; then `POST /routes/peers` for hel1's ILP base, and its `charter-open`, `charter-tick`, `charter-status` prefixes at the prices toon2's have (1000 / 7000 / 100). hel1's own relay-write channel funded about 2 USDC (Drew). Check the offer appears on the relay.
- [ ] **Step 6: Proof over TOON, before the door.** From the `toon` VM with the `charter` CLI: rent a `charter-home` on `hel1-1` with a throwaway key; from a machine outside hel1 (the Mac): `ssh -p <port> tenant@37.27.86.235` logs in. In the home: `curl` to an outside site works only through the proxies (a direct `curl --noproxy '*'` fails); `nc -w 5 37.27.86.235 22` and another home's port fail; DNS resolves via 172.19.0.1. Two ticks paid; `systemctl --user restart charter-host` leaves the home running and reachable. A `charter-job-fetch` lease returns output.
- [ ] **Step 7: Commit the demo section.** `git commit -m "demo: hel1 bring-up and first-party plain-SSH proof"`

---

### Task 8: Cut-over (Drew's go; Drew approves the npm publish)

- [ ] **Step 1: Release clients.** Drew approves and publishes charter-mcp 0.3.0 (`npx -y npm@latest stage publish` from `mcp/`), which now carries both the grant tools and plain-SSH lines. Update the MCP registry entry. Then, each with Drew's go: republish the ClawHub skill (`clawhub/charter-compute`, now version 0.2.0 and `charter-mcp@0.3`, so only after 0.3.0 is on npm) and the Arweave landing page (`site/index.html`), both rewritten for plain SSH.
- [ ] **Step 2: Door switch, one change.** Backup `door.env`; `CHARTER_DOOR_HOSTS` = hel1's `<pubkey>=<ilpBase>` only; rsync main to `/opt/charter` with the held-back web copy now included; rebuild the door. Check `/v1/offers` lists only `hel1-1` with `home.free 4`; `/llms.txt` shows plain SSH and the grants section.
- [ ] **Step 3: toon2 stops.** `systemctl --user stop charter-host` and `disable` on toon2 (the `toon` VM is not touched). The box ops env: `HOST_CHANNEL_ID` set to hel1's relay-write channel. Install `charter-home-ssh-check.sh` on the box (`install-box.sh`).
- [ ] **Step 4: Waiting grants.** Any `approved_waiting` grant opens on hel1 within a cycle; its grantee can ssh in. Check the fund's status and the box's SSH check say `ok`.
- [ ] **Step 5: Push and record.** Update `docs/demo.md` section 17 with the switch; `git push origin main` (Drew's go).
- [ ] **Step 6: Success test.** Run a fresh mystery-shopper pass against the live docs (separate session); record whether agents now rent.
