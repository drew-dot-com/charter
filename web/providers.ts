import type { Eip1193 } from './wallet.js';

/**
 * EIP-6963: each wallet extension announces itself on `window`, so two installed wallets no longer
 * fight over `window.ethereum` (that fight is what makes a connect fail with "Unexpected error").
 */
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  /** Reverse DNS name, such as `io.metamask`. Stable across page loads, unlike `uuid`. */
  rdns: string;
}

export interface AnnouncedWallet {
  info: WalletInfo;
  provider: Eip1193;
}

export const ANNOUNCE_EVENT = 'eip6963:announceProvider';
export const REQUEST_EVENT = 'eip6963:requestProvider';

export const WALLET_REFUSED = 'Your wallet refused the connection. Open it, clear any pending request, then try again.';
export const CHOOSE_WALLET = 'Choose which wallet to pay with, then try again.';
export const NO_WALLET = 'No browser wallet found. Install one such as MetaMask, then reload.';

function parseAnnounce(detail: unknown): AnnouncedWallet | undefined {
  const d = detail as { info?: Partial<WalletInfo>; provider?: { request?: unknown } } | null | undefined;
  const i = d?.info;
  if (!i || typeof i.uuid !== 'string' || !i.uuid || typeof i.name !== 'string' || typeof i.rdns !== 'string') return undefined;
  if (typeof d.provider?.request !== 'function') return undefined;
  return { info: { uuid: i.uuid, name: i.name, icon: typeof i.icon === 'string' ? i.icon : '', rdns: i.rdns }, provider: d.provider as Eip1193 };
}

/**
 * Listen for announcements on `target` (the window), then ask every wallet to announce.
 * The returned list keeps growing as late wallets announce; a repeated uuid replaces its entry.
 */
export function discoverWallets(target: EventTarget): AnnouncedWallet[] {
  const found: AnnouncedWallet[] = [];
  target.addEventListener(ANNOUNCE_EVENT, (ev) => {
    const w = parseAnnounce((ev as CustomEvent).detail);
    if (!w) return;
    const at = found.findIndex((f) => f.info.uuid === w.info.uuid);
    if (at >= 0) found[at] = w;
    else found.push(w);
  });
  target.dispatchEvent(new Event(REQUEST_EVENT));
  return found;
}

export type WalletChoice =
  | { kind: 'provider'; provider: Eip1193; rdns?: string }
  | { kind: 'pick'; wallets: AnnouncedWallet[] }
  | { kind: 'none' };

/**
 * Which provider to use. `chosen` is the rdns the renter picked (or picked on an earlier visit).
 * One announced wallet is used as is; several need a pick; none falls back to `window.ethereum`.
 */
export function chooseWallet(found: readonly AnnouncedWallet[], chosen: string | undefined, injected: Eip1193 | undefined): WalletChoice {
  const picked = chosen ? found.find((w) => w.info.rdns === chosen) : undefined;
  if (picked) return { kind: 'provider', provider: picked.provider, rdns: picked.info.rdns };
  if (found.length === 1) return { kind: 'provider', provider: found[0]!.provider, rdns: found[0]!.info.rdns };
  if (found.length > 1) return { kind: 'pick', wallets: [...found] };
  return injected ? { kind: 'provider', provider: injected } : { kind: 'none' };
}

/** `eth_requestAccounts`, with any wallet error turned into a line the renter can act on. */
export async function requestAccounts(eth: Eip1193): Promise<string[]> {
  try {
    return (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  } catch {
    throw new Error(WALLET_REFUSED);
  }
}
