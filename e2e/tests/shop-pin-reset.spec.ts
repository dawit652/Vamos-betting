import { randomInt } from 'node:crypto';
import { devices, expect, test, type Page } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { assignDemoCashierToHq, loginApi, loginInBrowser } from '../support/staff';
import { registerAndVerify } from '../support/ui';

/**
 * Forgot PIN at a shop (docs/plans/cashier-dashboard.md, "Assisted PIN reset"; the e2e stack runs
 * with CASHIER_PIN_RESET=on): the player's phone shows a desk code, the cashier types it with the
 * Fayda ID number, an admin approves on the Cash shifts page, and only the player's phone sets the
 * new PIN. The player then logs in with it.
 */

test.use({ actionTimeout: 20_000 });

const NEW_PIN = '5739';

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
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

test("a player without SMS resets the PIN at a shop; only the player's phone sets it", async ({
  page,
  browser,
  playwright,
}) => {
  // The new PIN may not be four digits in a row of the phone number.
  let phone = randomPhone();
  while (phone.includes(NEW_PIN)) phone = randomPhone();
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

  // The player's phone, signed out: Forgot PIN, Reset at a shop.
  const handsetContext = await browser.newContext({ ...devices['Pixel 5'], baseURL: WEB_URL });
  await handsetContext.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
  const staff = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: ADMIN_URL });
  const office = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: ADMIN_URL });
  const handset = await handsetContext.newPage();
  const desk = await staff.newPage();
  const supervisor = await office.newPage();
  // The demo cashier works at the HQ shop (other specs add shops).
  const adminRequest = await playwright.request.newContext();
  await assignDemoCashierToHq(await loginApi(adminRequest, 'admin'));
  await adminRequest.dispose();
  let shiftOpen = false;
  try {
    await handset.goto('/forgot-password');
    await handset.getByRole('link', { name: 'Reset at a shop' }).click();
    await handset.waitForURL('**/reset-at-shop');
    const phoneInput = handset.getByLabel('Phone number');
    const shownCode = handset.getByTestId('shop-reset-code');
    // Typing before the page settled can be lost: type and ask again until the code shows.
    await expect(async () => {
      if ((await shownCode.count()) === 0) {
        await phoneInput.fill(`0${phone.slice(4)}`);
        await handset.getByRole('button', { name: 'Get a desk code' }).click();
      }
      await expect(shownCode).toHaveText(/^\d{4} \d{4}$/, { timeout: 3000 });
    }).toPass({ timeout: 30_000 });
    const deskCode = ((await shownCode.textContent()) ?? '').replace(/\s/g, '');
    await expect(handset.getByTestId('shop-reset-state')).toContainText('Waiting for the cashier');

    // The cashier finds the player and types the desk code with the ID number.
    await loginInBrowser(desk, 'cashier');
    await desk.waitForURL(`${ADMIN_URL}/cashier`);
    await openShift(desk, '500');
    shiftOpen = true;
    await desk.getByLabel('Player phone').fill(phone);
    await desk.getByRole('button', { name: 'Find', exact: true }).click();
    const card = desk.getByTestId('cashier-pin-reset');
    const ask = async (code: string, idNumber: string) => {
      await card.getByLabel("Desk code on the player's phone").fill(code);
      await card.getByLabel('ID number on the card').fill(idNumber);
      await card.getByRole('button', { name: 'Ask a PIN reset' }).click();
    };
    // A wrong ID number gets the same answer as a wrong desk code.
    const wrongFin = fin.endsWith('1') ? `${fin.slice(0, -1)}2` : `${fin.slice(0, -1)}1`;
    await ask(deskCode, wrongFin);
    await expect(card).toContainText("does not match this player's verified ID");
    await ask(deskCode, fin);
    await expect(card.getByTestId('cashier-pin-reset-state')).toContainText(
      'Waiting for a supervisor',
    );
    await expect(handset.getByTestId('shop-reset-state')).toContainText(
      'Waiting for a supervisor to approve',
      { timeout: 20_000 },
    );

    // An admin approves on the Cash shifts page (four eyes: not the cashier).
    await loginInBrowser(supervisor, 'admin');
    await supervisor.goto('/cashier/shifts');
    const row = supervisor
      .getByTestId('pin-resets-waiting')
      .getByRole('row')
      .filter({ hasText: phone });
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(row).toHaveCount(0);

    // The desk has nothing to hand over; the phone sets the new PIN itself.
    await card.getByRole('button', { name: 'Check again' }).click();
    await expect(card.getByTestId('cashier-pin-reset-state')).toContainText(
      'There is nothing to hand over',
    );
    await expect(handset.getByTestId('shop-reset-state')).toContainText('Approved', {
      timeout: 20_000,
    });
    await handset.getByLabel('New 4-digit PIN').fill(NEW_PIN);
    await handset.getByLabel('Repeat the new PIN').fill(NEW_PIN);
    await handset.getByRole('button', { name: 'Set new PIN' }).click();
    await expect(handset.getByTestId('shop-reset-state')).toContainText('Your PIN was changed');

    // The player logs in with the new PIN.
    await handset.getByTestId('shop-reset').getByRole('link', { name: 'Log in' }).click();
    await handset.locator('#login-phone').fill(`0${phone.slice(4)}`);
    await handset.locator('#login-password').fill(NEW_PIN);
    await handset.getByRole('button', { name: 'Log in', exact: true }).click();
    await expect(handset).not.toHaveURL(/\/login/, { timeout: 15_000 });
  } finally {
    if (shiftOpen) {
      try {
        await desk.getByLabel('Counted cash (ETB)').fill('500');
        await desk.getByRole('button', { name: 'Close shift' }).click();
      } catch {
        // The test already failed; the next run's openShift closes it.
      }
    }
    await handsetContext.close();
    await staff.close();
    await office.close();
  }
});
