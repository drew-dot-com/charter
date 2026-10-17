import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ToonCli, ToonCliError, type Exec } from './toon-cli.js';

// Canned outputs copied from docs/spike-notes.md (live mainnet, toon 0.3.0).
const SEND_OK =
  '{"amount":100,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"fulfilled","paid":100,"response":{"body":"{\\"method\\": \\"POST\\", \\"path\\": \\"/echo\\", \\"body\\": \\"{\\\\\\"hi\\\\\\":1}\\"}","status":200}}';
const SEND_503 =
  '{"amount":100,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"fulfilled","paid":100,"response":{"body":"busy","status":503}}';
const SEND_T01 =
  '{"amount":100,"destination":"g.toon.69b2a212547e7a9c.charter-echo","outcome":"rejected","paid":100,"reject":{"code":"T01","message":"error sending request for url (http://127.0.0.1:7499/echo): error trying to connect: tcp connect error: Connection refused (os error 111)"}}';
const PUBLISH_OK =
  '{"event":{"content":"charter spike: output shape test","created_at":1792193886,"id":"702df20abc8f71b7871f9eac8d6e78997cb431caaba62fbaacd1fe045e29d355","kind":21390,"pubkey":"3c75d15ee999ba19e601d7149324136579f306f237b707f1459664ffec7d8190","sig":"d022","tags":[["L","charter-spike"]]},"outcome":"published","paid":1000,"relay":"wss://relay.mainnet.toonprotocol.dev","response":{"body":"{}","status":200}}';
const CHANNEL_LIST =
  '{"channels":[{"chain":"solana","collateral":1000000,"counterparty":"4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1","direction":"inbound","id":"E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn","landed":0,"scheme":"batch-settlement","status":"open","watermark":400},{"chain":"solana","collateral":999000,"counterparty":"4s2JSwCFJZ7iTmPoLXLhFnfrEvybMTxuWCA2LfMRhyv1","direction":"outbound","id":"8oBnwH4uFQNuuGH5tRKB36jCQ86MFgyvJwNfYpAPoJg5","landed":1000,"scheme":"batch-settlement","status":"open","watermark":1000}]}';
const CHANNEL_LAND =
  '{"channel":{"chain":"solana","id":"E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn","direction":"inbound","transaction":"5zCi1WXY"},"transactions":[{"chain":"solana","hash":"5zCi1WXYRnZadYK1eonrtF6XLerBnPH3q3161ZFoGxEAezsBdRsRNLkBDvpJ9hKoPc8wERc8rv24379wqg6uctw3","network":"mainnet"}]}';

const PASS = '/secrets/charter.pass';
const SEAL = 'http://ev2ocvzg6ubobqh7mnoskk2boxuo3l5grqbro6wvj4hq2ecnacaqttyd.anyone/ilp';
const DEST = 'g.toon.69b2a212547e7a9c.charter-echo';

interface Call {
  args: string[];
  env: Record<string, string>;
  bodyFile?: string;
  bodyAtCall?: string;
}

function fake(stdout: string, code = 0, stderr = ''): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (args, env) => {
    const call: Call = { args, env };
    const i = args.indexOf('--body');
    if (i >= 0) {
      call.bodyFile = args[i + 1];
      call.bodyAtCall = readFileSync(args[i + 1], 'utf8');
    }
    calls.push(call);
    return { code, stdout, stderr };
  };
  return { exec, calls };
}

test('send builds the spike-notes argv and maps the JSON to a PacketAnswer', async () => {
  const { exec, calls } = fake(SEND_OK);
  const cli = new ToonCli({ passphraseFile: PASS, exec });
  const ans = await cli.send(DEST, { method: 'POST', path: '/echo', body: { hi: 1 } }, { sealKey: SEAL, amount: 100n });

  const c = calls[0]!;
  assert.deepEqual(c.args, [
    'send', '--json', '--seal-to', SEAL, '--method', 'POST', '--path', 'echo',
    '--body', c.bodyFile!, '--amount', '100', '--yes', DEST,
  ]);
  assert.equal(c.bodyAtCall, '{"hi":1}');
  assert.equal(ans.status, 200);
  assert.equal(typeof ans.paid, 'bigint');
  assert.equal(ans.paid, 100n);
  assert.deepEqual(ans.body, { method: 'POST', path: '/echo', body: '{"hi":1}' });
});

test('send deletes the body temp file afterwards, and on failure too', async () => {
  const ok = fake(SEND_OK);
  await new ToonCli({ passphraseFile: PASS, exec: ok.exec }).send(DEST, { method: 'POST', path: '/echo', body: {} }, { sealKey: SEAL, amount: 1n });
  assert.equal(existsSync(ok.calls[0]!.bodyFile!), false);

  const bad = fake(SEND_T01, 1);
  await assert.rejects(new ToonCli({ passphraseFile: PASS, exec: bad.exec }).send(DEST, { method: 'POST', path: 'echo', body: {} }, { sealKey: SEAL, amount: 1n }));
  assert.equal(existsSync(bad.calls[0]!.bodyFile!), false);
});

