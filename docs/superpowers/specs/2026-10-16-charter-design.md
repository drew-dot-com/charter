# Charter: design

Date: 2026-10-16 · Owner: Drew Pierson · Status: draft for review

## 1. Intent

Charter is a compute marketplace. Someone hosts a machine, including one at home with no domain and no open port, and an agent or a person rents it. There is no account, and the tenant pays for each time slice as it runs. The rails are TOON: ILP routes the payments and x402 channels settle them.

**Why now:** Drew and Jonathan are going out to raise, and Charter is the product the deck leads with (rev 6, `~/Desktop/TOON-deck-text-2026-10-16.md`). They tell investors up front that today's version is early and first-party; the raise is what turns it into a real marketplace. So Charter has to work for real on mainnet, end to end, even when the first tenant and the first host are both Drew.

**Whose it is:** Charter is Drew's project. It lives in his repo, under his license, and runs on TOON the way LADING, hermes-toon and the l402-door do: as an app behind a node that pays and gets paid through the network.

## 2. Goals

1. **One real paid lease on mainnet.** A tenant rents a machine, the machine runs a job, every interval is paid over TOON in real USDC, and the vouchers land on chain. This is the fact slides 1, 8 and 12 of the deck depend on.
2. **A storefront people can look at** (Drew picked mockup B). It lists the machines for rent, each with its size, its price per interval, a "hidden host" badge and a Rent button. Rent opens a lease page that shows the lease's state, the intervals paid, the amount spent, and a link to the on-chain landing once there is one.
3. **Two doors into one marketplace.** A person rents from the storefront, and an agent (Edison first) rents through a programmatic interface. Both see the same offers and use the same lease lifecycle.
4. **A host program** that a host runs next to their TOON node. It publishes the machine's offers, takes lease requests, starts and stops the workload, and gets paid per interval.
5. **A demo you can repeat**: one script or runbook that runs a lease from start to finish in front of an investor.

## 3. Non-goals for v1

- Outside tenants or hosts. First-party is fine and gets said out loud.
- Interactive access to the rented machine (SSH, an open port, a long-running service). v1 runs jobs to completion and returns their output.
- GPUs, more than one region, reputation, disputes, refunds beyond "nothing owed if it never boots".
- More than one rail per lease. v1 pays USDC on whichever chain the nodes' channels already use (Base or Solana); sats come later. *(My call: don't open new channels just to be on Base.)*
- A Charter marketplace fee. The rate is a deck bracket and stays configurable at 0 for v1.
- Changes to the connector or toon_cli. If Charter is blocked on one, file an issue for Jonathan and work around it at the app layer.

## 4. Anti-goals (a failure even if it technically works)

- **Copying Jonathan's work.** No code, spec text or design taken from `toon-protocol/provider`, `toon-protocol/console` or the `toon-protocol/TOON_Network` spec. That includes its event kinds 10432/30432/10433. The deck says Charter is built new; keep that true. Using TOON's public interfaces (connector HTTP/ILP, `toon` CLI, `@toon-protocol/client`, the relay) is fine.
- **Overclaiming.** Nothing in the UI, README or demo says it is live with outside users, says "anonymous payments", or says "any token". Allowed: "accountless", "hidden host", "three rails by design, one in v1".
- **Charter sitting on tenants' money.** A browser renter pays Charter and Charter pays the host (Drew, Q1), so Charter is a paying hop, not a bystander. It must never hold more than the interval in flight: no deposits it can spend at will, no balances, no refunds owed. ⚠️ This changes the deck's line "Tenant and host settle directly over x402 channels"; it becomes "Charter is a paying hop that never holds more than one interval." Counsel review stays on the deck's list.
- **Spending Jonathan's time.** Charter needs nothing from him to work.
- **Em dashes** in anything that ships.

## 5. Constraints

