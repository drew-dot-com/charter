import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiModel, GeminiCapError, type GeminiLike } from './model.js';

function fakeClient(res: unknown): GeminiLike & { calls: Array<{ model: string; contents: string; config: Record<string, unknown> }> } {
  const calls: Array<{ model: string; contents: string; config: Record<string, unknown> }> = [];
  return {
    calls,
    models: {
      generateContent: async (params) => {
        calls.push(params);
        return res;
      },
    },
  };
}

const ok = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking', thought: true }, { text }] } }],
  ...extra,
});

test('geminiModel throws GeminiCapError without a network call when allowCall() is false', async () => {
  const client = fakeClient(ok('{"a":1}'));
  const m = geminiModel('key', () => false, client);
  await assert.rejects(m.json('gemini-x', 'hello'), GeminiCapError);
  assert.equal(client.calls.length, 0);
  // Without an injected client too: the cap is checked before any client is built or called.
  await assert.rejects(geminiModel('key', () => false).json('gemini-x', 'hello'), GeminiCapError);
});

test('geminiModel asks allowCall once per call', async () => {
  let n = 0;
  const client = fakeClient(ok('{"a":1}'));
  const m = geminiModel('key', () => ++n <= 1, client);
  assert.deepEqual(await m.json('gemini-x', 'one'), { a: 1 });
  await assert.rejects(m.json('gemini-x', 'two'), GeminiCapError);
  assert.equal(client.calls.length, 1);
  assert.equal(n, 2);
});

test('geminiModel sends the model, prompt, system instruction and JSON mime type, and joins non-thought text', async () => {
  const client = fakeClient({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x', thought: true }, { text: '{"b":' }, { text: '2}' }] } }] });
  const m = geminiModel('key', () => true, client);
  assert.deepEqual(await m.json('gemini-w', 'the prompt', 'the system'), { b: 2 });
  const c = client.calls[0]!;
  assert.equal(c.model, 'gemini-w');
  assert.equal(c.contents, 'the prompt');
  assert.equal(c.config.responseMimeType, 'application/json');
  assert.equal(c.config.systemInstruction, 'the system');
});

test('geminiModel leaves systemInstruction out when none is given', async () => {
  const client = fakeClient(ok('{}'));
  await geminiModel('key', () => true, client).json('gemini-w', 'p');
  assert.equal('systemInstruction' in client.calls[0]!.config, false);
});

test('geminiModel fails on a blocked prompt, a non-STOP finish, no text, or bad JSON', async () => {
  const cases: unknown[] = [
    ok('{}', { promptFeedback: { blockReason: 'SAFETY' } }),
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    { candidates: [{ content: { parts: [{ text: '{}' }] } }] },
    { candidates: [] },
    {},
    ok(''),
    ok('not json'),
  ];
  for (const res of cases) {
    const m = geminiModel('key', () => true, fakeClient(res));
    await assert.rejects(m.json('gemini-w', 'p'), (e: unknown) => e instanceof Error && !(e instanceof GeminiCapError), JSON.stringify(res));
  }
});

test('geminiModel passes an API error through', async () => {
  const client: GeminiLike = { models: { generateContent: async () => { throw new Error('boom'); } } };
  await assert.rejects(geminiModel('key', () => true, client).json('gemini-w', 'p'), /boom/);
});
