import type { Lease } from '../src/types.js';
import { decodeOutput, formatUsdc, landingLink, pricePerHour, sizeLabel, UNEXPECTED_PAYMENT, type JobOutput } from './format.js';
import { nextTickAt } from './schedule.js';
import { applyStatus, clearHalt, newTickState, runTick, shouldTick, type TickState } from './ticker.js';
import { BASE_CHAIN_ID_HEX, BASE_NETWORK, BASE_USDC, payFetchFor, type Eip1193 } from './wallet.js';

// ---------------------------------------------------------------------------
// Constants

const POLL_MS = 5_000;
const POLL_FINAL_MS = 15_000;
const STEP_MS = 1_000;
const MAX_URLS = 5;
const MAX_OUTPUT_PARTS = 100;

const STATE_LABEL: Record<Lease['state'], string> = {
  booting: 'Starting the machine',
  awaiting_first_tick: 'Waiting for the first payment',
  running: 'Running',
  done: 'Done',
  closed: 'Closed',
};

const CLOSE_REASON: Record<string, string> = {
  boot_failed: 'The machine did not start. Nothing is owed.',
  missed_tick: 'A payment was missed, so the lease closed.',
  max_intervals: 'The lease reached its maximum length.',
  host_restart: 'The host restarted, so the lease closed.',
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

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', primary ? 'primary' : undefined, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function short(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 140 ? `${m.slice(0, 140)}...` : m;
}

// ---------------------------------------------------------------------------
// The door's API

interface PublicOffer {
  offerId: string;
  cpu: number;
  memoryMiB: number;
  intervalSeconds: number;
  tickPrice: string;
  hiddenHost: boolean;
}

interface Answer {
  status: number;
  body: unknown;
}

