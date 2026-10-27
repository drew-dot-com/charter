import type { Lease } from '../src/types.js';
import { ago, clock, decodeOutput, duration, formatUsdc, landingLink, offerFreshness, parseOffer, pricePerHour, shortHex, sizeLabel, type JobOutput, type PublicOffer, type PythonOutput } from './format.js';
import { call, makePost, type Answer, type DoorInfo } from './pay.js';
import { nextTickAt } from './schedule.js';
import { applyStatus, clearHalt, newTickState, runTick, shouldTick, type TickState } from './ticker.js';
import { CHOOSE_WALLET, NO_WALLET, chooseWallet, discoverWallets, requestAccounts } from './providers.js';
import { BASE_CHAIN_ID_HEX, type Eip1193 } from './wallet.js';
import { channelSummary, readChannels, type ChannelSummary } from './channel.js';
import { newTimeline, noteOutput, observe, type Timeline } from './timeline.js';

// ---------------------------------------------------------------------------
// Constants

const POLL_MS = 5_000;
const POLL_FINAL_MS = 15_000;
const STEP_MS = 1_000;
const MAX_URLS = 5;
const MAX_SCRIPT_BYTES = 8 * 1024;
const FETCH_IMAGE = 'charter-job-fetch';
const PYTHON_IMAGE = 'charter-job-python';
/** An empty machine list is read again this often. */
const EMPTY_RETRY_MS = 30_000;

/** What the script box starts with: real numeric work that finishes inside one interval. */
const EXAMPLE_SCRIPT = `import time
import numpy as np

t = time.time()
rng = np.random.default_rng()
n = 5_000_000
x, y = rng.random(n), rng.random(n)
print("pi is about", 4 * np.count_nonzero(x * x + y * y <= 1) / n)

a = rng.random((1500, 1500))
print("largest eigenvalue", round(float(np.max(np.abs(np.linalg.eigvals(a)))), 3))
print(f"took {time.time() - t:.1f} s on this machine")
`;
const MAX_OUTPUT_PARTS = 100;

const STATE_LABEL: Record<Lease['state'], string> = {
  booting: 'Starting',
  awaiting_first_tick: 'Waiting for payment',
  running: 'Running',
  done: 'Done',
  closed: 'Closed',
};

const CLOSE_REASON: Record<string, string> = {
  boot_failed: 'The machine did not start. Nothing is owed.',
  missed_tick: 'A payment was missed, so the lease closed.',
  max_intervals: 'The lease reached its maximum length.',
  host_restart: 'The host restarted, so the lease closed.',
  busy: 'The machine is busy with another lease. Nothing is owed. Try again later.',
};

// ---------------------------------------------------------------------------
// DOM helpers. Text always goes in as text, never as HTML.

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c) e.append(c);
  return e;
}

