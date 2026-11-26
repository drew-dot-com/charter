import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSocialConfig } from './config.js';

const FUND = '0x' + 'ab'.repeat(20);
const PROBE = '0x' + 'cd'.repeat(20);
const good: NodeJS.ProcessEnv = {
  X_CONSUMER_KEY: 'ck',
  X_CONSUMER_SECRET: 'cs',
  X_ACCESS_TOKEN: 'at',
  X_ACCESS_SECRET: 'as',
  X_USER_ID: '123',
  GEMINI_API_KEY: 'g',
  GEMINI_MODEL_WRITE: 'w-model',
  GEMINI_MODEL_CHECK: 'c-model',
  TELEGRAM_BOT_TOKEN_FILE: '/secrets/telegram.token',
  TELEGRAM_CHAT_ID: '42',
  CHARTER_SITE_URL: 'https://charter.example',
  FIRST_PARTY_PAYERS: FUND,
};
const read = (p: string): string => (p === '/secrets/telegram.token' ? 'tok\n' : '');

test('parseSocialConfig lists every missing required key', () => {
  const r = parseSocialConfig({}, read);
  assert.equal(r.config, undefined);
  for (const k of [
    'X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET', 'X_USER_ID',
    'GEMINI_API_KEY', 'GEMINI_MODEL_WRITE', 'GEMINI_MODEL_CHECK', 'TELEGRAM_BOT_TOKEN_FILE', 'TELEGRAM_CHAT_ID', 'CHARTER_SITE_URL',
  ]) assert.ok(r.missing.includes(k), k);
});

test('parseSocialConfig parses a full env and reads the telegram token through readFile', () => {
  const r = parseSocialConfig(good, read);
  assert.deepEqual(r.missing, []);
  assert.equal(r.config?.telegram.token, 'tok');
  assert.equal(r.config?.telegram.chatId, '42');
  assert.equal(r.config?.x.userId, '123');
  assert.equal(r.config?.geminiCallsCapDay, 200);
  assert.equal(r.config?.stateDir, '/state');
  assert.equal(r.config?.configDir, '/config');
  assert.equal(r.config?.dataDir, '/data');
});

test('an unreadable or empty telegram token file is reported as missing', () => {
  const r = parseSocialConfig(good, () => { throw new Error('ENOENT'); });
  assert.equal(r.config, undefined);
  assert.ok(r.missing.includes('TELEGRAM_BOT_TOKEN_FILE'));
  assert.ok(parseSocialConfig(good, () => '  \n').missing.includes('TELEGRAM_BOT_TOKEN_FILE'));
});

test('parseSocialConfig refuses equal writer and checker models', () => {
  const r = parseSocialConfig({ ...good, GEMINI_MODEL_CHECK: 'w-model' }, read);
  assert.equal(r.config, undefined);
  assert.ok(r.missing.includes('GEMINI_MODEL_CHECK must differ from GEMINI_MODEL_WRITE'));
});

test('DRY_RUN is on unless exactly "0"', () => {
  assert.equal(parseSocialConfig(good, read).config?.dryRun, true);
  assert.equal(parseSocialConfig({ ...good, DRY_RUN: '0' }, read).config?.dryRun, false);
  assert.equal(parseSocialConfig({ ...good, DRY_RUN: ' 0 ' }, read).config?.dryRun, true);
  assert.equal(parseSocialConfig({ ...good, DRY_RUN: 'false' }, read).config?.dryRun, true);
  assert.equal(parseSocialConfig({ ...good, DRY_RUN: '' }, read).config?.dryRun, true);
});

test('SPEND_CAP_USD_DAY defaults to 2 and GEMINI_CALLS_CAP_DAY can be set', () => {
  assert.equal(parseSocialConfig(good, read).config?.spendCapUsdDay, 2);
  assert.equal(parseSocialConfig({ ...good, SPEND_CAP_USD_DAY: '0.5' }, read).config?.spendCapUsdDay, 0.5);
  assert.equal(parseSocialConfig({ ...good, GEMINI_CALLS_CAP_DAY: '50' }, read).config?.geminiCallsCapDay, 50);
});

test('a bad number is reported, not defaulted', () => {
  assert.ok(parseSocialConfig({ ...good, SPEND_CAP_USD_DAY: 'lots' }, read).missing.includes('SPEND_CAP_USD_DAY must be a positive number'));
  assert.ok(parseSocialConfig({ ...good, GEMINI_CALLS_CAP_DAY: '0' }, read).missing.includes('GEMINI_CALLS_CAP_DAY must be a positive number'));
});

