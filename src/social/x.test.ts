import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oauth1Header, XClient, XError, costOf, X_PRICE_USD } from './x.js';

const keys = { consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessSecret: 'as', userId: '42' };

function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('oauth1Header matches X documented example', () => {
  const h = oauth1Header(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json',
    { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      userId: '1',
    },
    'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    1318622958,
  );
  assert.ok(h.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'), h);
});

test('post sends text and reply id and returns the new id', async () => {
  const { fn, calls } = fake(201, { data: { id: '99', text: 'hi' } });
  const id = await new XClient(keys, fn).post('hi', '7');
  assert.equal(id, '99');
  assert.equal(calls[0].url, 'https://api.x.com/2/tweets');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { text: 'hi', reply: { in_reply_to_tweet_id: '7' } });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.Authorization, /^OAuth /);
});

test('post without replyTo omits reply', async () => {
  const { fn, calls } = fake(201, { data: { id: '1' } });
  await new XClient(keys, fn).post('hi');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { text: 'hi' });
});

test('delete calls DELETE on the tweet', async () => {
  const { fn, calls } = fake(200, { data: { deleted: true } });
  await new XClient(keys, fn).delete('55');
  assert.equal(calls[0].url, 'https://api.x.com/2/tweets/55');
  assert.equal(calls[0].init.method, 'DELETE');
});

const mentionsBody = {
  data: [{ id: '10', text: '@c hello', author_id: 'a1', conversation_id: '9', created_at: '2026-11-24T10:00:00.000Z' }],
  includes: { users: [{ id: 'a1', username: 'alice' }] },
  meta: { newest_id: '10', result_count: 1 },
};

test('mentions maps author handle from includes.users and passes since_id', async () => {
  const { fn, calls } = fake(200, mentionsBody);
  const r = await new XClient(keys, fn).mentions('5');
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/2/users/42/mentions');
  assert.equal(u.searchParams.get('since_id'), '5');
  assert.equal(u.searchParams.get('max_results'), '100');
  assert.equal(u.searchParams.get('expansions'), 'author_id');
  assert.equal(u.searchParams.get('user.fields'), 'username');
  assert.equal(u.searchParams.get('tweet.fields'), 'conversation_id,created_at,author_id');
  assert.deepEqual(r.mentions[0], {
    id: '10', text: '@c hello', authorId: 'a1', authorHandle: 'alice', conversationId: '9',
    createdAt: Date.parse('2026-11-24T10:00:00.000Z'),
  });
});

test('mentions returns newestId from meta.newest_id, and empty is fine', async () => {
  const a = await new XClient(keys, fake(200, mentionsBody).fn).mentions();
  assert.equal(a.newestId, '10');
  const b = await new XClient(keys, fake(200, { meta: { result_count: 0 } }).fn).mentions();
  assert.deepEqual(b, { mentions: [], newestId: undefined });
});

test('a non-2xx answer throws XError with the status and no secrets', async () => {
  const { fn } = fake(429, { title: 'Too Many Requests' });
  await assert.rejects(new XClient(keys, fn).post('x'), (e: unknown) => {
    assert.ok(e instanceof XError);
    assert.equal(e.status, 429);
    assert.ok(!e.message.includes('OAuth'));
    assert.ok(!e.message.includes('oauth_signature'));
    return true;
  });
});

test('costOf counts a URL post at postWithUrl', () => {
  assert.equal(costOf('post', { hasUrl: true }), X_PRICE_USD.postWithUrl);
  assert.equal(costOf('post', {}), X_PRICE_USD.post);
  assert.equal(costOf('read', { count: 3 }), 3 * X_PRICE_USD.readPost);
});
