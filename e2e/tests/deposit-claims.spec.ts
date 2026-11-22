import { expect, test } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { randomPhone } from '../support/phone';
import { loginInBrowser } from '../support/staff';
import { registerAndVerify } from '../support/ui';

/**
 * "My deposit did not arrive" and the back office's "Money not credited"
 * (docs/plans/counter-codes-and-deposit-recovery.md, G5.3 and G6): a player reports a payment,
 * finance finds the claim and closes it with a note, and the player sees the answer.
 */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

test('a player reports a deposit that did not arrive; finance closes the claim', async ({
  page,
  browser,
}) => {
  await registerAndVerify(page, randomPhone());
  await page.goto('/wallet/deposit');
  await page.getByTestId('deposit-claim-toggle').click();
  await page.getByTestId('deposit-claim-method').selectOption('cbe');
  await page.getByTestId('deposit-claim-amount').fill('250');
  const reference = `FT${Date.now().toString(36).toUpperCase()}`;
  await page.getByTestId('deposit-claim-reference').fill(reference);
  await page.getByTestId('deposit-claim-submit').click();
  await expect(page.getByTestId('deposit-claim-sent')).toBeVisible();
  await expect(page.getByTestId('deposit-claim-status').first()).toHaveText('Being checked');

  const admin = await browser.newPage({ baseURL: ADMIN_URL });
  await loginInBrowser(admin, 'finance');
  await admin
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Money not credited' })
    .click();
  await expect(admin.getByTestId('money-page')).toContainText(
    'Nothing here is credited automatically',
  );
  const claim = admin.getByTestId('money-claim').filter({ hasText: reference });
  await expect(claim).toContainText('ETB 250.00');
  await claim.getByRole('button', { name: 'Close', exact: true }).click();
  await claim.getByRole('textbox').fill('No such payment on the CBE statement');
  await claim.getByRole('button', { name: 'Close the claim' }).click();
  await expect(admin.getByTestId('money-claim').filter({ hasText: reference })).toHaveCount(0);

  await page.reload();
  await page.getByTestId('deposit-claim-toggle').waitFor();
  await expect(page.getByTestId('deposit-claim-status').first()).toHaveText('Closed: not found');
});
