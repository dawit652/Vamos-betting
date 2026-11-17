import { expect, test, devices } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { randomPhone } from '../support/phone';
import { loginInBrowser } from '../support/staff';
import { balanceChip, registerAndVerify } from '../support/ui';

/**
 * The cashier desk (docs/plans/cashier-dashboard.md): a cashier opens a shift, finds a player by
 * phone, takes a cash deposit (the player's balance shows it), prints the receipt and closes the
 * shift with a count.
 */

test.use({ actionTimeout: 20_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

test('a cashier takes a cash deposit, prints the receipt and closes the shift', async ({
  page,
  browser,
}) => {
  const phone = randomPhone();
  await registerAndVerify(page, phone);

  const staff = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: ADMIN_URL });
  const desk = await staff.newPage();
  try {
    await loginInBrowser(desk, 'cashier');
    // The cashier has no dashboard: the desk is their home page.
    await desk.waitForURL(`${ADMIN_URL}/cashier`);
    await expect(desk.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText([
      'Cashier desk',
    ]);

    // A shift left open by an earlier run is closed first.
    const close = desk.getByRole('button', { name: 'Close shift' });
    if (await close.isVisible()) {
      await desk.getByLabel('Counted cash (ETB)').fill('0');
      await close.click();
      await desk.getByRole('button', { name: 'Back to the desk' }).click();
    }

    await desk.getByLabel('Opening float (ETB)').fill('500');
    await desk.getByRole('button', { name: 'Open shift' }).click();

    await desk.getByLabel('Player phone').fill(`0${phone.slice(4)}`);
    await desk.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(desk.getByText(phone)).toBeVisible();

    const receiptTab = staff.waitForEvent('page');
    await desk.getByLabel('Deposit amount (ETB)').fill('250');
    await desk.getByRole('button', { name: 'Take cash deposit' }).click();
    await expect(desk.getByText(/Receipt R\d+ — ETB 250\.00 credited/)).toBeVisible();

    // The receipt opens for printing: shop, amount, the masked phone.
    const receipt = await receiptTab;
    await expect(receipt.getByTestId('receipt')).toContainText('CASH DEPOSIT');
    await expect(receipt.getByTestId('receipt')).toContainText('ETB 250.00');
    await expect(receipt.getByTestId('receipt')).toContainText(
      `${phone.slice(0, 5)}****${phone.slice(-4)}`,
    );
    await expect(receipt.getByTestId('receipt')).not.toContainText('COPY');
    await receipt.close();

    // The player sees the money.
    await page.goto('/wallet');
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 250.00');

    // Close with the drawer as expected: 500 + 250.
    await desk.getByLabel('Counted cash (ETB)').fill('750');
    await desk.getByRole('button', { name: 'Close shift' }).click();
    await expect(desk.getByText('Shift closed.')).toBeVisible();
    await expect(desk.getByText('The count differs')).toHaveCount(0);
  } finally {
    await staff.close();
  }
});