test('payer lists are lowercased, comma split and trimmed', () => {
  const r = parseSocialConfig({ ...good, FIRST_PARTY_PAYERS: `${FUND.toUpperCase().replace('0X', '0x')}, ${'0x' + 'Ef'.repeat(20)} ,,`, PROBE_PAYERS: PROBE.toUpperCase().replace('0X', '0x') }, read);
  assert.deepEqual(r.missing, []);
  assert.deepEqual([...(r.config?.firstParty ?? [])], [FUND, '0x' + 'ef'.repeat(20)]);
  assert.deepEqual([...(r.config?.probes ?? [])], [PROBE]);
  assert.equal(parseSocialConfig({ ...good, PROBE_PAYERS: '' }, read).config?.probes.size, 0);
});

test('an empty FIRST_PARTY_PAYERS keeps the loops idle: own leases would read as outsiders', () => {
  for (const v of [undefined, '', ' , ,']) {
    const r = parseSocialConfig({ ...good, FIRST_PARTY_PAYERS: v }, read);
    assert.equal(r.config, undefined, String(v));
    assert.ok(r.missing.includes('FIRST_PARTY_PAYERS'), String(v));
  }
});

test('a payer entry that is not 0x and 40 hex digits is named in missing', () => {
  const r = parseSocialConfig({ ...good, FIRST_PARTY_PAYERS: `${FUND},0xabc` }, read);
  assert.equal(r.config, undefined);
  assert.ok(r.missing.includes('FIRST_PARTY_PAYERS has a bad address: 0xabc\u2026'), r.missing.join(' | '));
  const p = parseSocialConfig({ ...good, PROBE_PAYERS: `${PROBE}, ${FUND}1` }, read);
  assert.equal(p.config, undefined);
  assert.ok(p.missing.includes('PROBE_PAYERS has a bad address: 0xabab\u2026'), p.missing.join(' | '));
  assert.ok(parseSocialConfig({ ...good, PROBE_PAYERS: 'fund-wallet' }, read).missing.includes('PROBE_PAYERS has a bad address: fund-w\u2026'));
});

test('SPEND_CAP_USD_DAY below the dearest post (0.20) is refused', () => {
  const r = parseSocialConfig({ ...good, SPEND_CAP_USD_DAY: '0.19' }, read);
  assert.equal(r.config, undefined);
  assert.ok(r.missing.includes('SPEND_CAP_USD_DAY must be at least 0.2, the cost of one post with a link'), r.missing.join(' | '));
  assert.equal(parseSocialConfig({ ...good, SPEND_CAP_USD_DAY: '0.2' }, read).config?.spendCapUsdDay, 0.2);
});

test('Ruling R18: a CHARTER_SITE_URL whose host contains a default banned word is refused', () => {
  for (const url of ['https://charter.mainnet.toonprotocol.dev', 'https://TOONPROTOCOL.dev/x', 'charter.tokenhub.io', 'https://jailbreakers.example']) {
    const r = parseSocialConfig({ ...good, CHARTER_SITE_URL: url }, read);
    assert.equal(r.config, undefined, url);
    assert.ok(r.missing.some((m) => m.startsWith('CHARTER_SITE_URL host contains a banned word: ')), `${url}: ${r.missing.join(' | ')}`);
  }
  assert.ok(parseSocialConfig({ ...good, CHARTER_SITE_URL: 'https://charter.mainnet.toonprotocol.dev' }, read).missing.includes('CHARTER_SITE_URL host contains a banned word: toon'));
  // Only the host counts: a path is not a host.
  assert.deepEqual(parseSocialConfig({ ...good, CHARTER_SITE_URL: 'https://charter.example/toon' }, read).missing, []);
});

test('CHARTER_ALLOW_ADDRESS is optional, lowercased, and must be an address', () => {
  assert.equal(parseSocialConfig(good, read).config?.allowAddress, undefined);
  assert.equal(parseSocialConfig({ ...good, CHARTER_ALLOW_ADDRESS: ' 0x' + 'AB'.repeat(20) + ' ' }, read).config?.allowAddress, '0x' + 'ab'.repeat(20));
  const bad = parseSocialConfig({ ...good, CHARTER_ALLOW_ADDRESS: '0x12' }, read);
  assert.equal(bad.config, undefined);
  assert.ok(bad.missing.includes('CHARTER_ALLOW_ADDRESS must be a 0x address (40 hex characters)'));
});
