# Rolling the trixie home (OpenHuman, `charter-x402`) onto the live host and door

Branch `feat/openhuman-home`. Built on toon2 under new tags only, from the staged tree
`~/src/charter-trixie-build`: `charter-home:trixie-1116` (`940bf7093299`, 842 MB) and
`charter-hermes:trixie-1116` (`5cac2d5fffec`, 1.94 GB, BASE = the new home tag). `latest` is untouched
until step 2. What was checked and how: `docs/demo.md` section 15.

What changes for whom:

- A new home starts on Debian trixie (glibc 2.41) with `charter-x402` and a working plain `scp`.
- A home that is running keeps its container; it gets the new image only at its next re-create.
- A kept disk (Edison's `ac83e7d58faf521d`, closed since 11-16 02:48Z) opens under the new base next
  time. Hermes brings its own Python under `/opt`, so `charter-hermes` does not care. A venv a tenant
  made with Debian's `python3` (3.11 before, 3.13 now) must be made again.
- No host code changes: `charter-host` is not restarted and `~/.config/charter/env` stays as it is.
- The door changes only in what it serves: `/agents`, `/llms.txt` and the new `/openhuman/SKILL.md`.
  Those pages describe the new box, so move `latest` first and the door second.

## 0. Checks (read only)

```bash
ssh air
~/.local/lima/bin/limactl shell toon2
```

- `docker images | grep trixie-1116` shows both ids above.
- `df -h /` shows well over 3 GiB free (the host's floor for a new home disk).
- `jq -c '.[] | select(.state=="running" or .state=="awaiting_first_tick" or .state=="booting") | {id, state, image: .job.image}' ~/.local/share/charter/leases.json`
  lists what is live. A running home is left alone by this deploy.

## 1. Keep the old images by name

```bash
docker tag charter-home:latest charter-home:pre-1116
docker tag charter-hermes:latest charter-hermes:pre-1116
```

## 2. Point latest at the new builds

```bash
docker tag charter-home:trixie-1116 charter-home:latest
docker tag charter-hermes:trixie-1116 charter-hermes:latest
```

Nothing running changes. The next home open or re-create uses them.

## 3. Prove it with a real lease (about 0.014 USDC)

From the Mac, with a funded Base key (`~/keys/bazaar-payer` holds about 0.02 USDC; `exact`, no ETH needed)
and a fresh SSH key, so the home and its disk are new:

```bash
ssh-keygen -q -t ed25519 -N '' -C openhuman-proof -f ~/keys/openhuman-proof
CHARTER_X402_KEY_FILE=~/keys/bazaar-payer node jobs/home/x402-rent.mjs open --keys ~/keys/openhuman-proof.pub
node jobs/home/x402-rent.mjs status --lease <leaseId>     # until access.ssh is set
```

Then SSH in over an Anyone SOCKS port (the `toon` VM has one), follow `/agents#openhuman` to the letter
(install, start, boot script), and check: `ldd --version` says 2.41, `/health` is 200, the core's RSS
stays near 100 MB after a minute, `docker restart` of the box brings it back. For the second tick, paid
from inside: `charter-x402 address` in the box, send that address 0.01 USDC on Base, `charter-x402 renew
--once`. Let the lease lapse after; a home that paid keeps its disk 7 days.

## 4. The door

On the box, as in `docs/ops.md` ("Changing a price", step 3):

```bash
cp -a /opt/charter /opt/charter.bak-20261116-preopenhuman
# from the Mac, in the branch's tree: rsync without node_modules, dist, web/dist, .git, .superpowers, .worktrees; no --delete
docker compose -f /opt/charter/deploy/door/docker-compose.yml up -d --build
```

Check: `curl -s https://charter.mainnet.toonprotocol.dev/llms.txt | grep -c "OpenHuman on Charter"` is 1;
`/agents` has the `#openhuman` section; `/openhuman/SKILL.md` answers 200 as `text/markdown`; `/v1/offers`
still lists the offer; `docker logs charter-door` says `channel ready, headroom N`.

Before a tenant who pays through the door stays for weeks, look at that headroom: one x402 home costs the
door's outbound channel about 0.17 USDC a day (`docs/ops.md`, "A home paid through the door").

## 5. The home watch (optional, separate go)

`docs/ops.md`, "Home watch". It needs a place to send alerts from toon2: a copy of the alert bot's token
there, or an ntfy topic.

## Rollback

```bash
docker tag charter-home:pre-1116 charter-home:latest
docker tag charter-hermes:pre-1116 charter-hermes:latest
```

A home created meanwhile keeps running on the image it was created from until its next re-create. The
door: `rm -rf /opt/charter && mv /opt/charter.bak-20261116-preopenhuman /opt/charter`, then the same
`compose up -d --build`.

## Not covered

- An OpenHuman agent turn, and OpenHuman paying by itself: release v0.64.15 has no wallet or x402 RPC, and
  a turn needs the tenant's TinyHumans credential.
- A tenant with no Anyone client still cannot log in: the only address is the onion.
- `charter-x402` pays door leases only. A lease opened over TOON is renewed with `charter renew`.
- Mixing the two on one lease: a tick paid straight to the host is unknown to the door, whose next tick
  the host then calls a duplicate, and the door stops the lease.
