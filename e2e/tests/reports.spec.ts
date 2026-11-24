import { expect, test } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser } from '../support/staff';

/**
 * The owner reports page (docs/plans/owner-reports.md): finance opens Reports, sees today's report
 * with every check passed, and switches to the month and the year.
 */

test.use({ baseURL: ADMIN_URL });

test('finance opens the day, month and year reports, each checking itself', async ({ page }) => {
  await loginInBrowser(page, 'finance');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Reports' })
    .click();
  await expect(page.getByTestId('report')).toBeVisible();
  await expect(page.getByTestId('report-checks')).toContainText('All checks passed');
  for (const period of ['month', 'year'] as const) {
    await page.getByTestId(`report-period-${period}`).click();
    await expect(page.getByTestId(`report-period-${period}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('report-checks')).toContainText('All checks passed');
    await expect(page.getByTestId('report-total-ggr')).toContainText('ETB');
  }
  const download = page.waitForEvent('download');
  await page.getByTestId('report-csv').click();
  expect((await download).suggestedFilename()).toMatch(/^report-year-\d{4}-01-01\.csv$/);
});
