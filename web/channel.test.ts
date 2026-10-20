import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelStorage, depositFor, MIN_DEPOSIT, sessionSigner } from './channel.js';

/** The part of localStorage the page uses. */
function memoryStore(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const A = ('0x' + 'a'.repeat(40)) as `0x${string}`;
const B = ('0x' + 'b'.repeat(40)) as `0x${string}`;

test('depositFor: at least the facilitator floor, at least twenty ticks, at least what this tick needs', () => {
  assert.equal(MIN_DEPOSIT, 100000n);
  assert.equal(depositFor(5000n, 0n), 100000n);
  assert.equal(depositFor(10000n, 0n), 200000n);
  assert.equal(depositFor(5000n, 250000n), 250000n);
});

test('sessionSigner: one key per wallet address, kept in the store, so a reload keeps the channel', async () => {
  const store = memoryStore();
  const first = sessionSigner(A, store);
  assert.equal(sessionSigner(A, store).address, first.address);
  assert.notEqual(sessionSigner(B, store).address, first.address);
  assert.notEqual(sessionSigner(A, memoryStore()).address, first.address, 'a fresh store is a fresh key');
  const sig = await first.signTypedData({ domain: { name: 't', version: '1', chainId: 8453 }, types: { M: [{ name: 'v', type: 'uint256' }] }, primaryType: 'M', message: { v: 1n } });
  assert.match(sig, /^0x[0-9a-f]{130}$/);
});

test('sessionSigner: a store that throws (private mode) still yields a signer, just not a lasting one', () => {
  const broken = { ...memoryStore(), getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as Storage;
  assert.match(sessionSigner(A, broken).address, /^0x[0-9a-fA-F]{40}$/);
});

test('channelStorage: get, set and delete round-trip per wallet, and two wallets do not share a channel record', async () => {
  const store = memoryStore();
  const a = channelStorage(A, store);
  const b = channelStorage(B, store);
  const id = '0x' + 'c1'.repeat(32);
  assert.equal(await a.get(id), undefined);
  await a.set(id, { balance: '100000', chargedCumulativeAmount: '5000' });
  assert.deepEqual(await a.get(id), { balance: '100000', chargedCumulativeAmount: '5000' });
  assert.equal(await b.get(id), undefined);
  assert.deepEqual(await channelStorage(A, store).get(id), { balance: '100000', chargedCumulativeAmount: '5000' }, 'another instance over the same store sees it');
  await a.delete(id);
  assert.equal(await a.get(id), undefined);
});
