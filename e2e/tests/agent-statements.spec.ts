import { devices, expect, test } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser } from '../support/staff';

/**
 * Agent shops, phase 5 (docs/plans/agent-shops.md): the back office Statements, Shop monitor and
 * Shop alerts pages render. They accept empty tables, so the spec does not depend on other specs'
 * data or on a worker run.
 */

test.use({ actionTimeout: 20_000 });

test('an admin opens the statements, the monitor and the alerts', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
  const page = await context.newPage();
  try {
    await loginInBrowser(page, 'admin');
    const nav = page.getByRole('navigation', { name: 'Main' });

    await nav.getByRole('link', { name: 'Statements' }).click();
    await expect(page.getByTestId('statements-page')).toBeVisible();
    await expect(page.getByTestId('statements-week')).toBeVisible();
    await expect(page.getByTestId('statements-csv')).toBeVisible();
    // A fresh week may have no rows: the table still renders.
    await expect(page.getByRole('table')).toBeVisible();

    await nav.getByRole('link', { name: 'Shop monitor' }).click();
    await expect(page.getByTestId('monitor-page')).toBeVisible();
    await expect(page.getByTestId('monitor-updated')).toContainText(/Last updated \d/);
    await expect(page.getByTestId('monitor-agent-row').first()).toBeVisible();

    await nav.getByRole('link', { name: 'Shop alerts' }).click();
    await expect(page.getByTestId('alerts-page')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    const toggle = page.getByTestId('alerts-open-toggle');
    await expect(toggle).toContainText('Showing open');
    await toggle.click();
    await expect(toggle).toContainText('Showing all');
    await expect(page.getByRole('table')).toBeVisible();
  } finally {
    await context.close();
  }
});