function button(label: string, onClick: () => void, alt = false): HTMLButtonElement {
  const b = el('button', alt ? 'alt' : undefined, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function link(text: string, href: string, external = true): HTMLAnchorElement {
  const a = el('a', undefined, text);
  a.href = href;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  return a;
}

function chip(text: string, cls = ''): HTMLElement {
  return el('span', `chip ${cls}`.trim(), text);
}

function skeleton(...widths: Array<1 | 2 | 3>): HTMLElement[] {
  return widths.map((w) => el('span', `skeleton w${w}`));
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 140 ? `${m.slice(0, 140)}...` : m;
}

// ---------------------------------------------------------------------------
// The door's API

const errorCode = (a: Answer): string => ((a.body as { error?: unknown } | undefined)?.error as string | undefined) ?? 'unknown';

function parseOffers(body: unknown): PublicOffer[] {
  if (!Array.isArray(body)) throw new Error('bad offers answer');
  return body.map(parseOffer).filter((o): o is PublicOffer => o !== undefined);
}

interface RecentLease {
  id: string;
  createdAt: number;
  ticks: number;
  payer?: string;
  state?: Lease['state'];
  landing?: { chain: string; tx: string; shared: boolean };
}

function parseRecent(body: unknown): RecentLease[] {
  if (!Array.isArray(body)) return [];
  const out: RecentLease[] = [];
  for (const r of body as Array<Partial<RecentLease>>) {
    if (!r || typeof r.id !== 'string' || typeof r.createdAt !== 'number' || typeof r.ticks !== 'number') continue;
    const row: RecentLease = { id: r.id, createdAt: r.createdAt, ticks: r.ticks };
    if (typeof r.payer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.payer)) row.payer = r.payer;
    if (typeof r.state === 'string' && r.state in STATE_LABEL) row.state = r.state as Lease['state'];
    if (r.landing && typeof r.landing.chain === 'string' && typeof r.landing.tx === 'string') row.landing = { chain: r.landing.chain, tx: r.landing.tx, shared: r.landing.shared === true };
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wallet: an EIP-1193 provider signs the x402 payments (USDC on Base, EIP-3009).

interface Wallet {
  address: `0x${string}`;
  eth: Eip1193;
}

let wallet: Wallet | undefined;
/** The door has no payment gate (local development): the page skips x402. */
let dev = false;
let doorInfo: DoorInfo | undefined;

/** The wallets that announced themselves (EIP-6963). Several installed wallets each get a line here. */
const wallets = discoverWallets(window);
const CHOICE_KEY = 'charter.wallet';
/** The rdns of the wallet the renter picked, remembered for the next visit. */
let chosen: string | undefined = (() => {
  try {
    return localStorage.getItem(CHOICE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
})();

function choose(rdns: string): void {
  chosen = rdns;
  try {
    localStorage.setItem(CHOICE_KEY, rdns);
  } catch {
    // Remembering the pick is a convenience only.
  }
}

const injected = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

const store = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** A wallet picker, shown only when more than one wallet announced itself. */
function walletPicker(): HTMLElement | null {
  if (wallets.length < 2) return null;
  const select = el('select');
  select.id = `wallet-${Math.random().toString(36).slice(2, 10)}`;
  const known = wallets.some((w) => w.info.rdns === chosen);
  const none = el('option', undefined, 'Choose a wallet');
  none.value = '';
  none.disabled = true;
  none.selected = !known;
  select.append(none);
  for (const w of wallets) {
    const o = el('option', undefined, w.info.name || w.info.rdns);
    o.value = w.info.rdns;
    o.selected = known && w.info.rdns === chosen;
    select.append(o);
  }
  select.addEventListener('change', () => {
    if (select.value) choose(select.value);
  });
  const label = el('label', undefined, 'Pay with');
  label.htmlFor = select.id;
  return el('div', 'wallet-pick', label, select);
}

/** `silent`: reuse an account the wallet already shared, never prompt. Returns undefined when there is none. */
async function connectWallet(silent = false): Promise<Wallet | undefined> {
  const choice = chooseWallet(wallets, chosen, injected());
  if (choice.kind !== 'provider') {
    if (silent) return undefined;
    throw new Error(choice.kind === 'pick' ? CHOOSE_WALLET : NO_WALLET);
  }
  const eth = choice.provider;
  if (wallet?.eth === eth) return wallet;
  wallet = undefined;
  let accounts: string[];
  if (silent) {
    try {
      accounts = (await eth.request({ method: 'eth_accounts' })) as string[];
    } catch {
      return undefined;
    }
  } else {
    accounts = await requestAccounts(eth);
  }
  const address = accounts[0];
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  if (!silent) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_ID_HEX }] });
    } catch {
      throw new Error('Switch your wallet to Base, then try again.');
    }
  }
  if ((await eth.request({ method: 'eth_chainId' })) !== BASE_CHAIN_ID_HEX) {
    if (silent) return undefined;
    throw new Error('Switch your wallet to Base, then try again.');
  }
  wallet = { address: address as `0x${string}`, eth };
  return wallet;
}

// ---------------------------------------------------------------------------
// Routing

const app = document.getElementById('app')!;
let route = 0;

function mount(...children: Child[]): void {
  app.replaceChildren(...(children.filter(Boolean) as Node[]));
}

function go(): void {
  route++;
  stopLeasePage();
  stopHome();
  const m = /^#\/lease\/([0-9a-f]{32})$/.exec(location.hash);
  if (m) void showLease(m[1]!, route);
  else void showHome(route);
}

// ---------------------------------------------------------------------------
// Machines for rent

let homeTimer: number | undefined;

function stopHome(): void {
  clearTimeout(homeTimer);
  homeTimer = undefined;
}

async function showHome(token: number): Promise<void> {
  const list = el('ul', 'rows');
  const recent = el('div');
  mount(
    el('h1', undefined, 'Machines for rent'),
    el('p', 'lede', 'A container on a machine somebody runs at home, paid in USDC on Base every 30 seconds while it runs. Run your own Python script on it, or have it fetch pages and send back a screenshot and the text of each.'),
    list,
    el('p', 'note', 'No account. Your wallet signs once to put a deposit of at least 0.10 USDC into an x402 channel on Base. Each interval after that is a voucher this page signs silently, and what you do not use comes back when the lease ends.'),
    dev ? el('p', 'note', 'Local test mode: payments are skipped.') : null,
    recent,
  );
  list.append(el('li', 'card', ...skeleton(1, 2, 3)));
  void showRecent(recent, token);
  await loadOffers(list, token);
}

