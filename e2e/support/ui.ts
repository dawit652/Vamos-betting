import { expect, type Locator, type Page } from '@playwright/test';
import { readOtp } from './otp';

/**
 * UI steps shared by the specs. English UI is assumed (each spec sets the
 * `vamos_locale=en` cookie in a beforeEach).
 */

export const PASSWORD = 'e2e-secret-123';

/** The balance chip in the header ("Balance: ETB 1,000.00"). */
export function balanceChip(page: Page): Locator {
  return page.getByRole('banner').getByRole('link', { name: /^Balance: ETB / });
}

/**
 * Clicks until the odds button reports it is on the slip. The first click can
 * land before React hydrates the button, so it is retried; a click that did
 * register is never repeated (that would take the pick off again).
 */
export async function pick(button: Locator): Promise<void> {
  await expect(async () => {
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Registers a new player (phone, password, the 21+ and terms checkbox: the form
 * asks no date of birth) and verifies the phone with the OTP read from the dev
 * SMS inbox, then waits for the wallet with its welcome note.
 */
export async function registerAndVerify(page: Page, phone: string): Promise<void> {
  await page.goto('/register');
  await page.locator('#reg-phone').fill(phone);
  await page.locator('#reg-password').fill(PASSWORD);
  await page.locator('input[name="acceptTerms"]').check();
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  await page.waitForURL('**/verify');
  const code = await readOtp(page.request, phone);
  await page.locator('#otp-code').fill(code);
  await page.getByRole('button', { name: 'Verify', exact: true }).click();

  // A new player lands on the wallet with a welcome note.
  await page.waitForURL(/\/wallet\?welcome=1$/);
  await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 0.00');
}