async function call(f: typeof fetch, path: string, init?: RequestInit): Promise<Answer> {
  const res = await f(path, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

const errorCode = (a: Answer): string => ((a.body as { error?: unknown } | undefined)?.error as string | undefined) ?? 'unknown';

function parseOffers(body: unknown): PublicOffer[] {
  if (!Array.isArray(body)) throw new Error('bad offers answer');
  return body.filter(
    (o): o is PublicOffer =>
      !!o &&
      typeof o.offerId === 'string' &&
      typeof o.cpu === 'number' &&
      typeof o.memoryMiB === 'number' &&
      typeof o.intervalSeconds === 'number' &&
      o.intervalSeconds > 0 &&
      typeof o.tickPrice === 'string' &&
      /^\d+$/.test(o.tickPrice) &&
      typeof o.hiddenHost === 'boolean',
  );
}

// ---------------------------------------------------------------------------
// Wallet: an EIP-1193 provider signs the x402 payments (USDC on Base, EIP-3009).

interface Wallet {
  address: `0x${string}`;
  eth: Eip1193;
}

/** Where the door says payments go. Read once; a 402 naming any other payee is refused. */
interface DoorInfo {
  payTo: string;
  network: string;
}

let wallet: Wallet | undefined;
/** The door has no payment gate (local development): the page skips x402. */
let dev = false;
let doorInfo: DoorInfo | undefined;

function provider(): Eip1193 | undefined {
  return (window as unknown as { ethereum?: Eip1193 }).ethereum;
}

/** `silent`: reuse an account the wallet already shared, never prompt. Returns undefined when there is none. */
async function connectWallet(silent = false): Promise<Wallet | undefined> {
  if (wallet) return wallet;
  const eth = provider();
  if (!eth) {
    if (silent) return undefined;
    throw new Error('No browser wallet found. Install one such as MetaMask, then reload.');
  }
  const accounts = (await eth.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' })) as string[];
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
  const m = /^#\/lease\/([0-9a-f]{32})$/.exec(location.hash);
  if (m) void showLease(m[1]!, route);
  else void showHome(route);
}

// ---------------------------------------------------------------------------
// Machines for rent

async function showHome(token: number): Promise<void> {
  const list = el('ul', 'rows');
  mount(
    el('h1', undefined, 'Machines for rent'),
    el('p', 'lede', 'Rent a machine by the hour. It fetches the pages you name and sends back a screenshot and the text.'),
    list,
    el('p', 'note', 'No account. Pay from any funded channel.'),
    dev ? el('p', 'note', 'Local test mode: payments are skipped.') : null,
  );
  list.append(el('li', 'muted', 'Loading machines'));
  let offers: PublicOffer[];
  try {
    const a = await call(fetch, '/v1/offers');
    if (a.status !== 200) throw new Error(String(a.status));
    offers = parseOffers(a.body);
  } catch {
    if (token !== route) return;
    list.replaceChildren(el('li', 'msg bad', 'Could not load the machines. Reload to try again.'));
    return;
  }
  if (token !== route) return;
  if (offers.length === 0) {
    list.replaceChildren(el('li', 'muted', 'No machines are listed right now.'));
    return;
  }
  list.replaceChildren(...offers.map(offerRow));
}

function offerRow(o: PublicOffer): HTMLElement {
  const row = el('li', 'row');
  const main = el(
    'div',
    'row-main',
    el('span', 'size', sizeLabel(o.cpu, o.memoryMiB)),
    o.hiddenHost ? el('span', 'badge', 'hidden host') : null,
  );
  const rent = button('Rent', () => {
    rent.disabled = true;
    row.append(rentForm(o, () => {
      rent.disabled = false;
    }));
  }, true);
  rent.setAttribute('aria-label', `Rent ${sizeLabel(o.cpu, o.memoryMiB)}`);
  main.append(el('span', 'buy', el('span', 'price', `${formatUsdc(pricePerHour(o.tickPrice, o.intervalSeconds))}/hr`), rent));
  row.append(main);
  return row;
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
  400: 'The door refused those addresses.',
  404: 'That machine is no longer offered. Reload the list.',
  429: 'Too many leases were started from this network. Try again later.',
};

function rentForm(o: PublicOffer, close: () => void): HTMLElement {
  const area = el('textarea');
  area.id = `urls-${o.offerId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
  area.placeholder = 'https://example.com';
  area.rows = 5;
  area.spellcheck = false;
  const label = el('label', undefined, `Pages to fetch (up to ${MAX_URLS}, one address per line)`);
  label.htmlFor = area.id;
  const status = el('p', 'muted');
  status.setAttribute('role', 'status');
  const form = el('form', 'rent-form');
  const start = el('button', 'primary', 'Start lease');
  start.type = 'submit';
  const cancel = button('Cancel', () => {
    form.remove();
    close();
  });
  form.append(label, area, status, el('div', 'actions', start, cancel));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void (async () => {
      const urls = parseUrls(area.value);
      if (typeof urls === 'string') {
        status.textContent = urls;
        return;
      }
      start.disabled = true;
      try {
        if (!dev) {
          status.textContent = 'Connecting your wallet';
          await connectWallet();
        }
        status.textContent = 'Starting the machine';
        const a = await call(fetch, '/v1/leases', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ offerId: o.offerId, urls }),
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
  offer: PublicOffer | undefined;
  offerTried: boolean;
  lastPoll: number;
  /** The status read in flight, if any. */
  polling: Promise<void> | undefined;
  notice: string | undefined;
  output: { state: 'idle' | 'loading' | 'done' | 'error'; value?: JobOutput; error?: string };
  ui: {
    state: HTMLElement;
    paid: HTMLElement;
    spent: HTMLElement;
    next: HTMLElement;
    msg: HTMLElement;
    landing: HTMLElement;
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

function fact(label: string, value: HTMLElement): HTMLElement {
  return el('div', 'fact', el('div', 'label', label), value);
}

async function showLease(id: string, token: number): Promise<void> {
  const ui: LeasePage['ui'] = {
    state: el('div', 'value', 'Loading'),
    paid: el('div', 'value', '0'),
    spent: el('div', 'value', '$0.00'),
    next: el('p', 'muted'),
    msg: el('div'),
    landing: el('p'),
    out: el('div'),
  };
  const page: LeasePage = {
    id, alive: true, timer: undefined, t: newTickState(), offer: undefined, offerTried: false, lastPoll: 0, polling: undefined,
    notice: undefined, output: { state: 'idle' }, ui,
  };
  current = page;
  const back = el('a', undefined, 'Back to machines');
  back.href = '#/';
  mount(
    el('p', undefined, back),
    el('h1', undefined, 'Your lease'),
    el('div', 'facts', fact('State', ui.state), fact('Intervals paid', ui.paid), fact('Spent', ui.spent)),
    ui.next,
    ui.msg,
    ui.landing,
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

/** The offer's tick price turns paid intervals into dollars, and is the one amount the page will pay. The lease's offer id is the host's, the offers list's is `<pubkey>:<id>`. */
async function loadOffer(p: LeasePage): Promise<void> {
  try {
    const a = await call(fetch, '/v1/offers');
    if (a.status !== 200 || !p.t.lease) return;
    const hostId = p.t.lease.offerId;
    p.offer = parseOffers(a.body).find((o) => o.offerId.endsWith(`:${hostId}`));
  } catch {
    // Spent stays unknown.
  }
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
      if (!p.offerTried) {
        p.offerTried = true;
        void loadOffer(p);
      }
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
    post: async (index) => {
      let pay: typeof fetch = fetch;
      if (!dev) {
        // The page signs one payment only: this lease's tick price, to the door's payTo, in USDC on Base.
        if (!doorInfo) await loadDoor();
        if (!p.offer) await loadOffer(p);
        if (!doorInfo || !p.offer || doorInfo.network !== BASE_NETWORK) throw new Error(UNEXPECTED_PAYMENT);
        pay = payFetchFor(wallet!.address, wallet!.eth, {
          network: BASE_NETWORK,
          asset: BASE_USDC,
          amount: BigInt(p.offer.tickPrice),
          payTo: doorInfo.payTo,
        });
      }
      return call(pay, `/v1/leases/${p.id}/ticks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index }),
      });
    },
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
  if (lease) {
    ui.state.textContent = STATE_LABEL[lease.state];
    ui.state.className = lease.state === 'done' ? 'value state-done' : 'value';
    ui.paid.textContent = String(lease.paidIntervals);
    ui.spent.textContent = p.offer ? formatUsdc(BigInt(p.offer.tickPrice) * BigInt(lease.paidIntervals)) : 'n/a';
  }

  const now = Date.now();
  let next = '';
  if (lease && !isFinal(lease)) {
    const due = nextTickAt(lease, now);
    if (p.t.ticking) next = 'Paying now';
    else if (p.t.halt) next = 'Payments are paused.';
    else if (!dev && !wallet) next = 'Payments are waiting for your wallet.';
    else if (due !== null) next = due <= now ? 'Next payment is due.' : `Next payment in ${Math.ceil((due - now) / 1000)} s`;
    else if (lease.state === 'booting') next = 'The machine is starting.';
  }
  ui.next.textContent = next;

  const closed = lease?.state === 'closed' ? (lease.closedReason ? CLOSE_REASON[lease.closedReason] : undefined) ?? 'The lease closed.' : '';
  const needsWallet = !dev && !wallet && !!lease && !isFinal(lease);
  setRegion(ui.msg, `${p.t.halt?.message}|${p.t.halt?.retry}|${p.notice}|${closed}|${needsWallet}`, () => {
    const out: Child[] = [];
    if (closed) out.push(el('div', 'msg warn', closed));
    if (p.t.halt) {
      const box = el('div', 'msg bad', p.t.halt.message);
      if (p.t.halt.retry) {
        box.append(el('div', 'actions', button('Try again', () => {
          clearHalt(p.t);
          p.lastPoll = 0;
          render(p);
          step0(p);
        }, true)));
      }
      out.push(box);
    }
    if (needsWallet) {
      const box = el('div', 'msg warn', 'Connect your wallet to keep paying for this lease. Without a payment in time, it closes.');
      const note = el('p', 'muted');
      box.append(el('div', 'actions', button('Connect wallet', () => {
        connectWallet().then(() => render(p), (e) => {
          note.textContent = short(e);
        });
      }, true)), note);
      out.push(box);
    }
    if (p.notice) out.push(el('p', 'muted', p.notice));
    return out;
  });

  const link = landingLink(lease?.landing);
  setRegion(ui.landing, link ? `${link.href}|${link.tx}|${link.shared}` : '', () => {
    if (!link) return [];
    const tx = link.href
      ? (() => {
          const a = el('a', undefined, `${link.tx.slice(0, 10)}...${link.tx.slice(-6)}`);
          a.href = link.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          return a;
        })()
      : el('span', undefined, link.tx);
    return ['Landed on chain: ', tx, link.shared ? el('span', 'badge', 'shared batch') : null];
  });

  const o = p.output;
  setRegion(ui.out, `${o.state}|${o.error}`, () => {
    if (o.state === 'loading') return [el('p', 'muted', 'Loading the result')];
    if (o.state === 'error') return [el('div', 'msg bad', o.error)];
    if (o.state !== 'done' || !o.value) return [];
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

function outputPage(pg: { url: string; text: string; jpegBase64: string | undefined }): HTMLElement {
  const box = el('div', 'page-out', el('div', 'page-url', pg.url));
  if (pg.jpegBase64) {
    const img = el('img');
    img.alt = `Screenshot of ${pg.url}`;
    img.src = `data:image/jpeg;base64,${pg.jpegBase64}`;
    box.append(img);
  }
  box.append(el('pre', undefined, pg.text));
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
  if (!dev) void loadDoor();
  window.addEventListener('hashchange', go);
  go();
}

void main();