async function loadOffers(list: HTMLUListElement, token: number): Promise<void> {
  let offers: PublicOffer[];
  try {
    const a = await call(fetch, '/v1/offers');
    if (a.status !== 200) throw new Error(String(a.status));
    offers = parseOffers(a.body);
  } catch {
    if (token !== route) return;
    const again = button('Try again', () => {
      list.replaceChildren(el('li', 'card', ...skeleton(1, 2, 3)));
      void loadOffers(list, token);
    }, true);
    list.replaceChildren(el('li', 'msg bad', 'Could not load the machines. ', el('div', 'actions', again)));
    return;
  }
  if (token !== route) return;
  if (offers.length === 0) {
    list.replaceChildren(
      el('li', 'empty', 'No machines are listed right now. A host republishes its offer every 10 minutes, and this page looks again every 30 seconds.'),
    );
    homeTimer = window.setTimeout(() => void loadOffers(list, token), EMPTY_RETRY_MS);
    return;
  }
  list.replaceChildren(...offers.map((o) => offerRow(o, Date.now())));
}

const JOB_NAME: Record<string, string> = { [PYTHON_IMAGE]: 'Python · NumPy', [FETCH_IMAGE]: 'Fetch pages' };

function offerRow(o: PublicOffer, now: number): HTMLElement {
  const row = el('li', 'card');
  const chips = el('div', 'chips');
  if (o.hiddenHost) chips.append(chip('hidden host'));
  if (o.hiddenEgress) chips.append(chip('hidden egress'));
  for (const i of o.images) if (JOB_NAME[i]) chips.append(chip(JOB_NAME[i]!));
  if (o.images.length === 0) chips.append(chip(JOB_NAME[FETCH_IMAGE]!));

  const head = el('div', 'card-head', el('span', 'size', sizeLabel(o.cpu, o.memoryMiB)), chips);
  const rent = button('Rent', () => {
    rent.disabled = true;
    row.append(rentForm(o, () => {
      rent.disabled = false;
    }));
  });
  rent.setAttribute('aria-label', `Rent ${sizeLabel(o.cpu, o.memoryMiB)}`);
  const price = el('span', 'price', `${formatUsdc(BigInt(o.tickPrice))} per ${duration(o.intervalSeconds)}`, el('span', 'per', `${formatUsdc(pricePerHour(o.tickPrice, o.intervalSeconds))} an hour`));
  head.append(el('span', 'buy', price, rent));

  const meta = el('div', 'card-meta');
  const [hostKey] = o.offerId.split(':');
  if (hostKey) meta.append(el('span', undefined, 'Host ', el('span', 'mono', shortHex(hostKey, 8, 4))));
  if (o.leases !== undefined) {
    meta.append(el('span', undefined, o.leases === 0 ? 'No leases served through this door yet' : `${o.leases} ${o.leases === 1 ? 'lease' : 'leases'} served${o.lastLeaseAt ? `, last ${ago(o.lastLeaseAt, now)}` : ''}`));
  }
  if (o.expiresAt !== undefined) {
    const f = offerFreshness(o.expiresAt, now);
    meta.append(el('span', undefined, `Offer published ${ago(now - f.publishedMs, now)}, good for ${duration(f.expiresInMs / 1000)}`));
  }
  row.append(head, meta);
  return row;
}

async function showRecent(host: HTMLElement, token: number): Promise<void> {
  let rows: RecentLease[];
  try {
    const a = await call(fetch, '/v1/recent');
    if (a.status !== 200) return;
    rows = parseRecent(a.body);
  } catch {
    return;
  }
  if (token !== route || rows.length === 0) return;
  const now = Date.now();
  const table = el('table', 'recent');
  const head = el('tr');
  for (const h of ['When', 'Lease', 'Intervals', 'Renter', 'On chain']) head.append(el('th', undefined, h));
  table.append(el('thead', undefined, head));
  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', 'num', ago(r.createdAt, now)));
    tr.append(el('td', 'mono', `${r.id}…`, r.state ? ` ` : '', r.state ? chip(STATE_LABEL[r.state], r.state === 'done' ? 'gold' : '') : ''));
    tr.append(el('td', 'num', String(r.ticks)));
    tr.append(el('td', 'mono', r.payer ? link(shortHex(r.payer, 6, 4), `https://basescan.org/address/${r.payer}`) : ''));
    const l = landingLink(r.landing);
    tr.append(el('td', 'mono', l?.href ? link(shortHex(l.tx, 6, 4), l.href) : l ? shortHex(l.tx, 6, 4) : ''));
    body.append(tr);
  }
  table.append(body);
  host.replaceChildren(
    el('h2', undefined, 'Recent leases'),
    el('p', 'muted', 'From this door\'s own ledger: every lease a renter paid at least one interval for. The renter is a wallet on Base; the on-chain link is where the host\'s vouchers landed, when this door has seen it.'),
    table,
  );
}

