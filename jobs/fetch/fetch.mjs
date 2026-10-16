// Charter fetch job. Input: env URLS (comma list, at most 5), optional CHARTER_PROXY.
// Output: /out/result.json { pages: [{ url, text, jpegBase64 }] }, exit 0.
// On failure: /out/error.txt and exit 2.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const MAX_URLS = 5;
const MAX_TEXT_BYTES = 32 * 1024;
const NAV_TIMEOUT_MS = 30_000;

function fail(message) {
  return writeFile('/out/error.txt', String(message).slice(0, 4096)).finally(() => process.exit(2));
}

function truncateUtf8(s, max) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  // toString drops a trailing partial sequence as U+FFFD; strip it.
  return buf.subarray(0, max).toString('utf8').replace(/�+$/, '');
}

async function main() {
  const urls = (process.env.URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) throw new Error('URLS is empty');
  if (urls.length > MAX_URLS) throw new Error(`URLS has ${urls.length} entries, max ${MAX_URLS}`);
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) throw new Error(`not an http(s) url: ${u}`);
  }

  const proxy = process.env.CHARTER_PROXY;
  const browser = await chromium.launch({
    args: ['--disable-dev-shm-usage'],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pages = [];
    for (const url of urls) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 60 });
        const text = await page.evaluate(() => document.body?.innerText ?? '');
        pages.push({
          url,
          text: truncateUtf8(text, MAX_TEXT_BYTES),
          jpegBase64: jpeg.toString('base64'),
        });
      } finally {
        await page.close();
      }
    }
    await writeFile('/out/result.json', JSON.stringify({ pages }));
  } finally {
    await browser.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => fail(err instanceof Error ? err.message : err),
);
