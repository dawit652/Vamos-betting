import { randomInt } from 'node:crypto';
import { expect, test, devices, type Page } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { assignDemoCashierToHq, loginApi, loginInBrowser } from '../support/staff';
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
  playwright,
}) => {
  const phone = randomPhone();
  await registerAndVerify(page, phone);
  // Other specs add shops: the demo cashier works at the HQ shop.
  const adminRequest = await playwright.request.newContext();
  await assignDemoCashierToHq(await loginApi(adminRequest, 'admin'));
  await adminRequest.dispose();

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

/** A 12-digit Fayda FIN the mock registry verifies (not ending 0000 = unknown, 9999 = review). */
function verifiableFayda(): string {
  for (;;) {
    const fin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    if (!fin.endsWith('0000') && !fin.endsWith('9999')) return fin;
  }
}

/** Closes a shift an earlier run left open, then opens one with `float` ETB. */
async function openShift(desk: Page, float: string): Promise<void> {
  const close = desk.getByRole('button', { name: 'Close shift' });
  if (await close.isVisible()) {
    await desk.getByLabel('Counted cash (ETB)').fill('0');
    await close.click();
    await desk.getByRole('button', { name: 'Back to the desk' }).click();
  }
  await desk.getByLabel('Opening float (ETB)').fill(float);
  await desk.getByRole('button', { name: 'Open shift' }).click();
}

test('a verified player gets a shop code on the phone and the cashier pays cash with it', async ({
  page,
  browser,
  playwright,
}) => {
  const phone = randomPhone();
  await registerAndVerify(page, phone);
  await page.goto('/account/kyc');
  const fin = verifiableFayda();
  await page.locator('#kyc-id').fill(fin);
  await page.locator('#kyc-name').fill('Abebe Kebede');
  await page.locator('#kyc-dob').fill(ADULT_DATE_OF_BIRTH);
  await page.getByRole('button', { name: 'Submit for verification' }).click();
  await expect(
    page.getByText(`Your identity is verified (ID ending in ${fin.slice(-4)}).`),
  ).toBeVisible();

  // The money comes from a cash deposit; its wagering rule is turned off for this test.
  const adminRequest = await playwright.request.newContext();
  const admin = await loginApi(adminRequest, 'admin');
  await assignDemoCashierToHq(admin);
  const before = (
    (await (await admin.get('/admin/settings')).json()) as {
      settings: { payments: Record<string, unknown> };
    }
  ).settings.payments;
  const set = await admin.put('/admin/settings/payments', {
    value: { ...before, wageringMultiplierBps: 0 },
  });
  expect(set.ok()).toBe(true);

  const staff = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: ADMIN_URL });
  const desk = await staff.newPage();
  try {
    await loginInBrowser(desk, 'cashier');
    await desk.waitForURL(`${ADMIN_URL}/cashier`);
    await openShift(desk, '500');
    await desk.getByLabel('Player phone').fill(phone);
    await desk.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(desk.getByText(phone)).toBeVisible();
    const depositTab = staff.waitForEvent('page');
    await desk.getByLabel('Deposit amount (ETB)').fill('300');
    await desk.getByRole('button', { name: 'Take cash deposit' }).click();
    await expect(desk.getByText(/ETB 300\.00 credited/)).toBeVisible();
    await (await depositTab).close();

    // The player makes a shop code on their phone.
    await page.goto('/wallet/withdraw');
    await page.getByRole('button', { name: 'Get a shop code' }).click();
    const shown = page.getByTestId('shop-code');
    await expect(shown).toHaveText(/^\d{3} \d{3}$/);
    const code = ((await shown.textContent()) ?? '').replace(/\s/g, '');

    // The cashier pays ETB 100 with it; the receipt has the signature line.
    const receiptTab = staff.waitForEvent('page');
    await desk.getByLabel('Withdrawal amount (ETB)').fill('100');
    await desk.getByLabel("Player's shop code").fill(code);
    await desk.getByRole('button', { name: 'Pay cash withdrawal' }).click();
    await expect(desk.getByText(/Pay ETB 100\.00 to the player\. Receipt R\d+/)).toBeVisible();
    const receipt = await receiptTab;
    await expect(receipt.getByTestId('receipt')).toContainText('CASH WITHDRAWAL');
    await expect(receipt.getByTestId('receipt')).toContainText('Player signature');
    await receipt.close();

    await page.goto('/wallet');
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 200.00');

    // The drawer: 500 + 300 − 100.
    await desk.getByLabel('Counted cash (ETB)').fill('700');
    await desk.getByRole('button', { name: 'Close shift' }).click();
    await expect(desk.getByText('Shift closed.')).toBeVisible();
    await expect(desk.getByText('The count differs')).toHaveCount(0);
  } finally {
    await staff.close();
    await admin.put('/admin/settings/payments', { value: before });
    await adminRequest.dispose();
  }
});
