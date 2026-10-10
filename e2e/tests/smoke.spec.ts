import { expect, test } from '@playwright/test';
import { WEB_URL } from '../support/env';

test('home page is in Amharic by default and always shows the demo notice', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'am');
  await expect(page.getByRole('note')).toContainText('ሙከራ');
});

test('the demo notice is shown in English too', async ({ page, context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('note')).toHaveText('DEMO – play money only. No real money is used.');
});