/** One address per line: 1 to 5 http(s) URLs, none with a comma (the job joins them with commas). */
function parseUrls(text: string): string[] | string {
  const urls = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (urls.length < 1) return 'Enter at least one web address.';
  if (urls.length > MAX_URLS) return `Enter at most ${MAX_URLS} web addresses.`;
  for (const u of urls) {
    let ok = !u.includes(',') && u.length <= 2000;
    try {
      const p = new URL(u);
      ok = ok && (p.protocol === 'http:' || p.protocol === 'https:');
    } catch {
      ok = false;
    }
    if (!ok) return `"${u.length > 60 ? `${u.slice(0, 60)}...` : u}" is not a web address starting with http:// or https:// (no commas).`;
  }
  return urls;
}

const OPEN_FAILURES: Record<number, string> = {
  400: 'The door refused that job.',
  404: 'That machine is no longer offered. Reload the list.',
  429: 'Too many leases were started from this network. Try again later.',
  503: 'The door has reached its limit for now. Try again later.',
};

type JobMode = 'python' | 'fetch';

/** A script the python job will take: non-blank, at most 8 KiB of UTF-8. */
function checkScript(text: string): string | undefined {
  if (text.trim() === '') return 'Write a script to run.';
  const n = new TextEncoder().encode(text).length;
  if (n > MAX_SCRIPT_BYTES) return `The script is ${n} bytes; the most is ${MAX_SCRIPT_BYTES}.`;
  return undefined;
}

function rentForm(o: PublicOffer, close: () => void): HTMLElement {
  // An offer that does not say which images it runs is a v1 host: fetch only.
  const modes: JobMode[] = [];
  if (o.images.includes(PYTHON_IMAGE)) modes.push('python');
  if (o.images.includes(FETCH_IMAGE) || o.images.length === 0) modes.push('fetch');
  let mode: JobMode = modes[0] ?? 'fetch';
  const drafts: Record<JobMode, string> = { python: EXAMPLE_SCRIPT, fetch: '' };

  const key = o.offerId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  const area = el('textarea');
  area.id = `job-${key}`;
  area.spellcheck = false;
  const label = el('label');
  label.htmlFor = area.id;
  const show = (m: JobMode) => {
    drafts[mode] = area.value;
    mode = m;
    area.value = drafts[m];
    if (m === 'python') {
      label.textContent = 'Python script to run. Up to 8 KiB, NumPy included, no network. Its output comes back when it finishes.';
      area.placeholder = 'print("hello")';
      area.rows = 14;
    } else {
      label.textContent = `Pages to fetch, up to ${MAX_URLS}, one address per line.`;
      area.placeholder = 'https://example.com';
      area.rows = 5;
    }
  };
  area.value = drafts[mode];
  show(mode);

  let choose: HTMLElement | null = null;
  if (modes.length > 1) {
    choose = el('div', 'job-pick');
    choose.setAttribute('role', 'radiogroup');
    choose.setAttribute('aria-label', 'Job');
    for (const m of modes) {
      const r = el('input');
      r.type = 'radio';
      r.name = `mode-${key}`;
      r.value = m;
      r.checked = m === mode;
      r.addEventListener('change', () => r.checked && show(m));
      choose.append(el('label', undefined, r, m === 'python' ? 'Run Python' : 'Fetch pages'));
    }
  }

  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  const form = el('form', 'rent-form');
  const start = el('button', undefined, 'Start lease');
  start.type = 'submit';
  const cancel = button('Cancel', () => {
    form.remove();
    close();
  }, true);
  let picker = dev ? null : walletPicker();
  form.append(...(choose ? [choose] : []), label, area, ...(picker ? [picker] : []), status, el('div', 'actions', start, cancel));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void (async () => {
      let job: { urls: string[] } | { python: { script: string } };
      if (mode === 'python') {
        const bad = checkScript(area.value);
        if (bad) {
          status.textContent = bad;
          return;
        }
        job = { python: { script: area.value } };
      } else {
        const urls = parseUrls(area.value);
        if (typeof urls === 'string') {
          status.textContent = urls;
          return;
        }
        job = { urls };
      }
      start.disabled = true;
      try {
        if (!dev) {
          if (!picker && wallets.length > 1) {
            // A wallet announced itself after the form opened.
            picker = walletPicker();
            form.insertBefore(picker!, status);
          }
          status.textContent = 'Connecting your wallet';
          await connectWallet();
        }
        status.textContent = 'Opening the lease. The host is a hidden service, so this can take up to 30 seconds.';
        const a = await call(fetch, '/v1/leases', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offerId: o.offerId, ...job }),
        });
        const id = (a.body as { leaseId?: unknown } | undefined)?.leaseId;
        if (a.status === 200 && typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)) {
          location.hash = `#/lease/${id}`;
          return;
        }
        status.textContent = OPEN_FAILURES[a.status] ?? `The host could not start the lease (${errorCode(a)}).`;
      } catch (e) {
        status.textContent = short(e);
      }
      start.disabled = false;
    })();
  });
  queueMicrotask(() => area.focus());
  return form;
}

