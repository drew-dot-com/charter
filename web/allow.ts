// The /allow page: a person connects a Base Account and signs one spend permission so Charter's biller
// can keep an agent's home paid. Everything the door returns is escaped before it becomes HTML.
import { createBaseAccountSDK } from '@base-org/account';
import { requestRevoke, requestSpendPermission } from '@base-org/account/spend-permission';
import { esc } from './grants.js';
import { BEFORE_YOU_START, clampAllowance, errorWords, formatUsdc, hoursFor, stateWords, stopWords } from './allow-copy.js';

/** The cancel button stays hidden until the revoke call is proven on mainnet (plan Task 9 step 2). */
const CANCEL_TESTED = false;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE = 8453;
const REFRESH_MS = 30_000;
/**
 * The permission starts an hour before this device's clock: a device clock running ahead of Charter's would
 * otherwise sign a permission not yet in force (Charter waits for it, and refuses one more than 10 minutes ahead).
 */
const START_BACK_MS = 3_600_000;
const STOP_WORDS = stopWords(CANCEL_TESTED);

interface View {
  allowanceId: string;
  state: string;
  image: string;
  tickMicro: string;
  suggestedMicro: string;
  minMicro: string;
  periodDays: number;
  spender: string;
  account?: string;
  remainingMicro?: string;
  periodEndsAt?: number;
  creditMicro?: string;
  hoursPaid: number;
  lastPullTx?: string;
  reason?: string;
  endReason?: string;
}

const json = (o: unknown) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

