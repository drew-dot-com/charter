# Home Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `charter-home`, the third rentable job: a box with outbound network through the Anyone network, a 2 GiB disk that outlives the container, and SSH over an onion address as its only way in, so an agent (Edison first) can rent it and pay for it from inside.

**Architecture:** The home is a third job image with a `JobProfile`, rented through the same open, tick and status apps at the same prices. A predicate `isHome(lease)` keys the few rules that differ: a container exit does not end the lease, a host restart re-creates the box on the same disk, and a close keeps the disk for 7 days. Two new host modules do the host-side work: `src/host/homes.ts` (the home record, the ext4 image file and docker volume, the published port, the sweep) and `src/host/anon.ts` (one hidden service per home in Charter's own `anon`). The tenant CLI gains a `toon-client` payer and a `renew` command so the box can pay its own rent.

**Tech Stack:** TypeScript on Node 22, `node --test` with `tsx`, express, `@toon-protocol/client` 4.x, Docker 29 with `runsc`, `anon` 0.4.10.2 (Anyone's Tor fork), Debian bookworm-slim image. Host on toon2 (Lima VM, aarch64, on the Air), door on the Hetzner box.

**Spec:** `docs/superpowers/specs/2026-11-04-home-image-design.md`

## Global Constraints

- Image name `charter-home`; user `tenant` uid 10001; sshd on 2222 inside, published on `127.0.0.1:<port>` with ports from 22000 upward; onion port 22.
- Disk: 2 GiB ext4 image file, sparse, `truncate` then `mkfs.ext4 -F -q -m 0 -E root_owner=10001:10001`; the host attaches it with `sudo -n losetup` (re-attached on every ensureHome, since a reboot detaches it) and docker mounts the loop device as volume `charter-home-<homeId>` through its `local` driver (`type=ext4`, `device=/dev/loopN`), at `/home/tenant`. Refuse a new disk when less than 3 GiB would remain free.
- `homeId` = first 16 hex digits of SHA-256 over the normalized, sorted key lines (`type key`, comments dropped) joined by `\n`. 1 to 8 keys, each line at most 1024 bytes, types `ssh-ed25519`, `ecdsa-sha2-nistp256|384|521`, `ssh-rsa`.
- Retention: a home that paid at least one tick is kept 7 days (604 800 000 ms) after its last close; a home that never paid is removed at close. Sweep once an hour.
- Slots: `CHARTER_MAX_HOMES` (1 on toon2) counted inside `CHARTER_MAX_LEASES` (2). Offer gains `home: { diskGiB: 2, retentionDays: 7, slots: <maxHomes> }`.
- Egress: user-defined bridge `charter-home`, gateway `172.19.0.1`; anon `SocksPort 172.19.0.1:9050`, `HTTPTunnelPort 172.19.0.1:9080`, `DNSPort 172.19.0.1:53`; container `--dns 172.19.0.1`; firewall drops everything else from the bridge.
- Box env: `HTTP_PROXY=http://172.19.0.1:9080`, `HTTPS_PROXY` same, `ALL_PROXY=socks5h://172.19.0.1:9050`, `NO_PROXY=127.0.0.1,localhost`, `NODE_USE_ENV_PROXY=1`, `CHARTER_LEASE_ID`, `CHARTER_HOME_ID`, `CHARTER_OFFER_JSON`, `CHARTER_CONNECTOR_URL`, `CHARTER_PAID_THROUGH_FILE=/charter/paid-through`.
- Container flags for a home: `--cpus 1 --memory 1g --pids-limit 512 --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:size=256m --tmpfs /run --restart unless-stopped`, plus `--runtime runsc` on toon2 as every job.
- New close reason `home_in_use`. New lease fields `homeId`, `restarts`, `access`.
- No em dashes in anything that ships (code comments, docs, page copy, commit messages). Copy is honest: no uptime figure, "the operator can read your disk", "anyone with your public keys can open your home".
- `npm test` and `npm run typecheck` green before each commit. Existing tests that assert two images are updated, not deleted.
- Claude never moves Drew's funds; Drew moves every secret; mainnet only.

## Review Focus

- Keys that differ only in comment, order, trailing whitespace or CRLF must give the same `homeId`, and a duplicate key counts once. Pinned in Task 1.
- An open for a key set whose home already has a live lease must answer `closedReason: home_in_use` and create nothing. Pinned in Task 6.
- A running home whose onion hostname anon has not written yet must report `access: null` and keep running; the hostname is filled in later without a tenant action. Pinned in Task 7.
- A host restart after an outage longer than the paid time must close the home `missed_tick` and not re-create it; one inside the paid time must re-create it with `restarts` incremented. Pinned in Task 7.
- A home that closes with 0 ticks paid is removed at once; one with ticks paid is kept until exactly 7 days after `lastClosedAt`, and the sweep never touches a home with a live lease. Pinned in Tasks 4 and 7.

---

### Task 1: Key normalization and the home job in `src/jobs.ts`

**Files:**
- Modify: `src/jobs.ts`
- Test: `src/jobs.test.ts`

**Interfaces:**
- Produces: `export const HOME_IMAGE = 'charter-home'`; `JOB_IMAGES` becomes `[FETCH_IMAGE, PYTHON_IMAGE, HOME_IMAGE]`.
- Produces: `export const MAX_SSH_KEYS = 8`, `export const MAX_SSH_KEY_BYTES = 1024`.
- Produces: `export function normalizeSshKeys(v: unknown): string[] | null`: `v` is an array of strings; each trimmed line is `<type> <base64>[ <comment>]`; returns sorted, de-duplicated `"<type> <base64>"` lines, or null when `v` is not 1 to 8 valid lines.
- Produces: `export function homeIdOf(normalized: string[]): string` (SHA-256 of `normalized.join('\n')`, first 16 hex).
- Produces: `export function homeJob(normalized: string[]): JobSpec` = `{ image: HOME_IMAGE, args: { SSH_KEYS: normalized.join('\n') } }`.
- Produces: `jobFromBody(body: { urls?, python?, home? })` accepts `{ home: { sshKeys: string[] } }`, exactly one of the three.

- [ ] **Step 1: Write the failing tests** in `src/jobs.test.ts`

```ts
test('normalizeSshKeys: comment, order, CRLF and duplicates do not change the key set', () => {
  const a = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 edison@air\r\n';
  const b = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0' + 'A'.repeat(300) + '= x';
  const n1 = normalizeSshKeys([a, b, b]);
  const n2 = normalizeSshKeys([b.replace(' x', ''), a.trim()]);
  assert.deepEqual(n1, n2);
  assert.equal(n1!.length, 2);
  assert.equal(homeIdOf(n1!), homeIdOf(n2!));
  assert.match(homeIdOf(n1!), /^[0-9a-f]{16}$/);
});
test('normalizeSshKeys refuses what the box must not take', () => {
  const ok = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1';
  for (const [why, v] of [
    ['empty', []], ['nine', Array.from({ length: 9 }, (_, i) => ok.replace('5', String(i)))],
    ['not an array', ok], ['a number', [5]], ['unknown type', ['ssh-dss AAAA']],
    ['bad base64', ['ssh-ed25519 not*base64']], ['over 1024 bytes', ['ssh-rsa ' + 'A'.repeat(1100)]],
    ['a NUL', [ok + '\0']], ['a newline inside', ['ssh-ed25519 AAAA\nssh-ed25519 BBBB']],
  ] as const) assert.equal(normalizeSshKeys(v as unknown), null, why);
});
test('jobFromBody: { home: { sshKeys } } is a home job and excludes the other two', () => {
  const ok = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx1bWFueXJhbmRvbWJ5dGVzMTIzNDU2Nzg5MDEyMzQ1 c';
  assert.deepEqual(jobFromBody({ home: { sshKeys: [ok] } }), homeJob(normalizeSshKeys([ok])!));
  assert.equal(jobFromBody({ home: { sshKeys: [ok] }, urls: ['https://a.com'] }), null);
  assert.equal(jobFromBody({ home: { sshKeys: [] } }), null);
  assert.equal(jobFromBody({ home: 'x' }), null);
});
```
Update the first existing test to `assert.deepEqual(JOB_IMAGES, ['charter-job-fetch', 'charter-job-python', 'charter-home'])`.

- [ ] **Step 2: Run** `node --test --import tsx src/jobs.test.ts` and see the three new tests fail (`normalizeSshKeys is not a function`).
- [ ] **Step 3: Implement** the four exports in `src/jobs.ts`. Key line regex: type from the allowed list, one space, base64 `[A-Za-z0-9+/]+={0,2}`, optional space and a comment of printable ASCII (dropped). Reject any string with `\0` or an inner `\n`.
- [ ] **Step 4: Run** the file's tests; expected PASS.
- [ ] **Step 5: Commit** `feat(jobs): the home job and its key-set identity`.

---

### Task 2: Types, lease rules and the offer's home terms

**Files:**
- Modify: `src/types.ts`, `src/lease.ts`, `src/offer.ts`
- Test: `src/lease.test.ts`, `src/offer.test.ts`

**Interfaces:**
- Produces in `types.ts`: `CloseReason` adds `'home_in_use'`; `Lease` adds `homeId?: string`, `restarts?: number`, `access?: HomeAccess | null`; `export interface HomeAccess { ssh: { host: string; port: number; user: string } }`; `Offer` adds `home?: { diskGiB: number; retentionDays: number; slots: number }`.
- Produces in `lease.ts`: `export function isHome(l: Pick<Lease, 'job'>): boolean`; `newLease` sets `homeId` (via `homeIdOf(normalizeSshKeys(args.SSH_KEYS.split('\n')))`) and `restarts: 0` for a home; `onJobExit` returns a home lease unchanged; `export function onHomeRestarted(l: Lease): Lease` (restarts + 1, `access` unchanged).
- Produces in `offer.ts`: `offerToEvent` carries `home` in content when set; `offerFromEvent` accepts an absent `home`, returns null for a malformed one (any of the three not a positive integer); `export function offerToJson(o: Offer): string` and `export function offerFromJson(text: string): Offer | null` (same content shape plus `id` and `hostPubkey`, `expiresAt` may be 0).

- [ ] **Step 1: Write the failing tests**

```ts
// lease.test.ts
test('a home lease is born with its homeId and never becomes done on exit', () => {
  const job = homeJob(normalizeSshKeys([KEY])!);
  const l = newLease('a'.repeat(32), OFFER, job, 1000);
  assert.equal(isHome(l), true);
  assert.equal(l.homeId, homeIdOf(normalizeSshKeys([KEY])!));
  assert.equal(l.restarts, 0);
  const running = onTick(l, 0, 1000, 60_000).lease;
  assert.equal(onJobExit(running, 0), running);
  assert.equal(onHomeRestarted(running).restarts, 1);
  assert.equal(isHome(newLease('b'.repeat(32), OFFER, { image: 'charter-job-python', args: { SCRIPT: 'x' } }, 1000)), false);
});
// offer.test.ts
test('an offer carries its home terms through the event and through JSON', () => {
  const o: Offer = { ...BASE, home: { diskGiB: 2, retentionDays: 7, slots: 1 } };
  const ev = offerToEvent(o);
  assert.deepEqual(JSON.parse(ev.content).home, { diskGiB: 2, retentionDays: 7, slots: 1 });
  assert.deepEqual(offerFromEvent({ ...ev, pubkey: 'f'.repeat(64) }, 0)!.home, o.home);
  assert.equal(offerFromEvent({ ...offerToEvent({ ...o, home: { diskGiB: 0, retentionDays: 7, slots: 1 } }), pubkey: 'f'.repeat(64) }, 0), null);
  assert.equal(offerFromEvent({ ...offerToEvent(BASE), pubkey: 'f'.repeat(64) }, 0)!.home, undefined);
  const back = offerFromJson(offerToJson({ ...o, expiresAt: 0 }));
  assert.deepEqual(back, { ...o, expiresAt: 0 });
});
```
(`BASE` is the test file's existing well-formed offer with a future `expiresAt`; `KEY` a valid ed25519 line.)

- [ ] **Step 2: Run** both test files; expected FAIL on the new names.
- [ ] **Step 3: Implement** the type and function changes. `offerFromJson` reuses the content parser `offerFromEvent` uses (factor the content check into `parseOfferContent(c: Record<string, unknown>)`), skipping the expiry check.
- [ ] **Step 4: Run** `npm run typecheck` and the two files; expected PASS (typecheck will name every place that switches on `CloseReason`; add `home_in_use` there).
- [ ] **Step 5: Commit** `feat(lease): home leases, their close reason and the offer's home terms`.

---

### Task 3: Charter's own anon: one hidden service per home (`src/host/anon.ts`)

**Files:**
- Create: `src/host/anon.ts`
- Test: `src/host/anon.test.ts`

**Interfaces:**
- Produces: `export interface AnonDeps { hsDir: string; homesDir: string; pidFile: string; kill?: (pid: number, signal: 'SIGHUP') => void }`.
- Produces: `export class AnonError extends Error { code: 'no_pid' | 'bad_hostname' }`.
- Produces: `export function hiddenServiceConf(homesDir: string, homeId: string, port: number): string` returning exactly three lines: `HiddenServiceDir <homesDir>/<homeId>/hs`, `HiddenServiceVersion 3`, `HiddenServicePort 22 127.0.0.1:<port>`.
- Produces: `export async function publishHiddenService(d: AnonDeps, homeId: string, port: number): Promise<void>` (mkdir `<homesDir>/<homeId>/hs` mode 0700, write `<hsDir>/<homeId>.conf`, HUP); idempotent.
- Produces: `export async function retireHiddenService(d: AnonDeps, homeId: string): Promise<void>` (remove the conf if present, HUP; keys kept).
- Produces: `export async function onionHostname(d: AnonDeps, homeId: string): Promise<string | undefined>` (reads `<homesDir>/<homeId>/hs/hostname`; undefined when missing; `AnonError('bad_hostname')` unless it matches `/^[a-z2-7]{56}\.anyone$/`).
- Produces: `export async function reloadAnon(d: AnonDeps): Promise<void>` (reads the pid from `pidFile`, `kill(pid, 'SIGHUP')`; `AnonError('no_pid')` when the file is missing or not an integer).

- [ ] **Step 1: Write the failing tests** using `mkdtemp` directories and a recording `kill`:
  - `publishHiddenService writes the conf, makes the service dir 0700 and HUPs anon once` (asserts the exact three lines, `stat(...).mode & 0o777 === 0o700`, `kills` is `[[pid, 'SIGHUP']]`).
  - `retireHiddenService removes the conf, keeps the keys dir and HUPs` (write a fake `hs/hs_ed25519_secret_key`, assert it stays).
  - `onionHostname is undefined until anon writes it, then the trimmed address, and refuses junk` (write `abc…56 chars.anyone\n`; then write `nope` and assert `AnonError` with code `bad_hostname`).
  - `reloadAnon without a pid file throws no_pid and kills nothing`.
- [ ] **Step 2: Run** `node --test --import tsx src/host/anon.test.ts`; expected FAIL (module not found).
- [ ] **Step 3: Implement** `src/host/anon.ts` with `node:fs/promises` only; `kill` defaults to `process.kill`.
- [ ] **Step 4: Run** the file; expected PASS.
- [ ] **Step 5: Commit** `feat(host): hidden-service config for homes in Charter's own anon`.

---

### Task 4: Home records, disks, volumes, ports and the sweep (`src/host/homes.ts`)

**Files:**
- Create: `src/host/homes.ts`
- Test: `src/host/homes.test.ts`

**Interfaces:**
- Produces: `export interface HomeRecord { homeId: string; port: number; createdAt: number; paidOnce: boolean; lastClosedAt?: number }`.
- Produces: `export class HomeStore` with the same file-backed temp-and-rename pattern as `LeaseStore` (`constructor(file?: string)`, `get(id)`, `all()`, `put(rec)`, `delete(id)`).
- Produces: constants `HOME_DISK_GIB = 2`, `HOME_RETENTION_MS = 7 * 86_400_000`, `HOME_FREE_FLOOR_BYTES = 3 * 1024 ** 3`, `HOME_PORT_BASE = 22000`.
- Produces: `export function allocatePort(taken: Iterable<number>): number` (lowest integer >= 22000 not in `taken`).
- Produces: `export function volumeName(homeId: string): string` = `charter-home-<homeId>`; `export function diskPath(homesDir: string, homeId: string): string` = `<homesDir>/<homeId>/disk.img`.
- Produces: `export async function createDisk(tools: { truncate: Exec; mkfs: Exec }, file: string, gib: number): Promise<void>` running `truncate -s <gib>G <file>` then `mkfs.ext4 -F -q -m 0 <file>`; throws `HomeError('mkfs_failed', stderr)` on a non-zero exit.
- Produces: `export async function ensureVolume(docker: Exec, name: string, device: string): Promise<void>` (`docker volume inspect -f '{{index .Options "device"}}' <name>`; missing, or on another device after a checked `volume rm -f`: `docker volume create --driver local --opt type=ext4 --opt device=<device> <name>`, then re-inspect and `volume_failed` unless it is on `device`), `attachDisk(losetup, file)` / `detachDisk(losetup, device)` (`losetup -j`, `--find --show`, `-d`), `export async function removeVolume(docker: Exec, name: string): Promise<void>` (`docker volume rm -f <name>`, errors ignored).
- Produces: `export async function freeBytes(dir: string): Promise<number>` via `statfs` (`bavail * bsize`).
- Produces: `export function sweepDue(store: HomeStore, liveHomeIds: Set<string>, now: number): HomeRecord[]`: records with no live lease and (`!paidOnce` and `lastClosedAt` set) or (`lastClosedAt + HOME_RETENTION_MS <= now`).
- Produces: `export class HomeError extends Error { code: 'mkfs_failed' | 'no_disk' }`.

- [ ] **Step 1: Write the failing tests** with the `fake` exec double from `runner.test.ts` (copy it into this file):
  - `allocatePort gives 22000 first, skips taken ports and fills gaps` (`[22000, 22002]` → `22001`).
  - `createDisk runs truncate then mkfs with the pinned flags` (assert `calls[0].args` ends `['-s', '2G', file]` and `calls[1].args` is `['-F', '-q', '-m', '0', file]`; a mkfs exit 1 rejects `mkfs_failed`).
  - `ensureVolume creates the loop volume only when inspect fails` (inspect code 1 → create argv contains `--opt type=ext4 --opt device=/dev/loopN` (no `o=loop`) and the name; inspect code 0 → one call).
  - `HomeStore round-trips through its file like LeaseStore` (put, re-open from the path, get; delete removes).
  - `sweepDue: a never-paid home closed is due at once, a paid one exactly at 7 days, a live one never` (records: `{paidOnce: false, lastClosedAt: T}` due at `T`; `{paidOnce: true, lastClosedAt: T}` not due at `T + HOME_RETENTION_MS - 1`, due at `T + HOME_RETENTION_MS`; a paid record whose id is in `liveHomeIds` never; a record with no `lastClosedAt` never).
- [ ] **Step 2: Run** the file; expected FAIL (module not found).
- [ ] **Step 3: Implement** `src/host/homes.ts`.
- [ ] **Step 4: Run** the file; expected PASS.
- [ ] **Step 5: Commit** `feat(host): home records, loop-mounted disks and the retention sweep`.

---

### Task 5: The home profile and the home operations in the runner

**Files:**
- Modify: `src/host/runner.ts`
- Test: `src/host/runner.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: `JobProfile.network: 'proxy' | 'none' | 'home'` and `JobProfile.pidsLimit?: number` (default 256, used in place of the hard-coded value).
- Produces: `JOB_PROFILES[HOME_IMAGE] = { args: ['SSH_KEYS'], maxArgBytes: 9 * 1024, network: 'home', pidsLimit: 512, flags: ['--tmpfs', '/tmp:size=256m', '--tmpfs', '/run', '--restart', 'unless-stopped'] }`.
- Produces: `export interface HomeRunnerOpts { homesDir: string; network: string; gateway: string; socksPort: number; httpPort: number; homes: HomeStore; anon: AnonDeps; tools: { truncate: Exec; mkfs: Exec }; offerJson: string; connectorUrl: string; freeBytes?: (dir: string) => Promise<number> }`; `dockerRunner(opts)` gains `home?: HomeRunnerOpts`.
- Produces on `Runner`: `ensureHome(homeId: string): Promise<HomeRecord>` (record with a fresh port if new; disk if the file is missing, after the free-space check, `RunnerError('boot_failed', 'no disk')` under the floor; volume); `publishHome(homeId): Promise<void>`; `retireHome(homeId): Promise<void>`; `homeAccess(homeId): Promise<HomeAccess | null>` (`{ ssh: { host, port: 22, user: 'tenant' } }` once the hostname exists); `removeHome(homeId): Promise<void>` (volume, then `rm -rf <homesDir>/<homeId>`, then the record); `writePaidThrough(homeId, paidThrough: number): Promise<void>` (writes `<homesDir>/<homeId>/charter/paid-through` as the epoch ms in decimal with a newline, temp and rename).
- Produces: `create(leaseId, job)` for a home image adds, in order: `--network <network>`, `--dns <gateway>`, `-p 127.0.0.1:<port>:2222`, `--mount type=volume,src=charter-home-<homeId>,dst=/home/tenant`, `-v <homesDir>/<homeId>/charter:/charter:ro`, and `-e` for every box env variable in Global Constraints; it does not add `--add-host`, `CHARTER_PROXY` or the `/out` mount. Without `opts.home` a home image rejects `RunnerError('image_not_allowed')`.

- [ ] **Step 1: Write the failing tests** (fake exec; `homes` an in-memory `HomeStore`; `anon` pointed at a temp dir with a recording `kill`; `freeBytes` returning 10 GiB unless the test says less):
  - `create for a home puts the box on its network with its disk, its port and its env, and nothing of a job's` (argv has `--network charter-home`, `--dns 172.19.0.1`, `-p 127.0.0.1:22000:2222`, `--mount type=volume,src=charter-home-<id>,dst=/home/tenant`, `--pids-limit 512`, `--restart unless-stopped`, `-e HTTPS_PROXY=http://172.19.0.1:9080`, `-e ALL_PROXY=socks5h://172.19.0.1:9050`, `-e CHARTER_PAID_THROUGH_FILE=/charter/paid-through`, `-e CHARTER_OFFER_JSON=<offerJson>`; has no `/out`, no `--add-host`).
  - `ensureHome makes the disk and volume once and refuses a new disk under the free-space floor` (first call: truncate, mkfs, volume inspect, volume create; second call for the same id: inspect only; a fresh id with `freeBytes` 2 GiB: rejects `boot_failed` whose message contains `no disk`, no truncate call).
  - `publishHome and retireHome write and remove the hidden service and HUP anon` (reuse Task 3's assertions through the runner).
  - `homeAccess is null until the hostname exists` (write the hostname file; `{ ssh: { host, port: 22, user: 'tenant' } }`).
  - `removeHome removes the volume, the directory and the record`.
  - `writePaidThrough writes the epoch ms where the box reads it`.
- [ ] **Step 2: Run** `node --test --import tsx src/host/runner.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** in `runner.ts`. Put the home argv assembly in a function `homeArgs(profile, rec, homeId, leaseId, h: HomeRunnerOpts): string[]`.
- [ ] **Step 4: Run** the file and `npm run typecheck`; expected PASS (the `Runner` fakes in `loop.test.ts` and `server.test.ts` will need the new methods; add no-op defaults to their `fakeRunner`).
- [ ] **Step 5: Commit** `feat(runner): the home profile, its disk, port, onion and box env`.

---

### Task 6: Open, tick and status for a home in the host apps

**Files:**
- Modify: `src/host/server.ts`
- Test: `src/host/server.test.ts`

**Interfaces:**
- Consumes: `isHome`, `newLease` (Task 2); `ensureHome`, `publishHome`, `writePaidThrough` (Task 5).
- Produces: `HostDeps.maxHomes?: number` (default 0).
- Produces on `POST /open` for a home image: `SSH_KEYS` not normalizable → `400 bad_request`; `maxHomes` reached → `{ leaseId, state: 'closed', closedReason: 'busy' }`; a live lease with the same `homeId` → `{ leaseId, state: 'closed', closedReason: 'home_in_use' }`; otherwise `ensureHome` then `create`, a `RunnerError` from `ensureHome` answered like one from `create`.
- Produces on `POST /tick`: after every non-duplicate tick on a home, `writePaidThrough(homeId, paidThrough)`; after the start on tick 0 of a home, `publishHome(homeId)` (a failure there is logged, the tick still answers 200: the box is running and the next window tick retries, Task 7).
- Produces on `GET /leases/:id`: the lease as stored (`access`, `restarts`, `homeId` ride along; no new code beyond what the store holds).

- [ ] **Step 1: Write the failing tests** in `server.test.ts` (the file's `fakeRunner` gains recording `ensureHome`, `publishHome`, `writePaidThrough`):
  - `open for a home refuses bad keys, a full house and a home already in use` (bad keys 400; `maxHomes: 1` with one home live → `busy`; same key set as a live home with `maxHomes: 2` → `home_in_use` and `ensureHome` not called).
  - `open for a home makes the disk before the container, and a no-disk refusal is a boot failure` (`ensureHome` called before `create`; `ensureHome` rejecting `boot_failed no disk` → `closedReason: 'boot_failed', error: 'boot_failed'`).
  - `tick 0 on a home starts the box, publishes its onion and writes the paid time; tick 1 writes it again` (`publishHome` once, `writePaidThrough` twice with the second value one interval later).
  - `a home counts inside maxLeases` (`maxLeases: 1, maxHomes: 1`: a home live, a python open answers `busy`).
- [ ] **Step 2: Run** the file; expected FAIL.
- [ ] **Step 3: Implement** in `server.ts`.
- [ ] **Step 4: Run** the file; expected PASS.
- [ ] **Step 5: Commit** `feat(host): open, tick and status rules for a home`.

---

### Task 7: The loop: no exit watch, restart survival, access fill, close and sweep

**Files:**
- Modify: `src/host/loop.ts`
- Test: `src/host/loop.test.ts`

**Interfaces:**
- Consumes: `isHome`, `onHomeRestarted`, `due` (Task 2); `homeAccess`, `publishHome`, `retireHome`, `removeHome` (Task 5); `HomeStore`, `sweepDue` (Task 4).
- Produces: `LoopDeps.homes?: HomeStore` (required when any home lease exists; tests pass one).
- Produces in `windowTick`: a running home is never added to `watched`; a running home with `access` undefined or null calls `runner.homeAccess(homeId)` and stores the result when non-null; a running home whose record exists but whose onion conf is missing (tracked by a `published: Set<string>` on deps, like `watched`) calls `publishHome` once more.
- Produces in `close` for a home: after `runner.stop`, `retireHome`; if `paidIntervals === 0`, `removeHome` and `homes.delete`; else `homes.put({ ...rec, paidOnce: true, lastClosedAt: now })`.
- Produces in `reconcile`: a home in `running` whose container is not alive and `due(l, now) === null` is re-created (`runner.create(l.id, l.job)`, `runner.start(l.id)`, `publishHome`) and stored as `onHomeRestarted(l)`; a create or start failure closes it `host_restart`; a running home past its paid time is closed `missed_tick`; a home in `awaiting_first_tick` or `booting` is closed as a job is.
- Produces: `export const HOME_SWEEP_MS = 3_600_000` and `export async function homeSweep(deps: LoopDeps): Promise<string[]>` (removes every `sweepDue` record, returns the ids).

- [ ] **Step 1: Write the failing tests** (home leases built with `homeJob`, `homes` an in-memory `HomeStore` seeded with the record):
  - `windowTick never watches a home's exit and fills its access once anon has the hostname` (`exited` rejects if called; `homeAccess` returns null then a value; after two ticks the stored lease has `access.ssh.host`).
  - `a home that misses its tick keeps its disk when it paid, loses it when it never paid` (two leases: paid 1 → `retireHome`, record `paidOnce: true, lastClosedAt: now`; paid 0 → `removeHome`, record deleted).
  - `reconcile re-creates a paid home whose container is gone and counts the restart` (`alive` false, `now` inside paid time → `create`, `start`, `publishHome` called, lease `running`, `restarts: 1`).
  - `reconcile closes a home whose paid time ran out during the outage without re-creating it` (`now` past `paidThrough + GRACE_MS` → `closed missed_tick`, no `create` call).
  - `reconcile keeps a home docker already brought back` (`alive` true → no calls, lease unchanged).
  - `homeSweep removes what sweepDue names and nothing live` (one due, one live by lease, one paid and fresh → one `removeHome` call).
- [ ] **Step 2: Run** the file; expected FAIL.
- [ ] **Step 3: Implement** in `loop.ts`.
- [ ] **Step 4: Run** the file; expected PASS.
- [ ] **Step 5: Commit** `feat(loop): homes survive a host restart, keep their disk, and are swept after 7 days`.

---

### Task 8: Host configuration and wiring

**Files:**
- Modify: `src/host/config.ts`, `src/host/main.ts`
- Test: `src/host/config.test.ts`

**Interfaces:**
- Produces in `HostConfig`: `maxHomes: number` (`CHARTER_MAX_HOMES`, default 0); `home?: { dir: string; network: string; gateway: string; socksPort: number; httpPort: number; anonHsDir: string; anonPidFile: string; tenantConnectorUrl: string }` present when `maxHomes > 0`, from `CHARTER_HOME_DIR` (default `<dataDir>/homes`), `CHARTER_HOME_NETWORK` (default `charter-home`), `CHARTER_HOME_GATEWAY` (default `172.19.0.1`), `CHARTER_HOME_SOCKS_PORT` (9050), `CHARTER_HOME_HTTP_PORT` (9080), `CHARTER_ANON_HS_DIR` (required), `CHARTER_ANON_PIDFILE` (required), `CHARTER_TENANT_CONNECTOR_URL` (required, http(s) URL).
- Produces: `loadConfig` throws when `charter-home` is in `CHARTER_ALLOW_IMAGES` and `maxHomes` is 0, and when `maxHomes > maxLeases`; `offer.home` is `{ diskGiB: 2, retentionDays: 7, slots: maxHomes }` when `maxHomes > 0`, else absent.
- Produces in `main.ts`: a `HomeStore` at `<dataDir>/homes.json`; `dockerRunner({ ..., home })` with `tools: { truncate: execFileExec('truncate'), mkfs: execFileExec('mkfs.ext4') }`, `offerJson: offerToJson({ ...cfg.offer, expiresAt: 0 })`; `hostApps({ ..., maxHomes })`; `every(HOME_SWEEP_MS, () => homeSweep(deps), 'home sweep')`; `reconcile` unchanged in order (still before the apps listen).

- [ ] **Step 1: Write the failing tests** in `config.test.ts`: `a host with homes needs the anon paths and a tenant connector URL and advertises its terms` (full env → `maxHomes 1`, `offer.home` equal to the terms, `home.dir` default under `dataDir`); `the home image without a home slot is a configuration error` (`CHARTER_ALLOW_IMAGES` with `charter-home`, no `CHARTER_MAX_HOMES` → throws naming `CHARTER_MAX_HOMES`); `more home slots than lease slots is an error`.
- [ ] **Step 2: Run** the file; expected FAIL.
- [ ] **Step 3: Implement** `config.ts` and wire `main.ts`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expected all PASS.
- [ ] **Step 5: Commit** `feat(host): home configuration, store and sweep wired into the host process`.

---

### Task 9: The image: `jobs/home/`

**Files:**
- Create: `jobs/home/Dockerfile`, `jobs/home/home.sh`, `jobs/home/sshd_config`, `jobs/home/home.test.mjs`
- Modify: `package.json` (`test` glob already covers `jobs/**/*.test.mjs`)

**Interfaces:**
- Produces: image `charter-home`, `USER tenant` (uid 10001, home `/home/tenant`), `CMD ["/app/home.sh"]`, sshd on 2222.
- Produces `home.sh` (run as `tenant`, `set -eu`): `umask 077`; `mkdir -p ~/.ssh/host ~/.charter`; write `$SSH_KEYS` to `~/.ssh/authorized_keys` (replace, not append); `ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/host/ssh_host_ed25519_key` only when missing; if `~/.charter/boot.sh` is executable, `nohup ~/.charter/boot.sh >> ~/.charter/boot.log 2>&1 &`; `exec /usr/sbin/sshd -D -e -f /app/sshd_config`.
- Produces `sshd_config`: `Port 2222`, `HostKey /home/tenant/.ssh/host/ssh_host_ed25519_key`, `AuthorizedKeysFile .ssh/authorized_keys`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `UsePAM no`, `PermitRootLogin no`, `AllowUsers tenant`, `PidFile none`, `AllowTcpForwarding yes`, `GatewayPorts no`, `X11Forwarding no`, `ClientAliveInterval 60`, `StrictModes yes` (change to `no` only if the test shows unprivileged sshd refuses the volume's ownership, and record why in the file).
- Produces `Dockerfile`: `FROM debian:bookworm-slim`; apt `openssh-server openssh-client python3 python3-venv python3-pip git curl jq rsync tmux ca-certificates procps xz-utils`; Node 22 from the official tarball by `TARGETARCH` (pin one 22.x version); `uv` from its release tarball by arch (pin one version); `useradd --uid 10001 --create-home --shell /bin/bash tenant`; `COPY home.sh sshd_config /app/`; `ENV HOME=/home/tenant`; `USER tenant`.

- [ ] **Step 1: Write the failing test** `jobs/home/home.test.mjs`, skipped unless `docker info` succeeds and `CHARTER_IMAGE_TESTS=1` (image builds are minutes; CI has no docker daemon the test may use): build the image; `ssh-keygen` a throwaway key in a temp dir; `docker volume create` a temp volume; `docker run -d --read-only --tmpfs /tmp --tmpfs /run --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:0:2222 --mount type=volume,src=<vol>,dst=/home/tenant -e SSH_KEYS=<pub>` the image; find the port with `docker port`; `ssh -i key -p <port> -o StrictHostKeyChecking=no -o UserKnownHostsFile=<tmp> tenant@127.0.0.1 id -un` → `tenant`; `ssh … 'echo hi > ~/kept; printf "#!/bin/sh\ntouch ~/booted\n" > ~/.charter/boot.sh; chmod +x ~/.charter/boot.sh'`; `ssh-keyscan` the fingerprint; `docker restart`; `ssh … 'cat ~/kept; ls ~/booted'` → `hi` and the file exists; fingerprint unchanged; a second `docker run` with a different `SSH_KEYS` on the same volume refuses the first key (`ssh` exits 255). Remove the container, volume and image tag at the end.
- [ ] **Step 2: Run** `CHARTER_IMAGE_TESTS=1 node --test jobs/home/home.test.mjs` on a Linux docker host (toon2, or the `toon` VM); expected FAIL (no Dockerfile).
- [ ] **Step 3: Write** the three files.
- [ ] **Step 4: Run** the test again on the docker host; expected PASS. Record the image size in the Dockerfile's head comment.
- [ ] **Step 5: Commit** `feat(jobs): the home image, an unprivileged sshd on the tenant's disk`.

---

### Task 10: Host deployment files for anon and the home network

**Files:**
- Create: `deploy/host/charter-anon.service`, `deploy/host/anonrc`, `deploy/host/charter-home-net.service`, `deploy/host/charter-home-net.sh`, `deploy/host/install-home.sh`
- Modify: `deploy/host/env.example`, `docs/env.md`

**Interfaces:**
- Produces `anonrc` (template, `__HOME__` replaced by the install script): `AgreeToTerms 1`, `DataDirectory __HOME__/.local/share/charter/anon`, `PidFile __HOME__/.local/share/charter/anon/anon.pid`, `SocksPort 172.19.0.1:9050`, `HTTPTunnelPort 172.19.0.1:9080`, `DNSPort 172.19.0.1:53`, `Log notice file __HOME__/.local/share/charter/anon/anon.log`, `GeoIPFile` and `GeoIPv6File` pointing at the toon node's `anon` directory, `%include __HOME__/.config/charter/anon/hs.d`.
- Produces `charter-anon.service` (system unit): `User=<host user>`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`, `ExecStart=<home>/.local/bin/anon -f <home>/.config/charter/anon/anonrc`, `After=charter-home-net.service docker.service`, `Restart=always`.
- Produces `charter-home-net.sh` (root, idempotent): `docker network create --subnet 172.19.0.0/24 --gateway 172.19.0.1 charter-home` if missing; `iptables -C || iptables -I DOCKER-USER -i br-<id of charter-home> -j DROP`; `INPUT` rules in order: `-i br-… -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`, `-i br-… -d 172.19.0.1 -p tcp -m multiport --dports 9050,9080 -j ACCEPT`, `-i br-… -d 172.19.0.1 -p udp --dport 53 -j ACCEPT`, `-i br-… -d 172.19.0.1 -p tcp --dport 53 -j ACCEPT`, `-i br-… -j DROP`; the bridge name read from `docker network inspect -f '{{.Id}}'` (first 12 chars after `br-`).
- Produces `charter-home-net.service` (system unit, `Type=oneshot`, `RemainAfterExit=yes`, `After=docker.service`, `ExecStart=/usr/local/bin/charter-home-net.sh`).
- Produces `install-home.sh` (run with sudo on toon2): copies the node's current `anon` binary to `~/.local/bin/anon` (path from `pgrep -a anon`), renders `anonrc`, makes `~/.config/charter/anon/hs.d` and the data dir (0700), installs both system units and the net script, `daemon-reload`, `enable --now` both, writes a sudoers drop-in `/etc/sudoers.d/charter-home` allowing the host user `NOPASSWD: /usr/sbin/losetup` only (the one root command the host runs; toon2's user already has blanket sudo, the rule documents it), then prints the three checks: `ss -ltnp | grep 172.19.0.1`, `iptables -S DOCKER-USER`, `iptables -S INPUT | grep br-`.
- Produces in `env.example` and `docs/env.md`: `CHARTER_MAX_HOMES=1`, `CHARTER_ANON_HS_DIR=/home/<user>/.config/charter/anon/hs.d`, `CHARTER_ANON_PIDFILE=/home/<user>/.local/share/charter/anon/anon.pid`, `CHARTER_TENANT_CONNECTOR_URL=https://connector.mainnet.toonprotocol.dev/ilp`, the optional `CHARTER_HOME_*` with their defaults, and `CHARTER_ALLOW_IMAGES=charter-job-fetch,charter-job-python,charter-home`; one line each of why.

- [ ] **Step 1: Write** the five files and the two doc changes (there is no unit test for shell and unit files; the proof is Task 14's step 2).
- [ ] **Step 2: Check** `bash -n deploy/host/*.sh` and `systemd-analyze verify` is not available on the Mac, so read both units once against `charter-host.service` for form.
- [ ] **Step 3: Commit** `deploy(host): Charter's own anon and the home network with its firewall`.

---

### Task 11: The door and the storefront

**Files:**
- Modify: `src/door/server.ts:363-367`, `web/app.ts`
- Create: `web/keys.ts`, `web/keys.test.ts`
- Test: `src/door/server.test.ts`

**Interfaces:**
- Produces on the door's `POST /v1/leases`: the body type gains `home?: unknown` and is handed to `jobFromBody` as is (the host's `image_not_offered` check already covers an offer without the home).
- Produces on `GET /v1/leases/:id`: nothing new to code; the test pins that `lease.access`, `lease.restarts` and `lease.homeId` arrive as the host sent them.
- Produces in `web/keys.ts`: `export function parseSshKeys(text: string): string[] | string` (one key per line; the same rules as `normalizeSshKeys` written for the browser bundle, which does not import `src/`; an error message string on failure: `'Paste at least one SSH public key.'`, `'At most 8 keys.'`, `'Line N is not an SSH public key.'`).
- Produces in `web/app.ts`: `JobMode` gains `'home'`; when the offer lists `charter-home` the Rent form offers "A home (SSH keys)" with a textarea whose placeholder is `ssh-ed25519 AAAA… you@host`; the body is `{ offerId, home: { sshKeys } }`; the lease page shows, when `lease.access?.ssh` is set, one line `ssh -o ProxyCommand="nc -x 127.0.0.1:9050 %h %p" tenant@<host>` with a note "needs an Anyone client; see the agents page", and "address pending" while `access` is null on a running home; `restarts` is shown when above 0.

- [ ] **Step 1: Write the failing tests**: in `server.test.ts`, `a home body reaches the host and its access comes back through the door` (the file's fake host api records the `JobSpec` it was given and returns a lease with `access`; assert `image: 'charter-home'` reached it and the GET echoes `access`); in `web/keys.test.ts`, `parseSshKeys accepts one key per line and names the bad line`.
- [ ] **Step 2: Run** both; expected FAIL.
- [ ] **Step 3: Implement**; keep `web/app.ts` changes inside the existing `JobMode` switch and the lease page renderer.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run build:web`; expected PASS.
- [ ] **Step 5: Commit** `feat(door): rent a home through the door and see its address on the lease page`.

---

### Task 12: The tenant CLI pays from inside the box: `toon-client` payer, `--home`, `renew`

**Files:**
- Create: `src/payer-env.ts`, `src/payer-env.test.ts`
- Modify: `src/cli.ts`, `src/tenant/run-lease.ts`, `src/door/main.ts:26-42`
- Test: `src/cli.test.ts`, `src/tenant/run-lease.test.ts`

**Interfaces:**
- Produces in `payer-env.ts`: `export function toonClientConfigFromEnv(env: Record<string, string | undefined>): ToonClientPayerConfig` reading `CHARTER_TOON_CONNECTOR_URL`, `CHARTER_TOON_KEY_FILE`, `CHARTER_TOON_CHANNEL_STORE`, `CHARTER_TOON_CHAIN` (`evm` | `solana`), optional `CHARTER_TOON_RPC_URL_FILE` (the door's current rules, moved here); `src/door/main.ts` calls it.
- Produces in `cli.ts`: `CliDeps.makePayer: (env) => Promise<Payer>`: `CHARTER_PAYER` unset or `toon` → `new ToonCli({ passphraseFile })` as today; `toon-client` → `ToonClientPayer.create(toonClientConfigFromEnv(env))`. In the box `CHARTER_CONNECTOR_URL` is used when `CHARTER_TOON_CONNECTOR_URL` is unset.
- Produces: `rent --home <keys file>` (one public key per line, `normalizeSshKeys`, `homeJob`), exclusive with `--urls` and `--python`; the progress line after open prints the lease id, and after the first status with `access` prints the `ssh` line to stderr.
- Produces: `charter renew --offer <ref> --lease <id> --from <index> --max-intervals <n> [--relay <url>] [--json]`; when `CHARTER_OFFER_JSON` is set the offer is `offerFromJson` of it and `--relay` is not needed (for `rent` and `status` too).
- Produces in `run-lease.ts`: `export async function continueLease(api: HostApi, o: Offer, leaseId: string, opts: RunLeaseOpts & { from: number }): Promise<RunLeaseResult>`: today's loop after the open, with `ticksSent` starting at `from` and `paidUntil` seeded from the first status read's `paidThrough` (host clock, accepted here because the tenant was not the one who paid before); `runLease` becomes open then `continueLease(..., { from: 0 })`.

- [ ] **Step 1: Write the failing tests**:
  - `payer-env.test.ts`: `toonClientConfigFromEnv needs the four variables and reads the RPC URL from a file` (missing one → throws naming it; a file with `https://rpc.example` → `rpcUrl`).
  - `run-lease.test.ts`: `continueLease pays from the given index and stops at max-intervals without opening` (fake api: `open` throws if called; `status` returns running with `paidThrough`; assert ticks `[2, 3]` for `from: 2, maxIntervals: 2`).
  - `cli.test.ts`: `rent --home reads keys from a file and opens a home job` (fake payer records the open body: `image: 'charter-home'`, `SSH_KEYS` normalized); `renew attaches to a lease and pays from --from` (tick indexes seen `[1, 2]`); `CHARTER_OFFER_JSON replaces the relay read` (`fetchOffers` throws if called); `CHARTER_PAYER=toon-client builds the client payer from env` (a `makeClientPayer` dep in `CliDeps`, defaulting to `ToonClientPayer.create`, records the config).
- [ ] **Step 2: Run** the three files; expected FAIL.
- [ ] **Step 3: Implement**. Update `USAGE` in `cli.ts` with the two new forms and one line on `CHARTER_PAYER` and `CHARTER_OFFER_JSON`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`; expected PASS.
- [ ] **Step 5: Commit** `feat(cli): rent a home, renew a lease from inside it, pay with toon-client`.

---

### Task 13: Documents: the agents page, llms.txt, the skill, the README, the landing source, ops and demo

**Files:**
- Modify: `web/agents.html`, `web/llms.txt`, `plugins/charter/skills/renting-charter-compute/SKILL.md`, `plugins/charter/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (0.2.0 to 0.3.0), `README.md`, `site/index.html`, `docs/ops.md`, `docs/demo.md`

**Interfaces:**
- Produces, in every agent-facing document, a Home section that states exactly: the open body `{ "offerId": "…", "home": { "sshKeys": ["ssh-ed25519 AAAA… comment"] } }`; the status shape with `access.ssh` (`host`, `port` 22, `user` `tenant`) and `access: null` while the onion is being published (poll about once a minute); the `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@<host>` line and that a toon node has such a port; "no Anyone client, no way in"; the proxy variables and that raw sockets to the internet fail; `~/.charter/boot.sh`; `/charter/paid-through`; 2 GiB disk; 7 days free retention after a paid lease, removal at close for an unpaid one; "the same keys open the same home; there is no key rotation"; "anyone with your public keys can open your home and hold it, though not enter it"; "the operator can read your disk"; the uptime list from the spec word for word; one home slot on the live host; "what to tell your operator": 5 USDC a month in a channel plus a little Base ETH for the channel open, and 2 USDC in the box's own channel if it pays its own rent.
- Produces: the sentence "Today only the two jobs run, and the python job has no network, so this is an hour of sandboxed compute at a time, not yet a server to live in." is replaced in `llms.txt` and `agents.html` with the true state: three jobs, the home has network through the Anyone network, a 2 GiB disk and SSH in, one slot.
- Produces in `SKILL.md`: the `rent --home` and `renew` commands with the `toon` binary, and a "paying from inside" paragraph naming `CHARTER_PAYER=toon-client`, `CHARTER_OFFER_JSON` and `CHARTER_CONNECTOR_URL` as set in the box.
- Produces in `docs/ops.md`: a "Homes" section (a `charter-host` restart is now safe for homes; what `homes.json` holds; the sweep; the two system units and how to check them; growing the Lima disk, which closes every lease). Produces in `docs/demo.md`: section 8, the first home and Edison's move, filled in during Task 14 and 15.
- Produces in `site/index.html`: the three jobs in the "What runs" copy and the Home line; committed, not republished (Drew's paid write).

- [ ] **Step 1: Write** the changes. Run `grep -rn -P '\x{2014}' web/agents.html web/llms.txt README.md site/index.html plugins docs/ops.md docs/demo.md` and expect no output.
- [ ] **Step 2: Build** `npm run build:web`; open `web/dist/agents.html` in a browser and read the Home section once as an agent would: every claim must be something Task 14 proves.
- [ ] **Step 3: Commit** `docs: the home image for agents, the skill, ops and the landing source`.

---

### Task 14: Deploy to toon2 and the door, and prove it over TOON (with Drew)

**Files:**
- Modify: `docs/demo.md` (section 8), `docs/ops.md` (what was run)

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build` on the Mac. Tar `dist`, `src`, `package.json`, `jobs/home`, `deploy/host`; `scp` to the Air; `limactl copy` into toon2; untar over `~/src/charter`; `chmod +x dist/host/main.js`.
- [ ] **Step 2:** In toon2: `docker build -t charter-home jobs/home` and `CHARTER_IMAGE_TESTS=1 node --test jobs/home/home.test.mjs` (PASS). Ask Drew whether to grow the Lima disk now (it closes every lease). Confirm no live lease (the `jq` line in `docs/ops.md`). `sudo bash deploy/host/install-home.sh`; the three checks print anon listening on `172.19.0.1:9050`, `9080`, `53`, the `DOCKER-USER` drop and the seven `INPUT` rules. Prove the fence: `docker run --rm --network charter-home --dns 172.19.0.1 curlimages/curl -sS -m 10 https://example.com` fails, the same with `-x http://172.19.0.1:9080` prints the page, and `curl -m 5 http://172.19.0.1:22` and `http://172.17.0.1:9150` fail. From inside a box (here a container on `charter-home` with `--dns 172.19.0.1`, as a box runs): `getent hosts example.com` resolves (proves DNS over anon through docker's resolver), `curl --noproxy '*' -m 10 https://example.com` fails, and `curl -4 --noproxy '*' -m 10 http://172.19.0.1:9050` is refused, not hung.
- [ ] **Step 3:** Back up `~/.config/charter/env`; add `CHARTER_MAX_HOMES=1`, `CHARTER_ANON_HS_DIR`, `CHARTER_ANON_PIDFILE`, `CHARTER_TENANT_CONNECTOR_URL`, and `charter-home` to `CHARTER_ALLOW_IMAGES`. `systemctl --user restart charter-host`. `charter-host offer --print` shows three images and `home: { diskGiB: 2, retentionDays: 7, slots: 1 }`.
- [ ] **Step 4:** Door: `cp -a /opt/charter /opt/charter.bak-<date>`, rsync, `docker compose … up -d --build`; `GET /v1/offers` lists the home and its terms; a bare `POST /v1/leases` with a home body answers `awaiting_first_tick` and lapses to `missed_tick` after 90 s with its disk removed (`homes.json` has no record).
- [ ] **Step 5:** Proof from the `toon` VM (Edison's node, cents): `charter rent --offer <ref> --home test.pub --max-intervals 2 --relay wss://relay.mainnet.toonprotocol.dev`; `access.ssh.host` within a minute; `ssh` in over the node's SOCKS port; `curl https://example.com` succeeds, `curl --noproxy '*' -m 10 https://example.com` fails, `getent hosts example.com` resolves (proves DNS over anon through docker's resolver), and `curl -4 --noproxy '*' -m 10 http://172.19.0.1:9050` is refused, not hung; `echo kept > ~/kept`; `systemctl --user restart charter-host` on toon2 and confirm the box is untouched (`restarts` 0, the ssh session still up; a host restart leaves a running home alone); then `docker rm -f charter-<leaseId>` in toon2 and restart `charter-host` again, the box is back with `kept` and `restarts: 1`; let the lease lapse, open again with the same key, find `kept` and the same onion address. Record every id, the fulfils and the spend (about 0.02 USDC) in `docs/demo.md` section 8.
- [ ] **Step 6:** From inside the box, one `charter status` with `CHARTER_PAYER=toon-client` against a channel Drew funds (Drew's transfer, Base ETH for gas included): proves the proxy path for the payer. If Node's env proxy does not carry it, record the `EnvHttpProxyAgent` fix in the Dockerfile and `docs/ops.md`. This step is a gate: if `NODE_USE_ENV_PROXY`/the client does not carry the proxy, the docs' sentence about Node fetch (`NODE_USE_ENV_PROXY=1` is set for Node, on the agents page, `llms.txt` and the skill) must change before the door republish.
- [ ] **Step 7: Commit** `docs: the first home on toon2, proven over TOON`.

---

### Task 15: Edison moves in (Drew's go, Drew at the keyboard for secrets)

**Files:**
- Modify: `docs/demo.md` (section 8), memory file `project_charter.md` (RESUME)

- [ ] **Step 1:** Open Edison's home from the `toon` VM with Edison's own key pair (generated by Drew; its public key is the home's identity).
- [ ] **Step 2:** Over SSH: `uv` installs Hermes; Drew copies `~/.hermes` config and `.env` with `scp`; the charter CLI is installed; `~/.charter/boot.sh` starts the gateway and runs `charter renew --lease <id> --from <next index> --max-intervals <n>` with `CHARTER_PAYER=toon-client` against a Base channel key Drew funds (2 USDC plus gas).
- [ ] **Step 3:** The box answers a Telegram message and pays one tick on its own before the Air's gateway is stopped. Then stop the Air's gateway.
- [ ] **Step 4: The milestone:** from the box, one paid packet to Jonathan's node through Drew's edge (a paid write to `g.toon.relay` at price 2, or a tip once his hub routes it). Record the fulfil and the event id in `docs/demo.md` and the memory file: the first two-hop payment, box to edge to Jonathan, from one channel.
- [ ] **Step 5: Commit** `docs: Edison lives on Charter; first two-hop payment through the mesh`.
