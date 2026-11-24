import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Charter's door is https://charterhome.dev. The old name lives on only in historical records and as a Caddy
// alias kept for callers that still use it; no live default, doc or served page may name it.
const OLD = 'charter.mainnet.toonprotocol.dev';
const HISTORICAL = [
  /^docs\/demo\.md$/,
  /^docs\/spike-notes\.md$/,
  /^docs\/superpowers\//,
  /^site\//,
  /^web\/privacy\.html$/,
  /^src\/social\//, // tests the toon ban on purpose
  /^deploy\/door\/Caddy\.snippet$/, // the alias itself
  /^src\/live-urls\.test\.ts$/,
];
const BINARY = /\.(woff2?|png|jpe?g|gif|ico|lock)$/;

function liveFilesContaining(needle: string): string[] {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return files
    .filter((f) => !HISTORICAL.some((re) => re.test(f)) && !BINARY.test(f))
    .filter((f) => readFileSync(new URL(f, `file://${root}`), 'utf8').includes(needle));
}

test('no live file names the old storefront', () => {
  assert.deepEqual(liveFilesContaining(OLD), []);
});

// charter.ar.io was the landing page on Arweave; it now only says Charter moved, and its redirect drops #proof.
test('no live file links the retired charter.ar.io page', () => {
  assert.deepEqual(liveFilesContaining('charter.ar.io'), []);
});

// On charterhome.dev, / is the landing page; a "Rent" link means the browser storefront.
test('Rent in the served pages\' nav goes to the storefront, not /', () => {
  for (const page of ['agents.html', 'grants.html']) {
    const html = readFileSync(new URL(`../web/${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<a href="\/">Rent<\/a>/, page);
    assert.match(html, /<a href="https:\/\/rent\.charterhome\.dev\/">Rent<\/a>/, page);
  }
});
