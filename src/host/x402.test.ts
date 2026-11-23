// The host's tick gate against a stub facilitator: the real @x402/express middleware and the real
// batch-settlement scheme, with an http server in this file answering /supported and /verify. A voucher's
// settlement is local (the scheme's channel record), so "settled" here means the record was charged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { BatchSettlementEvmScheme, computeChannelId } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import type { PaymentRequirements } from '@x402/core/types';
import { channelSalt, doorPayer } from '../door/host-http.js';
import type { Offer } from '../types.js';
import { BATCH_SETTLEMENT_ADDRESS, voucherTypes } from '@x402/evm';
import { BASE_USDC, MAX_TIMEOUT_SECONDS, WITHDRAW_DELAY_SECONDS, buildSchemes, type X402Config } from '../x402/seller.js';
import { hostTickGate } from './x402.js';

const NETWORK = 'eip155:8453';
const PAY_TO = '0x' + '3'.repeat(40);
const CLAIM_KEY = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const LEASE = 'a'.repeat(32);
const PRICE = 7000n;
const door = privateKeyToAccount(('0x' + 'cd'.repeat(32)) as `0x${string}`);
const stranger = privateKeyToAccount(('0x' + 'ef'.repeat(32)) as `0x${string}`);

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, 'base64').toString()) as T;

interface Accepts {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}
interface Required {
  resource: unknown;
  accepts: Accepts[];
}

/** A facilitator listing batch-settlement on Base that verifies every voucher against a funded channel. */
async function facilitator() {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && path.startsWith('/supported')) {
        return void res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: NETWORK }], extensions: [], signers: {} }));
      }
      calls.push(path);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { paymentPayload: { payload: { channelConfig: { payer: string }; voucher: { channelId: string } } } };
      const { channelConfig, voucher } = body.paymentPayload.payload;
      res.end(JSON.stringify({
        isValid: true, payer: channelConfig.payer.toLowerCase(),
        extra: { channelId: voucher.channelId, balance: '100000', totalClaimed: '0', withdrawRequestedAt: 0, refundNonce: '0' },
      }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => void server.close() };
}

