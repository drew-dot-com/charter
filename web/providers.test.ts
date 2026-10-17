import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANNOUNCE_EVENT, REQUEST_EVENT, WALLET_REFUSED, chooseWallet, discoverWallets, requestAccounts, type AnnouncedWallet } from './providers.js';
import type { Eip1193 } from './wallet.js';

const fake = (name: string): Eip1193 & { name: string } => ({ name, request: async () => [] });

function announced(rdns: string, uuid = `${rdns}-uuid`): AnnouncedWallet {
  return { info: { uuid, name: rdns, icon: '', rdns }, provider: fake(rdns) };
}

/** A window stand-in where each wallet announces itself when asked, as EIP-6963 wallets do. */
function windowWith(...ws: AnnouncedWallet[]): EventTarget {
  const target = new EventTarget();
  const announce = (w: AnnouncedWallet) => target.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: w }));
  target.addEventListener(REQUEST_EVENT, () => ws.forEach(announce));
  return target;
}

test('discovery asks every wallet to announce and collects each one', () => {
  const found = discoverWallets(windowWith(announced('io.metamask'), announced('com.coinbase.wallet')));
  assert.deepEqual(found.map((w) => w.info.rdns), ['io.metamask', 'com.coinbase.wallet']);
});

test('discovery keeps a wallet that announces late, and a repeated uuid replaces its entry', () => {
  const target = windowWith();
  const found = discoverWallets(target);
  assert.equal(found.length, 0);
  const late = announced('io.rabby');
  target.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: late }));
  const again = { ...late, provider: fake('io.rabby again') };
  target.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: again }));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.provider, again.provider);
});

test('discovery ignores announcements without a uuid, an rdns or a request function', () => {
  const target = windowWith();
  const found = discoverWallets(target);
  for (const detail of [
    null,
    { info: { name: 'x', rdns: 'x' }, provider: fake('x') },
    { info: { uuid: 'u', name: 'x' }, provider: fake('x') },
    { info: { uuid: 'u', name: 'x', rdns: 'x' }, provider: {} },
  ]) target.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail }));
  assert.equal(found.length, 0);
});

test('one announced wallet is used even when window.ethereum is another', () => {
  const mm = announced('io.metamask');
  const c = chooseWallet([mm], undefined, fake('injected'));
  assert.deepEqual(c, { kind: 'provider', provider: mm.provider, rdns: 'io.metamask' });
});

test('two announced wallets need a pick, and window.ethereum is not used for them', () => {
  const ws = [announced('io.metamask'), announced('app.phantom')];
  const c = chooseWallet(ws, undefined, fake('injected'));
  assert.equal(c.kind, 'pick');
  assert.deepEqual(c.kind === 'pick' && c.wallets.map((w) => w.info.rdns), ['io.metamask', 'app.phantom']);
});

test('the picked wallet is used, and a pick of a wallet no longer installed asks again', () => {
  const ws = [announced('io.metamask'), announced('app.phantom')];
  assert.deepEqual(chooseWallet(ws, 'app.phantom', undefined), { kind: 'provider', provider: ws[1]!.provider, rdns: 'app.phantom' });
  assert.equal(chooseWallet(ws, 'io.rabby', undefined).kind, 'pick');
});

test('with no announced wallet, window.ethereum is the fallback, and with neither there is none', () => {
  const eth = fake('injected');
  assert.deepEqual(chooseWallet([], undefined, eth), { kind: 'provider', provider: eth });
  assert.deepEqual(chooseWallet([], 'io.metamask', eth), { kind: 'provider', provider: eth });
  assert.deepEqual(chooseWallet([], undefined, undefined), { kind: 'none' });
});

test('a wallet error from eth_requestAccounts becomes a line the renter can act on', async () => {
  const refusing: Eip1193 = {
    request: async () => {
      throw Object.assign(new Error('Unexpected error'), { code: -32603 });
    },
  };
  await assert.rejects(requestAccounts(refusing), { message: WALLET_REFUSED });
  assert.doesNotMatch(WALLET_REFUSED, /—/, 'no em dash in a shipped string');
});

test('requestAccounts passes the accounts through and asks with eth_requestAccounts', async () => {
  const seen: string[] = [];
  const ok: Eip1193 = {
    request: async ({ method }) => {
      seen.push(method);
      return ['0x' + '1'.repeat(40)];
    },
  };
  assert.deepEqual(await requestAccounts(ok), ['0x' + '1'.repeat(40)]);
  assert.deepEqual(seen, ['eth_requestAccounts']);
});
