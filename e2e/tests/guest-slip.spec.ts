import { expect, test, type Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../support/env';
import { pick } from '../support/ui';

/**
 * A visitor's slip ID (docs/plans/guest-slips-and-staff.md, GS3): without an account, Place bet
 * gives a 6-digit slip ID to pay in cash at any shop, and the slip keeps the stake chosen.
 */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

function firstOpenOdds(page: Page) {
  return page.locator('main button.odds-btn:not([disabled])').first();
}

test('a visitor places a bet and gets a slip ID that keeps the stake', async ({ page }) => {
  await page.goto('/');
  await pick(firstOpenOdds(page));
  await page.locator('button.slip-bar').click();
  const slip = page.getByRole('dialog', { name: 'Betslip' });
  await slip
    .getByRole('group', { name: 'Quick stakes' })
    .getByRole('button', { name: '50', exact: true })
    .click();

  const place = slip.getByTestId('guest-place');
  await expect(place).toHaveText(/Place bet · pay at a shop · ETB 50/);
  // Enabled once the quote for this slip is in.
  await expect(place).toBeEnabled({ timeout: 15_000 });
  await place.click();

  const card = slip.getByTestId('guest-slip');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('Awaiting cash payment');
  const shown = (await card.getByTestId('guest-slip-id').textContent()) ?? '';
  const code = shown.replace(/\s/g, '');
  expect(code).toMatch(/^\d{6}$/);

  // The slip ID keeps the stake: 50 ETB is 5,000 santim.
  const res = await page.request.get(`${API_URL}/booking-codes/${code}`);
  expect(res.ok()).toBe(true);
  expect(((await res.json()) as { stake: string | null }).stake).toBe('5000');

  // A new slip starts empty.
  await card.getByRole('button', { name: 'New slip' }).click();
  await expect(page.locator('button.slip-bar')).toBeHidden();
});