async function gated(facilitatorUrl: string) {
  const cfg: X402Config = { payTo: PAY_TO, network: NETWORK, facilitatorUrl, claimKey: CLAIM_KEY, channelDir: join(mkdtempSync(join(tmpdir(), 'host-x402-')), 'channels') };
  const schemes = buildSchemes(cfg);
  const handled: string[] = [];
  const app = express();
  app.use(express.json());
  app.post('/v1/leases/:id/ticks', hostTickGate(cfg, () => PRICE, schemes, () => door.address), (req, res) => {
    handled.push(String(res.locals.payer));
    res.json({ paidIntervals: 1 });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    schemes, handled,
    url: `${base}/v1/leases/${LEASE}/ticks`,
    tick: (headers: Record<string, string> = {}) =>
      fetch(`${base}/v1/leases/${LEASE}/ticks`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"index":0}' }),
    close: () => void server.close(),
  };
}

/** A voucher for `amount` on a channel paid for and authorized by `payer`, against the challenge. */
async function voucher(required: Required, payer: PrivateKeyAccount, amount: bigint) {
  const accepted = required.accepts[0]!;
  const channelConfig = {
    payer: payer.address, payerAuthorizer: payer.address, receiver: accepted.payTo, receiverAuthorizer: accepted.extra!.receiverAuthorizer as string,
    token: accepted.asset, withdrawDelay: accepted.extra!.withdrawDelay as number, salt: '0x' + '5'.padStart(64, '0'),
  };
  const channelId = computeChannelId(channelConfig as never, NETWORK) as `0x${string}`;
  const signature = await payer.signTypedData({
    domain: { name: 'x402 Batch Settlement', version: '1', chainId: 8453, verifyingContract: BATCH_SETTLEMENT_ADDRESS },
    types: voucherTypes,
    primaryType: 'Voucher',
    message: { channelId, maxClaimableAmount: amount },
  });
  const header = b64({
    x402Version: 2, resource: required.resource, accepted,
    payload: { type: 'voucher', channelConfig, voucher: { channelId, maxClaimableAmount: amount.toString(), signature } },
  });
  return { header, channelId };
}

test('hostTickGate offers batch-settlement only, to payTo, at priceOf()', async () => {
  const fac = await facilitator();
  const g = await gated(fac.url);
  try {
    const r = await g.tick();
    assert.equal(r.status, 402);
    const required = unb64<Required>(r.headers.get('payment-required')!);
    assert.equal(required.accepts.length, 1);
    const [a] = required.accepts;
    assert.equal(a!.scheme, 'batch-settlement');
    assert.equal(a!.network, NETWORK);
    assert.equal(a!.asset, BASE_USDC);
    assert.equal(a!.amount, PRICE.toString());
    assert.equal(a!.payTo.toLowerCase(), PAY_TO);
    assert.equal(a!.maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
    assert.equal(a!.extra!.withdrawDelay, WITHDRAW_DELAY_SECONDS);
    assert.deepEqual(g.handled, []);
  } finally {
    g.close();
    fac.close();
  }
});

test('a payer other than the door is 403 not_door and never settled', async () => {
  const fac = await facilitator();
  const g = await gated(fac.url);
  try {
    const required = unb64<Required>((await g.tick()).headers.get('payment-required')!);

    const theirs = await voucher(required, stranger, PRICE);
    const refused = await g.tick({ 'payment-signature': theirs.header });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'not_door' });
    assert.deepEqual(fac.calls, ['/verify'], 'verified, then refused: the facilitator is never asked to settle');
    assert.deepEqual(g.handled, [], 'the tick handler never ran');
    assert.equal((await g.schemes.batch.getStorage().get(theirs.channelId))?.chargedCumulativeAmount ?? '0', '0', 'nothing charged to the stranger\'s channel');

    // The door's own voucher goes through and is charged.
    const ours = await voucher(required, door, PRICE);
    const paid = await g.tick({ 'payment-signature': ours.header });
    assert.equal(paid.status, 200, await paid.clone().text());
    assert.deepEqual(await paid.json(), { paidIntervals: 1 });
    assert.deepEqual(g.handled, [door.address.toLowerCase()]);
    assert.equal((await g.schemes.batch.getStorage().get(ours.channelId))?.chargedCumulativeAmount, PRICE.toString());
  } finally {
    g.close();
    fac.close();
  }
});

test('R11: the door\'s channel salted with the hostId is accepted by a host\'s real batch-settlement gate', async () => {
  const fac = await facilitator();
  const g = await gated(fac.url);
  try {
    const hostId = 'ab'.repeat(32);
    const required = unb64<Required>((await g.tick()).headers.get('payment-required')!);
    const accepted = required.accepts[0]! as unknown as PaymentRequirements;
    // A channel the door already funded, so this tick is a plain voucher (no deposit, no chain).
    const config = new BatchSettlementEvmScheme({ address: door.address, signTypedData: async () => '0x' }, { salt: channelSalt(hostId) }).buildChannelConfig(accepted);
    assert.equal(config.salt, `0x${hostId}`);
    const channelId = computeChannelId(config, NETWORK).toLowerCase();
    const channelDir = mkdtempSync(join(tmpdir(), 'door-salt-'));
    await new FileClientChannelStorage({ directory: join(channelDir, hostId) }).set(channelId, { balance: '100000', chargedCumulativeAmount: '0' });
    const payer = doorPayer({ key: ('0x' + 'cd'.repeat(32)) as `0x${string}`, channelDir, depositFor: () => 'over_cap', atRisk: () => 0n });
    const offer = { hostId, payTo: PAY_TO } as Offer;
    const res = await payer.paidFetch(offer, PRICE)(g.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"index":0}' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(g.handled, [door.address.toLowerCase()]);
    assert.equal((await g.schemes.batch.getStorage().get(channelId))?.chargedCumulativeAmount, PRICE.toString(), 'the host charged the salted channel');
  } finally {
    g.close();
    fac.close();
  }
});

