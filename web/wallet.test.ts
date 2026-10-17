import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { Request } from 'express';
import { MIN_WINDOW_SECONDS, paymentIdOf } from '../src/door/x402.js';
import { evmSigner, payFetchFor, type Eip1193 } from './wallet.js';

const account = privateKeyToAccount(generatePrivateKey());
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x' + '2'.repeat(40);

/** A wallet that signs EIP-712 requests with a local key, as an injected provider would. */
function fakeWallet(seen: string[] = []): Eip1193 {
  return {
    async request({ method, params }) {
      seen.push(method);
      if (method !== 'eth_signTypedData_v4') throw new Error(`unexpected ${method}`);
      const [from, json] = params as [string, string];
      assert.equal(from.toLowerCase(), account.address.toLowerCase());
      const t = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> };
      const { EIP712Domain: _domain, ...types } = t.types;
      // The wire form carries uint256 as strings; the signer wants bigints.
      const message = { ...t.message };
      for (const f of types[t.primaryType]!) if (f.type.startsWith('uint')) message[f.name] = BigInt(message[f.name] as string);
      return account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message } as never);
    },
  };
}

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
      accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '5000', payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' } }],
    };
    res.writeHead(402, { 'content-type': 'application/json', 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') }).end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const methods: string[] = [];
    const pay = payFetchFor(account.address, fakeWallet(methods));
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
    assert.ok(Number(a.validBefore) >= before + 119 && Number(a.validBefore) <= before + 125, 'valid for the 120 s the door asks');
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
