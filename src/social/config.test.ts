import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSocialConfig } from './config.js';

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
  const r = parseSocialConfig({ ...good, FIRST_PARTY_PAYERS: '0xABC, 0xDef ,,', PROBE_PAYERS: '0xAA' }, read);
  assert.deepEqual([...(r.config?.firstParty ?? [])], ['0xabc', '0xdef']);
  assert.deepEqual([...(r.config?.probes ?? [])], ['0xaa']);
  assert.equal(parseSocialConfig(good, read).config?.firstParty.size, 0);
});
