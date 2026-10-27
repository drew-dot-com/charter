// The browser smoke test of the demo path (e2e/). It starts the dev door (no payments, a fake host, the
// real python job wrapper on the local python3, which needs NumPy) and drives the storefront in Chromium.
//   npm run test:e2e
// E2E_PORT picks the door's port (default 8799, so a dev door on 8787 can keep running).
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8799);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx scripts/dev-door.ts',
    url: `http://127.0.0.1:${port}/v1/dev`,
    env: { DEV_DOOR_PORT: String(port), DEV_INTERVAL_SECONDS: '12' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