async function getView(id: string): Promise<View> {
  const r = await fetch(`/v1/allowances/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? String(r.status));
  return (await r.json()) as View;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function doneHtml(v: View): string {
  const tick = BigInt(v.tickMicro);
  const bits: string[] = [`<p class="msg">${esc(stateWords(v.state))}</p>`];
  if (v.reason) bits.push(`<p>${esc(v.reason)}</p>`);
  bits.push(`<p>Hours paid so far: <strong>${esc(v.hoursPaid)}</strong>.</p>`);
  if (v.remainingMicro !== undefined) bits.push(`<p>Left in this 30-day period: <strong>${esc(formatUsdc(BigInt(v.remainingMicro)))} USDC</strong> (about ${esc(hoursFor(BigInt(v.remainingMicro), tick))} hours).</p>`);
  if (v.periodEndsAt !== undefined) bits.push(`<p>This period ends on ${esc(day(v.periodEndsAt))}.</p>`);
  if (v.account) bits.push(`<p>Your account: <code>${esc(v.account)}</code></p>`);
  bits.push(`<p class="note">${esc(STOP_WORDS)} This page checks again every 30 seconds.</p>`);
  return bits.join('');
}

function waitingHtml(v: View): string {
  const tick = BigInt(v.tickMicro);
  const suggested = BigInt(v.suggestedMicro);
  return `
    <p class="lede">An AI agent rents a small computer ("a home") from Charter. It asked you to let Charter pay for that home hour by hour from your wallet. This page sets that up. You decide the most Charter can ever take in 30 days.</p>
    <div class="msg">${esc(BEFORE_YOU_START)}</div>
    <h2>The terms</h2>
    <ul>
      <li>The home costs <strong>${esc(formatUsdc(tick))} USDC an hour</strong>.</li>
      <li>You allow up to <label>this much every 30 days: <input id="amount" inputmode="decimal" size="8" value="${esc(formatUsdc(suggested))}"> USDC</label>. <span id="hours" class="muted"></span></li>
      <li>Charter's payer is <code>${esc(v.spender)}</code>. It can only take USDC on Base, and only up to that amount in each 30 days. Charter uses it only to pay for this home.</li>
      <li>${esc(STOP_WORDS)}</li>
    </ul>
    <p id="amount-err" class="status" role="alert"></p>
    <h2>Two steps</h2>
    <div class="actions">
      <button id="connect" type="button">1. Connect your Base Account</button>
      <button id="approve" type="button" disabled>2. Approve the allowance</button>
    </div>
    <p id="status" class="status" role="status"></p>
    ${CANCEL_TESTED ? '<div class="actions"><button id="cancel" class="alt" type="button" hidden>Cancel this permission</button></div>' : ''}`;
}

async function main(root: HTMLElement): Promise<void> {
  const id = new URLSearchParams(location.search).get('id') ?? '';
  if (!/^[0-9a-f]{32}$/.test(id)) {
    root.innerHTML = '<p class="msg">This link is not valid. Ask the agent for a new one.</p>';
    return;
  }
  let view: View;
  try {
    view = await getView(id);
  } catch (e) {
    root.innerHTML = `<p class="msg">${esc(errorWords(e instanceof Error ? e.message : 'unknown'))}</p>`;
    return;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  const showDone = (v: View) => {
    root.innerHTML = doneHtml(v);
    if (!timer) {
      timer = setInterval(() => {
        getView(id).then((n) => { root.innerHTML = doneHtml(n); }).catch(() => {});
      }, REFRESH_MS);
    }
  };
  if (view.state !== 'waiting') return showDone(view);

  root.innerHTML = waitingHtml(view);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const amount = q<HTMLInputElement>('#amount');
  const hours = q('#hours');
  const amountErr = q('#amount-err');
  const status = q('#status');
  const connect = q<HTMLButtonElement>('#connect');
  const approve = q<HTMLButtonElement>('#approve');
  const tick = BigInt(view.tickMicro);
  const min = BigInt(view.minMicro);
  const max = BigInt(view.suggestedMicro);

  const read = (): bigint | string => clampAllowance(amount.value, min, max);
  const refreshHours = () => {
    const v = read();
    hours.textContent = typeof v === 'bigint' ? `That pays for about ${hoursFor(v, tick)} hours.` : '';
    amountErr.textContent = typeof v === 'string' ? v : '';
  };
  amount.addEventListener('input', refreshHours);
  refreshHours();

  // The SDK is created on first click so the page loads fast and nothing contacts Coinbase until asked.
  let provider: ReturnType<ReturnType<typeof createBaseAccountSDK>['getProvider']> | undefined;
  let account: string | undefined;
  let permission: unknown;

  connect.addEventListener('click', async () => {
    status.textContent = 'Opening the Coinbase window. If nothing opens, allow pop-ups for this page and press 1 again.';
    try {
      provider ??= createBaseAccountSDK({ appName: 'Charter', appChainIds: [BASE] }).getProvider();
      const accs = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      account = accs[0];
      if (!account) throw new Error('no account');
      approve.disabled = false;
      status.textContent = `Connected: ${account}. Now press 2.`;
    } catch (e) {
      status.textContent = `Could not connect: ${e instanceof Error ? e.message : 'the window was closed'}. You can press 1 again.`;
    }
  });

  approve.addEventListener('click', async () => {
    const v = read();
    if (typeof v === 'string') { amountErr.textContent = v; return; }
    if (!provider || !account) { status.textContent = 'Press 1 first.'; return; }
    approve.disabled = true;
    status.textContent = 'Waiting for your signature in the Coinbase window.';
    try {
      permission = await requestSpendPermission({ account: account as `0x${string}`, spender: view.spender as `0x${string}`, token: USDC, chainId: BASE, allowance: v, periodInDays: 30, start: new Date(Date.now() - START_BACK_MS), provider });
    } catch (e) {
      approve.disabled = false;
      status.textContent = `Not approved: ${e instanceof Error ? e.message : 'the window was closed'}. Nothing was charged. You can press 2 again.`;
      return;
    }
    status.textContent = 'Signed. Telling Charter.';
    try {
      const r = await fetch(`/v1/allowances/${encodeURIComponent(id)}/permission`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(permission) });
      const body = (await r.json().catch(() => ({}))) as View & { error?: string };
      if (!r.ok) {
        status.textContent = errorWords(body.error ?? String(r.status));
        approve.disabled = body.error === 'not_waiting';
        return;
      }
      showDone(body);
    } catch {
      approve.disabled = false;
      status.textContent = 'Could not reach Charter. Check your connection and press 2 again. You will be asked to sign again.';
    }
  });

  if (CANCEL_TESTED) {
    const cancel = root.querySelector('#cancel') as HTMLButtonElement | null;
    cancel?.addEventListener('click', async () => {
      if (!provider || !permission) return;
      try {
        await requestRevoke({ provider, permission: permission as Parameters<typeof requestRevoke>[0]['permission'] });
        status.textContent = 'Cancel sent. Charter will see it within a few minutes.';
      } catch (e) {
        status.textContent = `Cancel failed: ${e instanceof Error ? e.message : 'unknown'}`;
      }
    });
  }
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('allow');
  if (root) void main(root);
}