// ---------------------------------------------------------------------------
// The lease page

interface LeasePage {
  id: string;
  alive: boolean;
  timer: number | undefined;
  /** What the lease page knows of the lease and its ticks (see ticker.ts). */
  t: TickState;
  /** The lease's offer as its status carries it (the door's record from open time). */
  offer: PublicOffer | undefined;
  lastPoll: number;
  /** The status read in flight, if any. */
  polling: Promise<void> | undefined;
  notice: string | undefined;
  output: { state: 'idle' | 'loading' | 'done' | 'error'; value?: JobOutput; error?: string };
  story: Timeline;
  ui: {
    state: HTMLElement;
    stateChip: HTMLElement;
    paid: HTMLElement;
    spent: HTMLElement;
    through: HTMLElement;
    throughSub: HTMLElement;
    interval: HTMLElement;
    fill: HTMLElement;
    legendLeft: HTMLElement;
    legendRight: HTMLElement;
    msg: HTMLElement;
    timeline: HTMLElement;
    channel: HTMLElement;
    out: HTMLElement;
  };
}

let current: LeasePage | undefined;

function stopLeasePage(): void {
  if (!current) return;
  current.alive = false;
  clearTimeout(current.timer);
  current = undefined;
}

const isFinal = (l: Lease | undefined): boolean => l?.state === 'done' || l?.state === 'closed';

function fact(label: string, value: HTMLElement, sub?: HTMLElement): HTMLElement {
  return el('div', 'fact', el('div', 'label', label), value, sub);
}

async function showLease(id: string, token: number): Promise<void> {
  const fill = el('div', 'fill');
  const legendLeft = el('span');
  const legendRight = el('span');
  const ui: LeasePage['ui'] = {
    state: el('div', 'value', 'Loading'),
    stateChip: chip('', 'live'),
    paid: el('div', 'value num', '0'),
    spent: el('div', 'value num gold', '$0.00'),
    through: el('div', 'value num', ''),
    throughSub: el('div', 'sub'),
    interval: el('div', 'interval'),
    fill,
    legendLeft,
    legendRight,
    msg: el('div'),
    timeline: el('ol', 'timeline'),
    channel: el('div'),
    out: el('div'),
  };
  ui.interval.append(el('div', 'bar', fill), el('div', 'legend', legendLeft, legendRight));
  ui.interval.hidden = true;
  ui.stateChip.hidden = true;
  const page: LeasePage = {
    id, alive: true, timer: undefined, t: newTickState(), offer: undefined, lastPoll: 0, polling: undefined,
    notice: undefined, output: { state: 'idle' }, story: newTimeline(), ui,
  };
  current = page;
  const back = el('a', undefined, 'Machines for rent');
  back.href = '#/';
  mount(
    el('p', 'muted', back),
    el('div', 'lease-head', el('h1', undefined, 'Lease ', el('span', 'mono', shortHex(id, 8, 0))), ui.stateChip),
    el('div', 'facts', fact('State', ui.state), fact('Intervals paid', ui.paid), fact('Spent', ui.spent), fact('Paid through', ui.through, ui.throughSub)),
    ui.interval,
    ui.msg,
    el('div', 'two-col', el('section', undefined, el('h2', undefined, 'What happened'), ui.timeline), el('section', undefined, ui.channel)),
    ui.out,
  );
  if (!dev) {
    try {
      await connectWallet(true);
    } catch {
      // The connect button below handles it.
    }
    if (token !== route) return;
  }
  step(page);
}

async function loadDoor(): Promise<void> {
  try {
    const a = await call(fetch, '/v1/door');
    const b = a.body as Partial<DoorInfo> | undefined;
    if (a.status === 200 && typeof b?.payTo === 'string' && typeof b.network === 'string') doorInfo = { payTo: b.payTo, network: b.network };
  } catch {
    // The payment is refused below.
  }
}

function poll(p: LeasePage): Promise<void> {
  p.lastPoll = Date.now();
  const run = readStatus(p).finally(() => {
    p.polling = undefined;
    if (p.alive) render(p);
  });
  p.polling = run;
  return run;
}

