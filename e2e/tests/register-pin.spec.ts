import { expect, test } from '@playwright/test';
import { WEB_URL } from '../support/env';
import { randomPhone } from '../support/phone';
import { PASSWORD } from '../support/ui';

/** The 4-digit PIN on the registration form: refused in the browser, a good one goes through. */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

test('registration refuses an easy or malformed PIN before submitting, accepts a good one', async ({
  page,
}) => {
  const submitted: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/auth/register')) {
      submitted.push(request.url());
    }
  });

  await page.goto('/register');
  await page.locator('#reg-phone').fill(randomPhone());
  const register = page.getByRole('button', { name: 'Register', exact: true });
  const pinError = page.locator('#reg-password-error');

  await page.locator('#reg-password').fill('1234');
  await register.click();
  await expect(pinError).toContainText('digits in a row (like 1234 or 9876) is too easy to guess');
  // No tick box: tapping Register confirms 21+ and the terms (the sentence above the button).
  await expect(page.locator('input[name="acceptTerms"]')).toHaveCount(0);

  for (const bad of ['12a4', '123']) {
    await page.locator('#reg-password').fill(bad);
    await register.click();
    await expect(pinError).toHaveText('The PIN must be exactly 4 digits.');
  }
  expect(submitted).toEqual([]);

  await page.locator('#reg-password').fill(PASSWORD);
  await register.click();
  await page.waitForURL('**/verify');
  expect(submitted.length).toBeGreaterThan(0);
});
