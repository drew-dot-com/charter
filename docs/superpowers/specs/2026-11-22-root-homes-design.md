# Root homes: log in as root, install with apt

Approved by Drew in chat, 2026-11-22 ("Yes, build it"), after a throwaway test on hel1.

## Why

Three mystery-shopper agents compared Charter with four other sellers on 2026-11-22. None picked
Charter. The objection all three raised first: no root, a read-only system, so no `apt`. The
sellers they picked instead hand over a root login.

## Goal

A new home on a host that turns this on is reached as `root@` as well as `tenant@`, with the same
keys, and `apt-get install` works and survives restarts and new leases.

## Not goals

- No change to homes that already exist, or to a host that leaves the setting off.
- No direct network: a home's traffic still leaves only through the host's Anyone client.
- No `sudo` for `tenant`. gVisor ignores the setuid bit on mounted volumes (seen in the test), so
  the way to root is to log in as root.

## Must not happen

- A tenant reaching the host, another home, or the network outside the proxy.
- A tenant filling the host's disk.
- This mode running without gVisor.

## Approaches

1. **A package manager in the tenant's own folder** (micromamba, Homebrew). No root needed and no
   change to isolation. Rejected: it is not `apt`, agents do not reach for it, and "no root" stays
   true in every comparison.
2. **A writable container layer.** Drop `--read-only`, run as root. Rejected: the layer lives on
   the host's disk with no size bound, and it is lost whenever the container is re-created.
3. **The system on the tenant's own disk** (chosen). `/usr`, `/etc`, `/var`, `/root` and
   `/home/tenant` are folders of the home's own 10 GiB disk. Bounded by that disk, kept across
   restarts and leases, and the image stays read-only everywhere else.

## Design

**Setting.** `CHARTER_HOME_ROOT=1` on the host. It is refused unless `CHARTER_RUNTIME=runsc`. The
offer then carries `home.root: true`.

**Which homes.** A home made while the setting is on is recorded with `layout: 2`. A record
without it is an old home and runs exactly as before, whatever the setting says.

**The disk (layout 2).** Formatted with root owning its top folder. Inside:

| folder on the disk | mounted at | owner |
| --- | --- | --- |
| `home/` | `/home/tenant` | tenant (10001) |
| `root/` | `/root` | root |
| `sys/<image>/usr`, `etc`, `var` | `/usr`, `/etc`, `/var` | root |

Each is a docker `volume-subpath` mount of the home's one volume. The tenant never sees the disk's
top folder or `sys/<image>`, only what is under the five mounted folders, so it cannot swap a
mounted folder for a link. Docker refuses a subpath that resolves outside the volume in any case
(tested on hel1, docker 29.10: absolute and relative links both refused).

**One system per image.** `charter-home` and `charter-hermes` each get their own `sys/<image>`,
because their `/usr` differ. `home/` and `root/` are shared. Packages installed under one image
are not there under the other.

**Seeding.** Before the first container for a (home, image) pair, the host runs the image once
with the whole volume at `/disk`, as root with no network, and `/app/seed.sh` copies the image's
`/usr`, `/etc` and `/var` into `sys/<image>`, about 0.5 GiB. This one step runs on docker's own
runtime, not gVisor: measured on hel1 the copy takes 3 s that way and 17 s through gVisor, and it
happens inside the paid open. It runs only the image's own script, and touches only folders of the
disk a tenant cannot reach or replace, so nothing of the tenant's is run or read outside gVisor. The record lists the
images seeded, so it runs once. From then on the image's own `/usr`, `/etc` and `/var` no longer
reach that home: updates to the image do not either, as on any VPS.

**The container.** Still `--read-only`, `--cap-drop ALL`, `no-new-privileges`, gVisor, the
`charter-home` network and its firewall, 1 CPU, 1 GiB, 512 processes. Added for layout 2: it runs
as root with eight capabilities, the ones `apt`, `dpkg` and `sshd` need: `CHOWN`, `DAC_OVERRIDE`,
`FOWNER`, `FSETID`, `SETUID`, `SETGID`, `KILL`, `SYS_CHROOT`. Not added: `NET_RAW`, `NET_ADMIN`,
`SYS_ADMIN`, `MKNOD`. In the test, root in such a box could not open a raw socket, reach the
internet or the host's ports directly, or mount anything.

**Start script.** `home.sh`, as root: writes both users' `authorized_keys` and SSH environment,
makes the host key once (in `/root/.ssh/host`, shared by both images), writes apt's proxy setting
(`socks5h` to the host's Anyone port), starts the log cap and the tenant's `boot.sh` as `tenant`,
then runs `sshd` as root with `AllowUsers tenant root` and `PermitRootLogin prohibit-password`.

## What changes for trust

Today a tenant is an unprivileged user inside gVisor. After this a tenant is root inside gVisor.
gVisor and the host firewall stay; the non-root layer goes. gVisor is built to hold a root
workload, and every job on hel1 already runs under it.

A tenant can now break its own system (a bad `/etc/passwd` locks SSH out). The disk's `home/` and
`root/` are untouched by that, but there is no reset command yet: the way back is a new key set.

## Left to the builder

- The first open of a root home takes about 3 s longer (the seed); later opens do not.
- `nosuid,nodev` on the volume mount was considered and left out: the host never executes from it
  and gVisor ignores setuid there.