async function readStatus(p: LeasePage): Promise<void> {
  try {
    const a = await call(fetch, `/v1/leases/${p.id}`);
    if (!p.alive) return;
    const lease = (a.body as { lease?: Lease } | undefined)?.lease;
    if (a.status === 200 && lease) {
      applyStatus(p.t, lease);
      p.notice = undefined;
      const offer = parseOffer((a.body as { offer?: unknown }).offer);
      if (offer) {
        p.offer = offer;
        p.t.intervalSeconds = offer.intervalSeconds;
      }
      observe(p.story, p.t.lease!, Date.now(), p.offer?.tickPrice);
      if (lease.state === 'done' && p.output.state === 'idle') void loadOutput(p);
    } else if (a.status === 404) {
      p.t.halt = { message: 'The door does not know this lease.', retry: false };
    } else if (a.status === 429) {
      p.notice = 'The door asked this page to slow down. Waiting a little.';
      p.lastPoll = Date.now() + 30_000;
    } else {
      p.notice = 'Could not reach the host. Trying again.';
    }
  } catch {
    if (p.alive) p.notice = 'Could not reach the door. Trying again.';
  }
}

function step(p: LeasePage): void {
  if (!p.alive) return;
  const now = Date.now();
  const final = isFinal(p.t.lease);
  const settled = final && !!p.t.lease?.landing && p.output.state !== 'loading' && p.output.state !== 'idle';
  if (!p.polling && !settled && now - p.lastPoll >= (final ? POLL_FINAL_MS : POLL_MS)) void poll(p);
  if ((dev || wallet) && shouldTick(p.t, now)) void payTick(p);
  render(p);
  p.timer = window.setTimeout(() => step(p), STEP_MS);
}

/** The effects of one tick: the status refresh, the send (with the wallet when the door is gated), the sleep. */
function payTick(p: LeasePage): Promise<void> {
  return runTick(p.t, {
    post: makePost({
      leaseId: p.id,
      origin: location.origin,
      dev,
      wallet,
      fetch: window.fetch.bind(window),
      door: async () => {
        if (!doorInfo) await loadDoor();
        return doorInfo;
      },
      offer: () => p.offer,
      store: store(),
    }),
    // A tick sent to a lease that finished since the last look is paid by the door for nothing:
    // look again first, unless the last look was within the poll interval.
    refresh: async () => {
      if (p.polling) await p.polling;
      else if (Date.now() - p.lastPoll >= POLL_MS) await poll(p);
    },
    requestPoll: () => void (p.lastPoll = 0),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    alive: () => p.alive,
  }).finally(() => {
    // A paid tick moves the page's own view of the lease ahead of the next status read.
    if (p.alive && p.t.lease) observe(p.story, p.t.lease, Date.now(), p.offer?.tickPrice);
    if (p.alive) render(p);
  });
}

async function loadOutput(p: LeasePage): Promise<void> {
  const parts = p.t.lease?.outputParts;
  if (typeof parts !== 'number' || parts < 1) {
    p.output = { state: 'error', error: 'The job finished without output.' };
    return;
  }
  if (parts > MAX_OUTPUT_PARTS) {
    p.output = { state: 'error', error: 'The output is too large to show here.' };
    return;
  }
  p.output = { state: 'loading' };
  render(p);
  try {
    const data: string[] = [];
    for (let n = 0; n < parts; n++) {
      const a = await call(fetch, `/v1/leases/${p.id}/output/${n}`);
      const d = (a.body as { data?: unknown } | undefined)?.data;
      if (a.status !== 200 || typeof d !== 'string') throw new Error(`output part ${n} (${a.status} ${errorCode(a)})`);
      data.push(d);
      if (!p.alive) return;
    }
    p.output = { state: 'done', value: decodeOutput(data) };
    noteOutput(p.story, Date.now(), data.reduce((n, s) => n + Math.floor((s.length * 3) / 4), 0));
  } catch (e) {
    p.output = { state: 'error', error: `Could not load the output: ${short(e)}` };
  }
  if (p.alive) render(p);
}

// Rendering of the lease page. Each region is only rebuilt when what it shows has changed.

const shown = new WeakMap<HTMLElement, string>();

function setRegion(host: HTMLElement, key: string, build: () => Child[]): void {
  if (shown.get(host) === key) return;
  shown.set(host, key);
  host.replaceChildren(...(build().filter(Boolean) as Node[]));
}

