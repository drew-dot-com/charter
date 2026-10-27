// The demo path, in a browser: open the storefront, rent the first machine, run the default python
// script, and see the lease page reach Done with the script's output. Role and text locators only: the
// storefront's markup is free to change as long as the words stay.
import { test, expect } from '@playwright/test';

test('rent the first machine, run the default python script, and read "pi is about" when the lease is done', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The first machine's Rent button. Its accessible name is "Rent <size>".
  const rent = page.getByRole('button', { name: /^rent\b/i }).first();
  await expect(rent).toBeVisible();
  await rent.click();

  // A machine that runs both jobs shows a picker; the python job is the default, but say so anyway.
  const python = page.getByRole('radio', { name: /python/i });
  if ((await python.count()) > 0) await python.first().check();

  // The script box already holds the example script, which prints pi.
  const script = page.getByRole('textbox').first();
  await expect(script).toHaveValue(/pi is about/);

  await page.getByRole('button', { name: /start lease/i }).click();
  await expect(page).toHaveURL(/#\/lease\/[0-9a-f]{32}$/, { timeout: 15_000 });

  // Three 12 s intervals on the dev door, then the output is fetched and the script run: well inside a minute.
  await expect(page.getByText('Done', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/pi is about/)).toBeVisible({ timeout: 30_000 });
});
