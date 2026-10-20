import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyTypedData } from 'viem';
import { decodePaymentSignatureHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { Request } from 'express';
import { MIN_WINDOW_SECONDS, paymentIdOf } from '../src/door/x402.js';
import { account, fakeWallet } from './test-wallet.js';
import { isUnexpectedPayment } from './format.js';
import { channelStorage, sessionSigner } from './channel.js';
import { BASE_USDC, evmSigner, payFetchFor, type ExpectedPayment } from './wallet.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x' + '2'.repeat(40);
const EXPECTED: ExpectedPayment = { network: 'eip155:8453' as const, asset: USDC, amount: 5000n, payTo: PAY_TO };
const ACCEPT = { scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '5000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } };

test('the signer adapter signs typed data through the injected wallet, bigint fields included', async () => {
  const signer = evmSigner(account.address, fakeWallet());
  const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };
  const types = { Note: [{ name: 'value', type: 'uint256' }] };
  const sig = await signer.signTypedData({ domain, types, primaryType: 'Note', message: { value: 5000n } });
  assert.equal(await verifyTypedData({ address: account.address, domain, types, primaryType: 'Note', message: { value: 5000n }, signature: sig }), true);
});

test('payFetchFor answers a 402 with a signed EIP-3009 authorization that the door can read', async () => {
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    const paid = req.headers['payment-signature'];
    if (paid) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"paidIntervals":1,"paidThrough":1}');
    const required = {
      x402Version: 2,
      error: 'Payment required',
      resource: { url: 'http://127.0.0.1/v1/leases/x/ticks' },
      accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '5000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }],
    };
    res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') }).end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const methods: string[] = [];
    const pay = payFetchFor(account.address, fakeWallet(methods), EXPECTED);
    const before = Math.floor(Date.now() / 1000);
    const res = await pay(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/leases/x/ticks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index: 0 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(methods, ['eth_signTypedData_v4']);
    assert.equal(headers.length, 2, 'one unpaid request, then one paid');
    const payload = decodePaymentSignatureHeader(headers[1]!['payment-signature'] as string) as {
      accepted: { network: string; amount: string };
      payload: { authorization: Record<string, string>; signature: `0x${string}` };
    };
    assert.equal(payload.accepted.network, 'eip155:8453');
    // The door's own reader accepts it, and its window is long enough for the door.
    const id = paymentIdOf({ headers: { 'payment-signature': headers[1]!['payment-signature'] } } as unknown as Request);
    assert.ok(typeof id === 'object');
    assert.equal(id.from, account.address.toLowerCase());
    assert.ok(id.validBefore - before >= MIN_WINDOW_SECONDS, 'the window outlasts the door minimum');
    const a = payload.payload.authorization;
    assert.equal(a.from.toLowerCase(), account.address.toLowerCase());
    assert.equal(a.to.toLowerCase(), PAY_TO.toLowerCase());
    assert.equal(a.value, '5000');
    assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
    assert.ok(Number(a.validBefore) >= before + 299 && Number(a.validBefore) <= before + 305, 'valid for the 300 s the door asks');
    assert.equal(
      await verifyTypedData({
        address: account.address,
        domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
        types: { TransferWithAuthorization: [
          { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ] },
        primaryType: 'TransferWithAuthorization',
        message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
        signature: payload.payload.signature,
      }),
      true,
    );
  } finally {
    server.close();
  }
});

/** A server that answers every unpaid request with a 402 offering `accepts`, and a paid one with 200. */
async function with402(accepts: object[], run: (url: string, paidCount: () => number) => Promise<void>): Promise<void> {
  let paid = 0;
  const server = createServer((req, res) => {
    if (req.headers['payment-signature']) {
      paid++;
      return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"paidIntervals":1,"paidThrough":1}');
    }
    const required = { x402Version: 2, resource: { url: 'http://127.0.0.1/t' }, accepts };
    res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') }).end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/t`, () => paid);
  } finally {
    server.close();
  }
}

const post = (pay: typeof fetch, url: string) => pay(url, { method: 'POST', body: '{}' });

for (const [name, bad] of [
  ['a different amount', { amount: '5001' }],
  ['a smaller amount', { amount: '1' }],
  ['a different asset', { asset: '0x' + '9'.repeat(40) }],
  ['a different network', { network: 'eip155:1' }],
  ['a different payTo', { payTo: '0x' + '3'.repeat(40) }],
  ['a different scheme', { scheme: 'upto' }],
] as const) {
  test(`the page signs nothing for a payment request with ${name}`, async () => {
    await with402([{ ...ACCEPT, ...bad }], async (url, paid) => {
      const methods: string[] = [];
      await assert.rejects(post(payFetchFor(account.address, fakeWallet(methods), EXPECTED), url), (e: unknown) => isUnexpectedPayment(e));
      assert.deepEqual(methods, [], 'the wallet was never asked to sign');
      assert.equal(paid(), 0);
    });
  });
}

test('the page signs the one matching entry of several, whatever order they come in; asset and payTo compare without case', async () => {
  const odd = { ...ACCEPT, amount: '999999' };
  const upper = { ...ACCEPT, asset: USDC.toLowerCase(), payTo: PAY_TO.toUpperCase().replace('0X', '0x') };
  await with402([odd, upper], async (url, paid) => {
    const methods: string[] = [];
    assert.equal((await post(payFetchFor(account.address, fakeWallet(methods), EXPECTED), url)).status, 200);
    assert.deepEqual(methods, ['eth_signTypedData_v4']);
    assert.equal(paid(), 1);
  });
});

test('BASE_USDC is the Base mainnet USDC contract', () => {
  assert.equal(BASE_USDC, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
});

// ---------------------------------------------------------------------------
// batch-settlement: one deposit prompt, then vouchers signed by the page's session key.

const RECEIVER_AUTHORIZER = '0x' + 'd'.repeat(40);
const BATCH = { scheme: 'batch-settlement', network: 'eip155:8453', asset: USDC, amount: '5000', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', receiverAuthorizer: RECEIVER_AUTHORIZER, withdrawDelay: 3600 } };

function memoryStore(): Storage {
  const m = new Map<string, string>();
  return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) };
}

/** A door that settles batch payments the way the real scheme answers: charged this much, channel state after. */
async function withBatchDoor(accepts: object[], run: (url: string, seen: Array<Record<string, unknown>>) => Promise<void>): Promise<void> {
  const seen: Array<Record<string, unknown>> = [];
  let charged = 0n;
  const server = createServer((req, res) => {
    const h = req.headers['payment-signature'];
    if (h) {
      const p = decodePaymentSignatureHeader(h as string) as { payload: Record<string, unknown> };
      seen.push(p.payload);
      charged += 5000n;
      const response = encodePaymentResponseHeader({ success: true, transaction: '', network: 'eip155:8453', payer: account.address, extra: { chargedAmount: '5000', channelState: { chargedCumulativeAmount: charged.toString() } } });
      return void res.writeHead(200, { 'content-type': 'application/json', 'PAYMENT-RESPONSE': response }).end('{"paidIntervals":1,"paidThrough":1}');
    }
    const required = { x402Version: 2, resource: { url: 'http://127.0.0.1/t' }, accepts };
    res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') }).end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/t`, seen);
  } finally {
    server.close();
  }
}

test('batch: the first tick deposits the floor with one wallet prompt, bound to the session key; the next tick is a voucher with no prompt', async () => {
  await withBatchDoor([ACCEPT, BATCH], async (url, seen) => {
    const store = memoryStore();
    const session = sessionSigner(account.address, store);
    const storage = channelStorage(account.address, store);
    const methods: string[] = [];
    const pay = payFetchFor(account.address, fakeWallet(methods), EXPECTED, fetch, { session, storage, batch: true });
    assert.equal((await post(pay, url)).status, 200);
    assert.deepEqual(methods, ['eth_signTypedData_v4'], 'the deposit authorization is the one prompt');
    const first = seen[0] as { type: string; deposit: { amount: string }; channelConfig: { payer: string; payerAuthorizer: string; receiver: string; receiverAuthorizer: string }; voucher: { maxClaimableAmount: string } };
    assert.equal(first.type, 'deposit');
    assert.equal(first.deposit.amount, '100000');
    assert.equal(first.channelConfig.payer.toLowerCase(), account.address.toLowerCase());
    assert.equal(first.channelConfig.payerAuthorizer.toLowerCase(), session.address.toLowerCase(), 'vouchers are signed by the session key');
    assert.equal(first.channelConfig.receiver.toLowerCase(), PAY_TO);
    assert.equal(first.channelConfig.receiverAuthorizer.toLowerCase(), RECEIVER_AUTHORIZER);
    assert.equal(first.voucher.maxClaimableAmount, '5000');
    // The door's reader sees a batch payment from the wallet.
    const id = paymentIdOf({ headers: { 'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted: BATCH, payload: first } as never) } } as unknown as Request);
    assert.ok(typeof id === 'object' && id.kind === 'batch' && id.from === account.address.toLowerCase());

    assert.equal((await post(pay, url)).status, 200);
    assert.deepEqual(methods, ['eth_signTypedData_v4'], 'no second prompt');
    const second = seen[1] as { type: string; voucher: { maxClaimableAmount: string } };
    assert.equal(second.type, 'voucher');
    assert.equal(second.voucher.maxClaimableAmount, '10000', 'cumulative');
    // A fresh page over the same store carries on without depositing.
    const again = payFetchFor(account.address, fakeWallet(methods), EXPECTED, fetch, { session: sessionSigner(account.address, store), storage: channelStorage(account.address, store), batch: true });
    assert.equal((await post(again, url)).status, 200);
    assert.equal((seen[2] as { type: string }).type, 'voucher');
    assert.deepEqual(methods, ['eth_signTypedData_v4']);
  });
});

test('batch off: the page pays exact even when the door offers batch first', async () => {
  await withBatchDoor([BATCH, ACCEPT], async (url, seen) => {
    const store = memoryStore();
    const pay = payFetchFor(account.address, fakeWallet(), EXPECTED, fetch, { session: sessionSigner(account.address, store), storage: channelStorage(account.address, store), batch: false });
    assert.equal((await post(pay, url)).status, 200);
    assert.ok('authorization' in seen[0]!, 'an EIP-3009 authorization, not a voucher');
  });
});

test('batch: a batch entry with another amount or payTo is never signed, exact or not', async () => {
  for (const bad of [{ ...BATCH, amount: '5001' }, { ...BATCH, payTo: '0x' + '3'.repeat(40) }]) {
    await with402([bad], async (url, paid) => {
      const store = memoryStore();
      const methods: string[] = [];
      const pay = payFetchFor(account.address, fakeWallet(methods), EXPECTED, fetch, { session: sessionSigner(account.address, store), storage: channelStorage(account.address, store), batch: true });
      await assert.rejects(post(pay, url), (e: unknown) => isUnexpectedPayment(e));
      assert.deepEqual(methods, []);
      assert.equal(paid(), 0);
    });
  }
});
