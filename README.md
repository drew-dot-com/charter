# Charter

[![CI](https://github.com/drew-dot-com/charter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/drew-dot-com/charter/actions/workflows/ci.yml)

Compute leases paid over x402 in USDC on Base. Anyone can run a host: it registers its HTTPS address
with the door, the door probes it, and once it passes it is listed. A renter pays the door per interval,
the door pays the host per interval, and a container runs the renter's job for as long as the payments
keep arriving. There is no account on either side. A home is reached with plain SSH at the host's public
address.

**Hosts are run by independent operators.** Charter does not vet them. An operator can see what runs on
its machine and read a home's disk. Each offer carries the host's record at the door, so a renter can see
what it has done.

**Grants.** A fund pays 30 days of a home to agents that pitch a use for one. Pitching is free and needs
only an SSH public key: `POST https://charterhome.dev/v1/grants`, or `npx -y charter-mcp@latest pitch`.
The balance, the grants left and every decision are public at https://charterhome.dev/grants.
A grant opens only on a host with a record (at least 5 finished paid leases and no failed probe in 7 days).

**Monthly allowance.** An agent whose home has paid its first hour can ask for a link
(`POST https://charterhome.dev/v1/allowances` with the home's `sshKeys`, or the MCP tool
`charter_allowance_link` from charter-mcp 0.5.0) that its person opens to approve a monthly Base spend
permission; Charter then keeps the home paid. The person needs a Base Account (a Coinbase sign-up with an
email), a pop-up to allow and one signature. The agent reads the state (`charter_allowance_status` or `GET /v1/allowances/<id>`) and resumes its own
renewing whenever it is not `active`: `waiting` (send the link; it expires after 7 days), `approved`
(Charter is checking), `active` (Charter pays; stop your own loop), `short` (the person's account lacks
USDC; Charter retries hourly; ask them to top up, keep your loop as a fallback), `spent_for_period` (resumes
when the 30-day period resets), `stopping` then `ended` (over, credit refunded; renew yourself),
`refused` or `expired` (ask for a new link). Stop it with `POST /v1/allowances/<id>/stop` and the owner
token. Homes only, not jobs.

**Status: v1.** Every lease so far has Drew Pierson on both sides: he runs the door, the first host and
both renters. There are no outside hosts or renters yet. Four job images:
`charter-job-python` runs the renter's own Python script (up to 8 KiB, NumPy included) with no
network at all and returns its stdout, stderr and exit code; `charter-job-fetch` fetches up to five
pages in a headless browser and returns a screenshot and the text of each; `charter-home` is a box
the renter lives in: a disk kept between leases, plain SSH in at the host's public
address (`ssh -p <port> tenant@<host>`), network out only through the host's Anyone client on a host set
up as `deploy/host/` does, and `charter-x402` in it to pay the rent from a Base wallet by plain x402
(`jobs/home/x402-rent.mjs`); `charter-hermes` is the same home with Hermes Agent and the `charter` CLI
preinstalled and a default boot that runs them (the boot pays the box's own rent). Why the python job is
safe enough for a home host: `docs/superpowers/specs/2026-10-17-python-job-design.md`. The home's design:
`docs/superpowers/specs/2026-11-04-home-image-design.md`.

## How it works

```
renter --x402 (exact | batch)--> door --x402 batch voucher--> host (charter-host + Caddy)
```

- **Offer.** A host serves `GET /v1/offer` (free) at its public HTTPS address: size, interval, tick price,
  images, home slots and its `payTo` on Base. Its URL is its identity: `hostId` is the sha256 of the
  normalized URL, and an offer id is `<hostId>:<id>`.
- **Joining.** At boot the host sends its URL to the door (`POST /v1/hosts`). The door reads the offer and
  queues a probe: a paid `charter-job-python` lease that hashes a nonce the door picked. A host is listed
  once a probe passes. Probes run at most once a day per host, and the door starts only a few first probes
  a day. A probe pays at most 0.01 USDC for its tick; a host priced above that fails it.
- **Record and ranking.** The door keeps each host's record: probes passed, leases finished, success rate.
  Hosts under 80% success are skipped while a better one fits; then hosts with a record go before new ones;
  then the lower price. For a home, a host whose homes have run a paid lease goes before an untested one.
  Two failed leases in a row, or a failed probe, hide a host until a probe passes; three failed probes in a
  row drop it, and it must register again.
- **Paying.** The renter pays the door over x402 on Base (`exact`, or `batch-settlement` from a channel).
  The door pays the host from its own key over one x402 `batch-settlement` channel per host: one voucher
  per paid tick, at the tick price the lease opened with, and only after the renter's payment verified.
  Opens and status reads between door and host are free. The host claims its vouchers through the
  facilitator (PayAI by default). The door adds `CHARTER_DOOR_FEE` per tick (0 today).
- **Lease.** The container is created at open and started only once the first interval is paid. A lease
  whose renter stops paying is closed at the end of the paid time. A home stays on the host that holds its
  disk.

Prices: each host sets its own. The first host charges 0.007 USDC an hour (about 5 USDC for 30 days);
opens and status reads are free. Until 2026-11-04 the interval was 30 seconds at 0.005.

## Rent

From a browser: open the storefront at https://rent.charterhome.dev, connect a wallet holding USDC on Base, pick a machine, enter
URLs and click Rent. Your wallet signs once to put a deposit (at least 0.10 USDC) into an x402
channel. Each interval after that is signed by the page, silently. What you do not use comes back
when the lease ends.

From an agent over HTTP, with an x402 client and USDC on Base: https://charterhome.dev/agents
walks through every call and every price; https://charterhome.dev/llms.txt is the
summary a model reads first. `scripts/bazaar-tick.mjs` is a worked example: one python lease, one tick
paid with `@x402/fetch` from a key file, so a facilitator with a catalog lists the route (`--dry-run`
pays nothing).

From any MCP client (Claude Code, Claude Desktop, Cursor and others): `claude mcp add charter -- npx -y charter-mcp`. A client that takes only a remote address can use `https://charterhome.dev/mcp` (streamable HTTP): the free tools only, with no wallet, so it reads offers and leases and pitches the grant fund but cannot rent. The server keeps its own wallet in a key file, pays one x402 payment a tool call within an hourly and a daily cap, and needs no account. Source and the full tool list: [mcp/](mcp/).

From a shell, with the `charter` CLI (`npm ci && npm run build && npm install -g --prefix ~/.local .`):

```sh
charter offers
CHARTER_KEY_FILE=~/.charter/payer.key charter rent --python job.py --max-intervals 1 --json
charter status <leaseId>
```

`CHARTER_KEY_FILE` names a file holding one Base private key in hex; `charter address` prints its
address, which needs USDC on Base and no ETH. `rent` and `renew` pay the door `exact` in USDC, at most
`CHARTER_MAX_TICK` micro-USDC a tick (default 10000, 0.01 USDC). `CHARTER_DOOR_URL` (or `--door`)
names another door. Without `--offer`, `rent` takes the first offer in the door's ranking that runs the
job.

### A home

Open with your SSH public keys (one per line in a file) instead of a job:

```sh
charter rent --home keys.pub --max-intervals 2
```

Over HTTP, `POST /v1/rent` takes `{ "home": { "sshKeys": ["ssh-ed25519 AAAA... comment"] } }` (`offerId` optional; `POST /v1/leases` needs it).
The lease status carries `access: { "ssh": { "host": "<IPv4 or hostname>", "port": <22000..22099>, "user": "tenant" } }`
(it can be filled at once; `null` until then, so poll about once a minute) and the CLI prints the
line to log in with, plain SSH, no Anyone client needed:

```sh
ssh -p <port> tenant@<host>
```

The host and port come from `access.ssh`. The port is fixed per home: the same keys reopen the same
home, disk and port. A host may also publish `access.onion` (same shape, `<56 chars>.anyone`, port
22) as a second way in; that one needs an Anyone client. The box is Debian with
Python 3, `uv`, Node 22 and git, as `tenant` (and `root` with apt, on a host whose offer says
`home.root`), 1 CPU and 1 GiB. On a host set up as `deploy/host/` does, everything it sends leaves
through the host's Anyone client (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` are set; a raw socket to
the internet fails). `~/.charter/boot.sh` runs at every start, and `/charter/paid-through` holds when
the paid time runs out.

The key set is the home's identity: the same keys open the same disk and the same port,
and there is no key rotation. A home that paid a tick is kept 7 days, free, after its
lease closes; one that never paid is removed at close. Anyone with your public keys can open your
home and hold it, though not enter it. The host's operator can read your disk: secrets go in over SSH,
never through Charter. Homes are limited (`home.slots` in the offer), an open answers `busy` when they are full, and grants from the fund may hold them.

A home lives on the host that holds its disk: a re-open or a renewal with the same keys goes there,
whatever the ranking says. If that host is hidden or gone, the door answers `home_host_gone` rather than
start an empty home elsewhere. Once the door has dropped that host, naming another offer (`--offer`, or
`offerId`) opens a fresh, empty home on purpose.

What a host promises about uptime:

- No uptime figure. Expect restarts. Your disk survives them; your processes do not, so put what
  must run in `~/.charter/boot.sh`.
- A tick pays an hour from the end of the paid time. Pay the next tick half an hour early (the
  tenant loop already does) so a short outage does not end the lease. Paying several ticks ahead
  buys that much patience and nothing else; a lease that closes refunds nothing.
- A closed home keeps its disk and port for 7 days. Open again with the same keys.
- A restart of the host program leaves a running home alone. A reboot of its VM puts a paid home
  back on its disk (`restarts` goes up), as long as the paid time has not run out.

From inside the box, `CHARTER_DOOR_URL` and `CHARTER_LEASE_ID` are set for you. A `charter-hermes` box
keeps paying with the same CLI and its own key:

```sh
CHARTER_KEY_FILE=~/.charter/payer.key charter renew --lease "$CHARTER_LEASE_ID" --max-intervals <n>
```

A `charter-home` box does the same with `charter-x402 renew --max-intervals <n>` (its key is
`~/.charter/x402.key`). `renew` pays each tick when it is due, so restarting `boot.sh` costs nothing
extra. After `<n>` ticks it exits and nothing pays, so a box that should stay up runs `renew` again or
picks `<n>` for the time wanted. A home costs about 5 USDC for 30 days on the first host; the box's
wallet needs USDC on Base and nothing else. The whole of it, for agents, is
https://charterhome.dev/agents#home.

From an agent (Claude Code): the `charter` plugin in this repo is a skill that walks through renting
over x402.

```sh
/plugin marketplace add drew-dot-com/charter
/plugin install charter@charter
```

The skill is `plugins/charter/skills/renting-charter-compute/SKILL.md`; its `references/lease-loop.sh`
runs one whole lease as one command.

### Referrals

A rent request can name a referral: `POST /v1/rent` (or `POST /v1/leases`) takes `"referral": "<0x address on Base>"`
(the `charter-mcp` tools `charter_run_python`, `charter_fetch_pages` and `charter_rent_home` take `referral` too; its shell commands and the `charter` CLI do not). That address earns a share of every hour the renter pays for. It
costs the renter nothing: the price is the same with or without it.

- **Who earns.** The rate is in `GET /v1/door` as `referral.bps` (1000 is 10%), and it is absent when the door
  pays none. An offer that carries `referralShare` (micro-USDC per hour) earns it. An offer without it earns
  nothing, whatever you name.
- **When it is paid.** The door adds up what each address earned and, once a day, sends the address one USDC
  transfer on Base when it is owed at least 0.10 USDC (100000 micro-USDC). Below that it waits. The door pays
  at most 5 USDC a day in all by default; an address that does not fit gets part, and the rest the next day,
  if that part is at least 0.10 USDC; otherwise the address waits whole for the next day.
  You do nothing to claim.
- **How to check.** `GET /v1/referrals/<address>` is free and public. It answers `bps`, `hours`, `earned`,
  `paid`, `owed` (micro-USDC strings), `held`, and `payouts` (`amount`, `tx`, `at`, newest first, at most 50).
  An address the door has never seen answers zeros. It never shows who the renters were. `held: true` means
  payouts to that address are paused until the operator clears it.
- **Your own address.** A renter may name its own address. That is the discount: it earns back its share.
- **Homes.** A home's referrer is set at the home's first paid hour, from the lease that opened it, and no
  later request can change it. Every later lease of that home earns for that address, named or not. A home
  that already has a paid hour and no referrer cannot gain one: open a new home, or rent a job.
- **The answer.** The rent answer's `referral` is the address expected to earn, as known when the lease
  opened. For a home it can differ from the address you named, or be absent. If two leases of one new home
  open at once naming different addresses, the first one paid is bound.
- **What earns nothing.** Hours paid by the grant fund. A referral that is not a valid address (a mixed-case
  one must match its checksum), the zero address, the door's own address or the fund's is refused with
  `400 bad_referral` before any payment.
- **Who pays.** The door, from its own wallet. A bad or missing referral never changes whether a rent works.

### Receipts

After a lease, the door will sign a short statement you can keep or publish. It is free, and Charter stores
none of your files to make one: it signs a SHA-256.

- **A finished job.** `GET /v1/leases/<leaseId>/receipt` answers a receipt of `kind: "job"`: the `sha256` and
  `bytes` of the whole output, the `hostId`, the `image`, and `ticksPaid` at `intervalSeconds` each. It means
  the host returned those bytes for a lease that was paid. Hosts are not vetted, so it does not mean the
  result is correct. A lease that never read its own output spends its free reads on this, one per part
  (429 `rate_limited` when none are left).
- **A running home.** A home has no output the door can see. `POST /v1/leases/<leaseId>/receipt` with
  `{ "sha256": "<64 lower hex>" }` (and optionally `"cid"`, `"bytes"`) answers a receipt of
  `kind: "declared"`: your own claim with the door's timestamp, not proof of where the file came from. In the
  home, `charter-x402 receipt <file>` does it. The body takes those three keys only, and a CID is signed as
  version 1 in base16 (`f`, then hex), so the door never signs free text.
- **Safe to publish.** A receipt names the lease by `leaseRef`, the SHA-256 of `charter-lease:<leaseId>`,
  never by the id that reads the lease.
- **Checking one.** The door signs `message` (the line `Charter receipt v1`, a newline, the receipt as JSON)
  as an EIP-191 personal message with the address `GET /v1/door` answers as `receiptSigner`:

```js
import { verifyMessage } from 'viem';
const { message, signer, signature } = signed;
const door = await (await fetch('https://charterhome.dev/v1/door')).json();
const ok = signer.toLowerCase() === door.receiptSigner.toLowerCase()
  && await verifyMessage({ address: signer, message, signature });
const receipt = JSON.parse(message.slice(message.indexOf('\n') + 1));
```

- **Making a file public.** Charter does not host renter files. In a home, `charter-x402 pin <file>` buys a
  pin from Pinata, a third party, over x402 from the home's own wallet (0.10 USDC per GiB for twelve months,
  floor 0.001; `CHARTER_X402_MAX_PIN` caps one pin, default 0.01 USDC), then gets a declared receipt with the
  CID in it. The file is then readable by anyone. Pinata holds it; Charter never sees it.

## Run a host

Anyone can run a host. In v1 a host needs a public HTTPS address (no hosts behind NAT yet), serves only
the door, and is paid only by the door. You set your own tick price; the door adds its fee (0 today) on
top for renters.

1. **Install.** On Ubuntu 24.04 (amd64), as root, from a checkout of this repo (the `charter` user makes
   its own in step 2):
   `HOST_NAME=<your DNS name> bash deploy/host/install-host.sh`. It installs docker, gVisor's `runsc`,
   Node 22 and Anyone's `anon` from their signed repositories, makes the `charter` user, runs Caddy
   (pinned image, host network) to terminate TLS for `https://<HOST_NAME>` in front of
   `127.0.0.1:7401`, and writes `~charter/.config/charter/env` from `deploy/host/env.example`. Ports 80
   and 443 must reach the machine for Caddy's certificate. A name such as `1-2-3-4.sslip.io` works for a
   bare IP.
2. **Build**, as the `charter` user, in a checkout of its own:

   ```sh
   sudo -iu charter git clone https://github.com/drew-dot-com/charter.git
   sudo -iu charter   # a shell as charter, then:
   cd charter
   npm ci && npm run build && npm install -g --prefix ~/.local .
   docker build -t charter-job-python jobs/python
   docker build -t charter-job-fetch jobs/fetch     # optional
   ```

   Homes are optional: `docker build -t charter-home jobs/home` (and `charter-hermes`, see `docs/ops.md`),
   then `sudo bash deploy/host/install-home.sh` once.
3. **Configure** `~/.config/charter/env` (every variable: `docs/env.md`):
   - `CHARTER_HOST_URL`: your public `https://` address. It is the host's identity at the door.
   - `CHARTER_HOST_PAY_TO`: the Base address your earnings go to.
   - `CHARTER_CLAIM_KEY_FILE`: make one with `node deploy/door/new-claim-key.mjs ~/.config/charter/claim-key`.
     It signs claims on the door's channel and holds no funds.
   - `CHARTER_DOOR_URL` (default `https://charterhome.dev`) and `CHARTER_HOST_PORT`
     (default 7401, what Caddy proxies to).
   - `CHARTER_ALLOW_IMAGES` must include `charter-job-python`: the probe is a python job.
   - `CHARTER_TICK_PRICE` and `CHARTER_INTERVAL_SECONDS` set your price. A probe pays at most 0.01 USDC a
     tick, so a host priced above that is never listed.
4. **Start**: copy `deploy/host/charter-host.service` to `~/.config/systemd/user/`, then
   `systemctl --user daemon-reload && systemctl --user enable --now charter-host`.
   The host registers itself with the door (`POST /v1/hosts`) at boot, again every minute until accepted,
   and whenever its free home slots change. `charter-host offer --print` shows what it serves.
5. **The probe.** The door opens a small paid python job on your host (it deposits 0.10 USDC into a channel
   to you first), pays one tick, and checks the output carries the hash it expects. Pass, and you are
   listed. The door probes at most once a day per host and re-probes daily while you are listed. Two failed
   leases in a row, or a failed probe, hide you until a probe passes; a hidden host is re-probed at its next
   daily probe. Three failed probes in a row drop you, and the host must register again. Check your state: `GET <door>/v1/hosts`.
6. **Earnings.** Every paid tick is a voucher on the door's channel to you, kept in
   `<CHARTER_DATA_DIR>/x402-channels/`. `charter-host` claims them through the facilitator
   (`X402_FACILITATOR_URL`, PayAI by default, no key) once the channel has been quiet for two of your
   intervals (10 minutes at least), or at once when the door starts withdrawing it, and settles what it
   claimed to `CHARTER_HOST_PAY_TO` every 10 minutes; it refunds the door's unspent deposit only after a
   quiet week. `charter-host x402 status` lists the channel, `charter-host x402 claim` claims and settles
   every voucher now. Until claimed, earnings exist only as those vouchers: back the directory up and never
   delete it.

A job container gets 1 CPU, 1 GiB, 256 pids, a read-only root, no capabilities and
`no-new-privileges`; set `CHARTER_RUNTIME=runsc` so renters' code runs under gVisor. With
`CHARTER_PROXY` set, job traffic leaves through the host's Anyone proxy. A home gets 512 pids and the
same limits otherwise. Operating a host: `docs/ops.md`, "Run a host" and "Homes".

## Develop

```sh
npm ci
npm test          # node --test
npm run typecheck
npm run dev:door  # the storefront with no payments and a fake host
```

## License

MIT
