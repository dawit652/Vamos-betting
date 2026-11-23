import { expect, test, type Locator, type Page } from '@playwright/test';
import { API_URL, WEB_URL } from '../support/env';
import { pick } from '../support/ui';

/**
 * A visitor's slip ID (docs/plans/guest-slips-and-staff.md, GS3): without an account, Place bet
 * gives a 6-digit slip ID to pay in cash at any shop, and the slip keeps the stake chosen. Check
 * coupon (GS4) at the top of the betslip shows what became of it.
 */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

function firstOpenOdds(page: Page) {
  return page.locator('main button.odds-btn:not([disabled])').first();
}

/** Picks the first open odds, stakes ETB 50 and places as a visitor: the slip and its slip ID. */
async function placeGuestSlip(page: Page): Promise<{ slip: Locator; code: string }> {
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
  return { slip, code };
}

test('a visitor places a bet and gets a slip ID that keeps the stake', async ({ page }) => {
  const { slip, code } = await placeGuestSlip(page);

  // The slip ID keeps the stake: 50 ETB is 5,000 santim.
  const res = await page.request.get(`${API_URL}/booking-codes/${code}`);
  expect(res.ok()).toBe(true);
  expect(((await res.json()) as { stake: string | null }).stake).toBe('5000');

  // A new slip starts empty.
  await slip.getByTestId('guest-slip').getByRole('button', { name: 'New slip' }).click();
  await expect(page.locator('button.slip-bar')).toBeHidden();
});

test('Check coupon at the top of the betslip shows the slip ID awaiting payment', async ({
  page,
}) => {
  const { slip, code } = await placeGuestSlip(page);

  await slip.getByTestId('check-coupon').click();
  await slip.getByTestId('check-coupon-number').fill(`${code.slice(0, 3)} ${code.slice(3)}`);
  await slip.getByRole('button', { name: 'Check', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/ticket\\?number=${code}$`));
  const result = page.getByTestId('ticket-check-result');
  await expect(result).toContainText(`Slip ID ${code.slice(0, 3)} ${code.slice(3)}`);
  await expect(page.getByTestId('ticket-check-state')).toContainText('Awaiting cash payment');
  await expect(result).toContainText('Stake ETB 50');

  // An unknown number says so.
  await page.getByTestId('ticket-check-number').fill('ZZZZZZ');
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(page.getByTestId('ticket-check-error')).toContainText('No slip or shop ticket');
});