- **Repo:** `drew-dot-com/charter`, MIT, created locally at `~/src/TOON/charter`.
- **Stack:** TypeScript on Node 22 or later, ESM, `node --test` with tsx, Docker for deployment. This matches LADING and the l402-door, which keeps all of Drew's apps one stack. *(My call.)*
- **Mainnet only.** No devnet or testnet infra for Drew's node or agents (standing rule).
- **Secrets:** never printed or committed. Node passphrases and mnemonics stay in the VM's `~/secrets/` with mode 600. Every spend runs behind a cap.
- **Network facts that hold today:**
  - Drew's edge is the only mainnet connector (`connector.mainnet.toonprotocol.dev`) and runs the x402-only release; his relay is at `relay.mainnet.toonprotocol.dev`.
  - The `toon` CLI (0.1.1, Linux only) runs an agent node: wallet, embedded connector, relay, peering and an Anyone hidden-service address. Two such nodes run in Lima VMs on Drew's MacBook Air: `toon` (Edison's, channel open to the edge) and `toon2` (run-2 wallet, funded once).
  - Routes advertise ADR 0067 request tables, and a skill-faithful agent pays a route from its table alone.
  - Inbound packets to an onion-addressed node have **not** been tested.
  - `toon` 0.3.0 shipped 2026-10-16 (Edison's node is on 0.1.1). A node puts a plain HTTP service behind its connector with `toon add <name> --url http://127.0.0.1:<port>/ --price <n>`; each app gets its own route `g.toon.<segment>.<name>` and a flat price per packet.
  - **An app cannot reject a packet.** In the CLI docs, any answer is a paid answer, and a 4xx is still fulfilled. So "nothing owed if it never boots" cannot come from refusing a packet; it has to come from the shape of the lease (6.2).
  - Apps that `toon add --image` runs are confined, with no network out. A job that needs to reach the web has to be started by charter-host itself, not as a `toon` app.

## 6. The shape (the parts decided)

### 6.1 Pieces

| piece | what it is | runs where (v1) |
| --- | --- | --- |
| **charter-host** | The host program. It publishes offers, takes paid lease packets on its own ILP route, runs one job per lease in a locked-down container, stops it when payment stops, and answers status requests for free. | Next to a `toon` node on the host machine |
| **charter (tenant)** | The library and CLI that find offers, open a lease, pay each interval, and fetch status and output, paying through the tenant's own TOON node. This is the door for agents that already run one (Edison). | On the tenant's machine; also wrapped as an agent tool for Edison |
| **storefront + door** | The web UI (offers, the Rent button, the lease page) plus Charter's own server behind Drew's node. A renter with **only a browser wallet holding USDC on Base** pays the door per interval over x402. The door pays the host the same interval over TOON from Charter's own channel, and runs the lease for the renter. Same pattern as the LADING gate and the l402-door. | Hosted publicly on Drew's node behind Caddy |
| **offer feed** | Where hosts publish what they sell. Signed events of a **Charter-owned kind**, written to Drew's mainnet relay as paid writes, with a heartbeat so a dead host drops off. | Drew's relay |

### 6.2 A lease, step by step

1. The host publishes an offer: machine size, price per interval in USDC, interval length, its ILP address and how to reach it, and the hidden-host flag. Publishing is a paid write to the relay.
2. The tenant (the door on a renter's behalf, or Edison through its tool) picks an offer and sends an **open packet** to the host's `charter-open` app. That app is priced at the network minimum, so a failed open costs almost nothing. The packet carries the job (an image from an allow-list plus its arguments). The host starts the container and answers with the lease id once it has booted, or with the boot error.
3. Only after a confirmed boot does the tenant pay the **first interval**, as a packet to the host's `charter-tick` app, which is priced at one interval. That is how "nothing owed if it never boots" holds, given that an app cannot refuse a packet. *(My call: two apps with two prices on one node.)*
4. Each later interval is one more tick packet. If a tick misses its window, the host stops the job and closes the lease. No refunds for intervals already used.
5. Status and output fetches are free. When the job finishes, the lease closes and its output stays fetchable for a set time.
6. The host's connector lands its vouchers on Base in batches. The lease page links the landing transaction once it exists. Value stays off-chain until then, which is normal.

### 6.3 The first lease (the demo)

- **Host:** the Air at home, through the `toon2` VM's node with its hidden-service address, running charter-host with Docker. One small offer that fits the VM. *(My call: `toon2`, so Edison's node stays a pure tenant and the route really crosses the network.)*
- **Tenant:** Edison, through its node in the `toon` VM, by way of a narrow Charter tool. Never a terminal, since Edison is a public bot. A second run is Drew clicking Rent on the storefront.
- **Path:** the tenant node goes to Drew's edge, which goes to the host node. It's a real multi-hop route on mainnet.
- **Job:** a headless-browser fetch that returns a screenshot and the page text, which is something Edison actually wants. charter-host runs it in its own locked-down container. The job's traffic out to the web goes through the node's Anyone proxy, so target sites never see Drew's home IP; if the proxy can't carry it, the badge reads "no open port" and the demo notes say why. *(My call.)*
- **Edison's access:** only Drew's Telegram and Discord ids can make Edison rent, under a daily spend cap, like the parked `toon_upload` tool. *(My call.)*
- **Node versions:** move both VMs to `toon` 0.3.0 before building on them. *(My call.)*
- **Done means:** a lease of at least 3 intervals paid in real USDC, the job's output returned, the lease page showing the whole story, and an on-chain landing transaction carrying the host's vouchers that you can verify. A "land now" by hand (connector ADR 0029) is fine for the demo, since a few cents may never reach a batch threshold. If other traffic shares the batch, the page says so. *(My call.)*

### 6.4 Storefront look

Mockup B. The machines-for-rent list has the size, the "hidden host" badge, the price per interval and a Rent button, with the line "No account. Pay from any funded channel." The lease page shows the lease's state, a counter of intervals paid, the amount spent, the job's output, and the on-chain landing link. Only the renter sees their lease (the page is keyed to the paying wallet), and the demo runs on Drew's screen. A public lease feed is out of v1, which also keeps Edison's activity private. *(My call.)*

## 7. Left to the builder

- The exact Charter event kind number, the offer and heartbeat schema, the heartbeat cadence.
- The packet formats for open, extend, status and output, and the ADR 0067 request table for the host's route.
- How the tenant client talks to its TOON node (shelling out to `toon send`, or `@toon-protocol/client`).
- How a browser renter pays per interval without a wallet pop-up every minute. Preferred: an x402 `batch-settlement` channel from the renter's wallet to the door, sized to the lease budget, with the page signing one voucher per interval. The money then sits in the x402 contract, not with Charter, and the door can only redeem what was signed. Fallback: x402 `exact` per interval with a longer interval. Either way the door pays the host only after the renter's interval is paid.
- Container sandboxing (resource limits, no network or egress-only, the image allow-list) and how long output is kept.
- Where the public storefront is hosted (Drew's node behind Caddy is the default).
- The interval length and the demo price (suggested: 60 s, a few cents per interval).
- Getting inbound packets to the onion node to work. If they don't, fall back to `--clearnet` for the host node and say so in the demo notes.
- What a 5xx or a timeout from an app does to the packet (the docs only cover 4xx). The lease design above does not depend on the answer.

## 8. Open questions

- **Q1, answered (Drew, 10-16):** no TOON node needed. Charter exists to kickstart traction, so a renter needs only a browser wallet. Charter runs the door and pays hosts on renters' behalf (see 4 and 6.1).
- **Timing (Drew, 10-16):** the first investor demo is at least a month out, so v1 includes the live Rent flow, not a read-only storefront.
