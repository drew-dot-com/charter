import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput, formatUsdc, landingLink, pricePerHour, sizeLabel, tickOutcome } from './format.js';

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');

test('sizeLabel shows vCPU and GB', () => {
  assert.equal(sizeLabel(1, 1024), '1 vCPU · 1 GB');
  assert.equal(sizeLabel(2, 4096), '2 vCPU · 4 GB');
  assert.equal(sizeLabel(1, 512), '1 vCPU · 0.5 GB');
});

test('formatUsdc keeps two decimals and trims the rest', () => {
  assert.equal(formatUsdc(600_000n), '$0.60');
  assert.equal(formatUsdc(0n), '$0.00');
  assert.equal(formatUsdc(15_000n), '$0.015');
  assert.equal(formatUsdc(1n), '$0.000001');
  assert.equal(formatUsdc(2_500_000n), '$2.50');
});

test('pricePerHour is the tick price times the intervals in an hour', () => {
  assert.equal(pricePerHour('5000', 30), 600_000n);
  assert.equal(formatUsdc(pricePerHour('5000', 30)), '$0.60');
  assert.equal(pricePerHour('5000', 60), 300_000n);
});

test('landingLink: Basescan for base and evm, Solscan for solana, shared marked', () => {
  const evmTx = '0x' + 'ab'.repeat(32);
  assert.deepEqual(landingLink({ chain: 'base', tx: evmTx, shared: false }), { href: `https://basescan.org/tx/${evmTx}`, tx: evmTx, shared: false });
  assert.equal(landingLink({ chain: 'evm', tx: evmTx, shared: true })?.href, `https://basescan.org/tx/${evmTx}`);
  assert.equal(landingLink({ chain: 'evm', tx: evmTx, shared: true })?.shared, true);
  const sig = '5'.repeat(88);
  assert.equal(landingLink({ chain: 'solana', tx: sig, shared: false })?.href, `https://solscan.io/tx/${sig}`);
});

test('landingLink never builds a link from an odd chain or a malformed transaction', () => {
  assert.equal(landingLink({ chain: 'base', tx: '"><script>', shared: false })?.href, undefined);
  assert.equal(landingLink({ chain: 'solana', tx: '0xabc', shared: false })?.href, undefined);
  assert.equal(landingLink({ chain: 'other', tx: '0x' + 'ab'.repeat(32), shared: false })?.href, undefined);
  assert.equal(landingLink(undefined), undefined);
});

test('tickOutcome: 200 is paid and carries the host numbers', () => {
  assert.deepEqual(tickOutcome(200, { paidIntervals: 2, paidThrough: 99, duplicate: false }), { kind: 'paid', paidIntervals: 2, paidThrough: 99 });
  assert.equal(tickOutcome(200, {}).kind, 'halt', 'a 200 without the host numbers is not trusted');
});

test('tickOutcome: 503 retry_later retries, out_of_order resyncs', () => {
  assert.deepEqual(tickOutcome(503, { error: 'retry_later' }), { kind: 'retry_later' });
  assert.deepEqual(tickOutcome(409, { error: 'out_of_order', expected: 4 }), { kind: 'resync', expected: 4 });
  assert.equal(tickOutcome(409, { error: 'out_of_order' }).kind, 'halt');
  assert.equal(tickOutcome(503, { error: 'offer_unavailable' }).kind, 'halt');
});

test('tickOutcome: the clear states are halts, with a retry only where a retry can help', () => {
  const retryable = (s: number, e: string) => {
    const o = tickOutcome(s, { error: e });
    assert.equal(o.kind, 'halt', e);
    return o.kind === 'halt' ? o.retry : undefined;
  };
  assert.equal(retryable(409, 'busy'), true);
  assert.equal(retryable(429, 'rate_limited'), true);
  assert.equal(retryable(400, 'authorization_window'), true);
  assert.equal(retryable(402, 'settlement_failed'), true);
  assert.equal(retryable(409, 'lease_done'), false);
  assert.equal(retryable(409, 'not_running'), false);
  assert.equal(retryable(409, 'stopped'), false);
  assert.equal(retryable(403, 'payer_blocked'), false);
  assert.equal(retryable(404, 'not_found'), false);
});

test('tickOutcome: lease_done and not_running ask for a status refresh', () => {
  const o = tickOutcome(409, { error: 'lease_done' });
  assert.equal(o.kind === 'halt' && o.final, true);
});

test('tickOutcome: a non-JSON body still gives a halt with the status', () => {
  const o = tickOutcome(500, undefined);
  assert.equal(o.kind, 'halt');
  assert.match(o.kind === 'halt' ? o.message : '', /500/);
});

test('decodeOutput joins the parts as bytes, so a multi-byte character may straddle a part boundary', () => {
  const json = JSON.stringify({ pages: [{ url: 'https://example.com/', text: 'café ☃', jpegBase64: 'AAAA' }] });
  const bytes = Buffer.from(json);
  const cut = Buffer.from(json.slice(0, json.indexOf('\u00e9'))).length + 1; // inside the two bytes of the e-acute
  const parts = [b64(bytes.subarray(0, cut)), b64(bytes.subarray(cut))];
  assert.deepEqual(decodeOutput(parts), { pages: [{ url: 'https://example.com/', text: 'café ☃', jpegBase64: 'AAAA' }] });
});

test('decodeOutput refuses a result that is not {pages:[...]}', () => {
  assert.throws(() => decodeOutput([b64('not json')]));
  assert.throws(() => decodeOutput([b64('{"pages":"x"}')]));
  assert.throws(() => decodeOutput([b64('{"pages":[{"url":1,"text":"t"}]}')]));
});

test('decodeOutput tolerates a page without a screenshot, and drops a malformed one', () => {
  const out = decodeOutput([b64(JSON.stringify({ pages: [{ url: 'u', text: 't' }, { url: 'v', text: 'w', jpegBase64: 'not base64!' }] }))]);
  assert.deepEqual(out.pages[0], { url: 'u', text: 't', jpegBase64: undefined });
  assert.equal(out.pages[1]!.jpegBase64, undefined);
});
