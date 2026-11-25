import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The landing page is served by the door under the door's CSP (style-src, font-src and script-src 'self'),
// so it must carry no inline style, no script and no data: fonts.
const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = read('./home.html');
const css = read('./home.css');

test('home page passes the door CSP: no inline style, script or data fonts', () => {
  assert.doesNotMatch(html, /<style|style=|<script|data:font/i);
  assert.match(html, /<link rel="stylesheet" href="home\.css">/);
  assert.doesNotMatch(css, /data:/);
  assert.match(css, /url\("fonts\/ibm-plex-[a-z-]+-\d00-normal\.woff2"\)/);
});

test('home page links only the charterhome.dev names', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/charterhome\.dev\/">/);
  assert.match(html, /property="og:url" content="https:\/\/charterhome\.dev\/"/);
  assert.match(html, /href="https:\/\/charterhome\.dev\/agents"/);
  assert.match(html, /href="https:\/\/rent\.charterhome\.dev\/"/);
  assert.doesNotMatch(html, /toonprotocol\.dev|ar\.io|ArNS|file on Arweave/i);
});

test('home page names Drew neutrally, linked to X', () => {
  assert.match(html, /<a href="https:\/\/x\.com\/mil_itia">Drew Pierson<\/a>/);
  assert.doesNotMatch(html, /COO|cofounder|linkedin/i);
});

test('home page has no em dash', () => {
  assert.doesNotMatch(html + css, /—/);
});