function render(p: LeasePage): void {
  if (!p.alive) return;
  const { ui } = p;
  const lease = p.t.lease;
  const now = Date.now();
  if (lease) {
    ui.state.textContent = STATE_LABEL[lease.state];
    ui.state.className = lease.state === 'done' ? 'value ok' : 'value';
    ui.stateChip.hidden = false;
    ui.stateChip.textContent = lease.state === 'running' ? 'live' : lease.state === 'done' ? 'paid · done' : lease.state === 'closed' ? 'closed' : 'opening';
    ui.stateChip.className = `chip ${lease.state === 'running' ? 'live' : lease.state === 'done' ? 'gold' : lease.state === 'closed' ? 'bad' : ''}`.trim();
    ui.paid.textContent = String(lease.paidIntervals);
    ui.spent.textContent = p.offer ? formatUsdc(BigInt(p.offer.tickPrice) * BigInt(lease.paidIntervals)) : 'n/a';
    if (lease.state === 'running' && lease.paidThrough !== undefined) {
      ui.through.textContent = clock(lease.paidThrough);
      const left = Math.max(0, lease.paidThrough - now);
      ui.throughSub.textContent = left > 0 ? `${duration(left / 1000)} of paid time left` : 'The paid time is up.';
    } else if (isFinal(lease)) {
      ui.through.textContent = lease.state === 'done' ? 'Finished' : 'Closed';
      ui.throughSub.textContent = lease.state === 'done' ? 'No more intervals are paid.' : '';
    } else {
      ui.through.textContent = '';
      ui.throughSub.textContent = lease.state === 'booting' ? 'The host is creating the machine.' : 'The first interval starts the job.';
    }
  }

  // The current interval: the paid window as a bar, the next payment on the legend.
  const interval = p.offer?.intervalSeconds;
  if (lease && lease.state === 'running' && lease.paidThrough !== undefined && interval) {
    ui.interval.hidden = false;
    const end = lease.paidThrough;
    const start = end - interval * 1000;
    const part = Math.min(1, Math.max(0, (now - start) / (end - start)));
    ui.fill.style.width = `${(part * 100).toFixed(1)}%`;
    ui.legendLeft.textContent = `Interval ${lease.paidIntervals} of ${duration(interval)}, paid through ${clock(end)}`;
  } else {
    ui.interval.hidden = true;
  }
  let next = '';
  if (lease && !isFinal(lease)) {
    const due = nextTickAt(lease, now, interval);
    if (p.t.ticking) next = 'Paying the next interval now';
    else if (p.t.halt) next = 'Payments are paused';
    else if (!dev && !wallet) next = 'Waiting for your wallet';
    else if (due !== null) next = due <= now ? 'Next payment is due' : `Next payment in ${Math.ceil((due - now) / 1000)} s`;
  }
  ui.legendRight.textContent = next;
  ui.throughSub.textContent = lease && lease.state === 'awaiting_first_tick' && next ? next : ui.throughSub.textContent;

  const closed = lease?.state === 'closed' ? (lease.closedReason ? CLOSE_REASON[lease.closedReason] : undefined) ?? 'The lease closed.' : '';
  const needsWallet = !dev && !wallet && !!lease && !isFinal(lease);
  setRegion(ui.msg, `${p.t.halt?.message}|${p.t.halt?.retry}|${p.notice}|${closed}|${needsWallet}|${lease?.state}`, () => {
    const out: Child[] = [];
    if (lease?.state === 'booting') out.push(el('p', 'muted', 'Starting the machine. The host is a hidden service, so the first answer can take 15 to 30 seconds.'));
    if (closed) out.push(el('div', 'msg warn', closed));
    if (p.t.halt) {
      const box = el('div', 'msg bad', p.t.halt.message);
      if (p.t.halt.retry) {
        box.append(el('div', 'actions', button('Try again', () => {
          clearHalt(p.t);
          p.lastPoll = 0;
          render(p);
          step0(p);
        })));
      }
      out.push(box);
    }
    if (needsWallet) {
      const box = el('div', 'msg warn', 'Connect your wallet to keep paying for this lease. Without a payment in time, it closes.');
      const note = el('p', 'muted');
      const pick = walletPicker();
      if (pick) box.append(pick);
      box.append(el('div', 'actions', button('Connect wallet', () => {
        connectWallet().then(() => render(p), (e) => {
          note.textContent = short(e);
        });
      })), note);
      out.push(box);
    }
    if (p.notice) out.push(el('p', 'muted', p.notice));
    return out;
  });

  // The story so far. Rebuilt when an event is added or the live marker moves.
  const events = p.story.events;
  const live = lease?.state === 'running' && !isFinal(lease);
  setRegion(ui.timeline, `${events.length}|${live}|${events[events.length - 1]?.href}`, () => {
    if (events.length === 0) return [el('li', undefined, el('time', undefined, clock(now)), 'Reading the lease from the host')];
    return events.map((e, i) => {
      const li = el('li', e.href ? 'gold' : live && i === events.length - 1 ? 'now' : undefined, el('time', undefined, clock(e.at)));
      if (e.href) li.append(link(e.text, e.href));
      else li.append(e.text);
      return li;
    });
  });

  // The renter's channel, as this page keeps it.
  const summary: ChannelSummary | undefined = !dev && wallet ? channelSummary(readChannels(wallet.address, store() ?? ({ length: 0, key: () => null, getItem: () => null } as unknown as Storage))) : undefined;
  setRegion(ui.channel, summary ? `${summary.balance}|${summary.owed}|${summary.back}|${summary.channels}` : dev ? 'dev' : wallet ? 'none' : 'nowallet', () => {
    const h = el('h2', undefined, 'Your channel');
    if (dev) return [h, el('div', 'channel', 'Local test mode: no channel, nothing is paid.')];
    if (!wallet) return [h, el('div', 'channel', 'Connect your wallet to see what is in your channel.')];
    if (!summary) return [h, el('div', 'channel', 'No channel yet. The first interval opens one with a single signature: a deposit of at least 0.10 USDC into the x402 contract on Base. Every interval after that is a voucher this page signs silently.')];
    const dl = el('dl');
    const row = (k: string, v: string) => dl.append(el('dt', undefined, k), el('dd', undefined, v));
    row('In the channel', formatUsdc(summary.balance));
    row('Vouchered to the door', formatUsdc(summary.owed));
    row('Comes back to you', formatUsdc(summary.back));
    return [
      h,
      el('div', 'channel', el('div', undefined, `${summary.channels === 1 ? 'One channel' : `${summary.channels} channels`} on the x402 contract on Base, as this page last saw ${summary.channels === 1 ? 'it' : 'them'}.`), dl,
        el('p', 'note', 'The door claims what it is vouchered in a batch, and refunds the rest once the channel has been idle.')),
    ];
  });

  const o = p.output;
  setRegion(ui.out, `${o.state}|${o.error}`, () => {
    if (o.state === 'loading') return [el('h2', undefined, 'Result'), el('div', 'panel', ...skeleton(2, 1))];
    if (o.state === 'error') return [el('h2', undefined, 'Result'), el('div', 'msg bad', o.error)];
    if (o.state !== 'done' || !o.value) return [];
    if (o.value.kind === 'python') return [el('h2', undefined, 'Result'), pythonResult(o.value)];
    const pages = o.value.pages;
    return [
      el('h2', undefined, 'Result'),
      ...(pages.length === 0 ? [el('p', 'muted', 'The job returned no pages.')] : pages.map(outputPage)),
    ];
  });
}

