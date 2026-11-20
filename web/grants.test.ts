import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBalance, renderGrants, type GrantsData } from './grants.js';

const base = { grantId: 'g1', state: 'approved', name: 'Agent', image: 'charter-home', createdAt: 1_700_000_000_000, leaseId: 'abcd1234', paidHours: 3, renewedByGrantee: false, updatedAt: 1_700_000_000_000 };
const fund = { address: '0x1111111111111111111111111111111111111111', balanceMicro: '12345678', grantsLeft: 4 };
const data = (g: Record<string, unknown>[], f: GrantsData['fund'] = fund): GrantsData => ({ grants: g as GrantsData['grants'], fund: f });

test('renderGrants escapes HTML in name, summary and reason', () => {
  const html = renderGrants(data([{ ...base, name: '<script>x</script>', summary: '"a" & \'b\' <i>', reason: '<img src=x onerror=1>' }]));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<i>'));
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(html.includes('&quot;a&quot; &amp; &#39;b&#39; &lt;i&gt;'));
});

test('renderGrants shows renewed on own money only when true', () => {
  assert.ok(!renderGrants(data([base])).includes('renewed on its own money'));
  assert.ok(renderGrants(data([{ ...base, renewedByGrantee: true }])).includes('renewed on its own money'));
});

test('renderGrants links only https and marks the anchor', () => {
  const ok = renderGrants(data([{ ...base, link: 'https://example.com/a?b=1&c=2' }]));
  assert.ok(ok.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(ok.includes('rel="nofollow noopener noreferrer"'));
  for (const bad of ['javascript:alert(1)', 'http://example.com', 'HTTPS://x.com']) {
    assert.ok(!renderGrants(data([{ ...base, link: bad }])).includes('<a href'), bad);
  }
});

test('renderGrants with no fund says it is not open yet', () => {
  assert.ok(renderGrants(data([], null)).includes('not open yet'));
});

test('renderGrants shows the fund address, balance and grants left', () => {
  const html = renderGrants(data([]));
  assert.ok(html.includes(fund.address));
  assert.ok(html.includes('12.345678 USDC'));
  assert.ok(html.includes('4'));
});

test('formatBalance is exact', () => {
  assert.equal(formatBalance('0'), '0.00');
  assert.equal(formatBalance('7000'), '0.007');
  assert.equal(formatBalance('100000000'), '100.00');
  assert.equal(formatBalance('12345678'), '12.345678');
  assert.equal(formatBalance('9007199254740993'), '9007199254.740993');
  assert.equal(formatBalance('junk'), 'unknown');
});
