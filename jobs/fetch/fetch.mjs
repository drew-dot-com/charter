// Charter fetch job. Input: env URLS (comma list, at most 5), optional CHARTER_PROXY.
// Output: /out/result.json { pages: [{ url, text, jpegBase64 }] }, exit 0.
// On failure: /out/error.txt and exit 2.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { checkUrl } from './guard.mjs';

const MAX_URLS = 5;
const MAX_TEXT_BYTES = 32 * 1024;
const NAV_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;

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
    // Service workers answer requests without entering context.route, so block them.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
    });

    // SSRF guard on every request, proxy or not. Chromium follows redirects without
    // re-entering route handlers, so the handler fetches each request itself with
    // redirects off and checks every hop before anything is fulfilled.
    // When a proxy resolves names itself, a local DNS miss is not a reason to refuse.
    const lookupFailure = proxy ? 'allow' : 'block';
    const decisions = new Map();
    const verdictFor = async (url) => {
      let key;
      try {
        const u = new URL(url);
        key = `${u.protocol}//${u.host}`;
      } catch {
        return { ok: false, host: url, reason: 'bad url' };
      }
      let verdict = decisions.get(key);
      if (!verdict) {
        verdict = await checkUrl(url, { lookupFailure });
        decisions.set(key, verdict);
      }
      return verdict;
    };

    let blockedNavigation; // host that stopped the top-level navigation
    let pendingRedirect; // next hop of a top-level redirect, followed by navigate()
    await context.route('**/*', async (route) => {
      const request = route.request();
      const isMain = request.isNavigationRequest() && request.frame().parentFrame() === null;
      let url = request.url();
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const verdict = await verdictFor(url);
        if (!verdict.ok) {
          if (isMain) blockedNavigation ??= verdict.host;
          return route.abort('blockedbyclient');
        }
        let response;
        try {
          response = await route.fetch({ url, maxRedirects: 0 });
        } catch {
          return route.abort('failed');
        }
        const location = response.headers()['location'];
        if (location && response.status() >= 300 && response.status() < 400) {
          const next = new URL(location, url).href;
          if (isMain) {
            pendingRedirect = next;
            return route.abort('aborted');
          }
          url = next;
          continue;
        }
        return route.fulfill({ response });
      }
      return route.abort('failed');
    });

    // context.route does not see WebSockets; apply the same verdict to them.
    await context.routeWebSocket('**/*', async (ws) => {
      const verdict = await verdictFor(ws.url().replace(/^ws/i, 'http'));
      if (!verdict.ok) return ws.close({ code: 1008, reason: 'blocked' });
      ws.connectToServer();
    });

    async function navigate(page, start) {
      let url = start;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        blockedNavigation = undefined;
        pendingRedirect = undefined;
        try {
          await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        } catch (err) {
          if (!blockedNavigation && !pendingRedirect) throw err;
        }
        if (blockedNavigation) throw new Error(`blocked host: ${blockedNavigation}`);
        if (!pendingRedirect) return;
        url = pendingRedirect;
      }
      throw new Error('too many redirects');
    }

    const pages = [];
    for (const url of urls) {
      const page = await context.newPage();
      try {
        await navigate(page, url);
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