test('send without a body passes no --body, and a bare / path passes no --path', async () => {
  const { exec, calls } = fake(SEND_503);
  const ans = await new ToonCli({ passphraseFile: PASS, exec }).send(DEST, { method: 'GET', path: '/' }, { sealKey: SEAL, amount: 100n });
  assert.deepEqual(calls[0]!.args, ['send', '--json', '--seal-to', SEAL, '--method', 'GET', '--amount', '100', '--yes', DEST]);
  assert.equal(ans.status, 503);
  assert.equal(ans.body, 'busy');
  assert.equal(ans.paid, 100n);
});

test('the passphrase file path is in env, never in argv', async () => {
  const { exec, calls } = fake(SEND_OK);
  const cli = new ToonCli({ passphraseFile: PASS, exec });
  await cli.send(DEST, { method: 'POST', path: '/echo', body: { a: 1 } }, { sealKey: SEAL, amount: 100n });
  await cli.channels().catch(() => undefined);
  for (const c of calls) {
    assert.equal(c.env['TOON_PASSPHRASE_FILE'], PASS);
    assert.ok(!c.args.some((a) => a.includes(PASS)), 'passphrase path leaked into argv');
  }
});

test('a rejected send (exit 1) throws ToonCliError with a truncated stderr', async () => {
  const { exec } = fake(SEND_T01, 1, 'x'.repeat(1000));
  const cli = new ToonCli({ passphraseFile: PASS, exec });
  await assert.rejects(
    cli.send(DEST, { method: 'POST', path: 'echo' }, { sealKey: SEAL, amount: 100n }),
    (e: unknown) => {
      assert.ok(e instanceof ToonCliError);
      assert.equal(e.code, 1);
      assert.equal(e.stderr.length, 400);
      return true;
    },
  );
});

test('a non-zero exit with empty stderr keeps the reject JSON as the error text', async () => {
  const { exec } = fake(SEND_T01, 1);
  await assert.rejects(
    new ToonCli({ passphraseFile: PASS, exec }).send(DEST, { method: 'POST', path: 'echo' }, { sealKey: SEAL, amount: 100n }),
    (e: unknown) => e instanceof ToonCliError && e.stderr.includes('T01'),
  );
});

test('unparseable stdout on exit 0 throws ToonCliError', async () => {
  const { exec } = fake('not json');
  await assert.rejects(
    new ToonCli({ passphraseFile: PASS, exec }).channels(),
    (e: unknown) => e instanceof ToonCliError,
  );
});

test('publishEvent passes kind, tags and content and returns the event id', async () => {
  const { exec, calls } = fake(PUBLISH_OK);
  const id = await new ToonCli({ passphraseFile: PASS, exec }).publishEvent(
    { kind: 31390, tags: [['L', 'charter'], ['d', 'offer-1']], content: '{"x":1}' },
    'wss://relay.mainnet.toonprotocol.dev',
  );
  assert.equal(id, '702df20abc8f71b7871f9eac8d6e78997cb431caaba62fbaacd1fe045e29d355');
  assert.deepEqual(calls[0]!.args, [
    'event', 'publish', '--kind', '31390', '--content', '{"x":1}',
    '--tags', '[["L","charter"],["d","offer-1"]]',
    '--relay', 'wss://relay.mainnet.toonprotocol.dev', '--yes', '--json',
  ]);
});

test('channels maps id, direction and chain', async () => {
  const { exec, calls } = fake(CHANNEL_LIST);
  const out = await new ToonCli({ passphraseFile: PASS, exec }).channels();
  assert.deepEqual(calls[0]!.args, ['channel', 'list', '--json']);
  assert.deepEqual(out, [
    { id: 'E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn', direction: 'inbound', chain: 'solana' },
    { id: '8oBnwH4uFQNuuGH5tRKB36jCQ86MFgyvJwNfYpAPoJg5', direction: 'outbound', chain: 'solana' },
  ]);
});

test('land maps transactions to {chain, tx}; no --yes', async () => {
  const { exec, calls } = fake(CHANNEL_LAND);
  const out = await new ToonCli({ passphraseFile: PASS, exec }).land('E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn');
  assert.deepEqual(calls[0]!.args, ['channel', 'land', 'E63rPnLMYBzt7Jg2rnfMGopLg2vX9V6XXbECvFWXZkUn', '--json']);
  assert.deepEqual(out, [
    { chain: 'solana', tx: '5zCi1WXYRnZadYK1eonrtF6XLerBnPH3q3161ZFoGxEAezsBdRsRNLkBDvpJ9hKoPc8wERc8rv24379wqg6uctw3' },
  ]);
});