/** Run the scheduler once now rather than at the next second. */
function step0(p: LeasePage): void {
  clearTimeout(p.timer);
  step(p);
}

function pythonResult(r: PythonOutput): HTMLElement {
  const how = r.timedOut
    ? `Stopped at the ${Math.round(r.seconds)} s limit`
    : r.exitCode === 0
      ? 'The script finished'
      : r.exitCode !== null
        ? `The script exited with code ${r.exitCode}`
        : `The script was stopped (${r.signal ?? 'signal'})`;
  const box = el('div', 'panel', el('div', 'head', el('span', undefined, how), el('span', 'mono', `${r.seconds.toFixed(1)} s on the machine`)));
  const stream = (name: string, text: string, cut: boolean) => [
    el('div', 'stream', cut ? `${name} (first part only)` : name),
    el('pre', undefined, text),
  ];
  box.append(...stream('stdout', r.stdout === '' ? '(nothing printed)' : r.stdout, r.stdoutTruncated));
  if (r.stderr !== '') box.append(...stream('stderr', r.stderr, r.stderrTruncated));
  return box;
}

function outputPage(pg: { url: string; text: string; jpegBase64: string | undefined }): HTMLElement {
  const box = el('div', 'panel', el('div', 'page-url', pg.url));
  if (pg.jpegBase64) {
    const img = el('img');
    img.alt = `Screenshot of ${pg.url}`;
    img.src = `data:image/jpeg;base64,${pg.jpegBase64}`;
    box.append(img);
  }
  box.append(el('div', 'stream', 'text'), el('pre', undefined, pg.text));
  return box;
}

// ---------------------------------------------------------------------------
// Start

async function main(): Promise<void> {
  try {
    dev = (await fetch('/v1/dev')).status === 200;
  } catch {
    dev = false;
  }
  const net = document.getElementById('net');
  if (net) {
    if (dev) {
      net.textContent = 'local test mode';
      net.className = 'chip';
    }
  }
  if (!dev) void loadDoor();
  window.addEventListener('hashchange', go);
  go();
}

void main();
