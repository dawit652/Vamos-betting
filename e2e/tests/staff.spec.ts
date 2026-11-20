import { randomBytes } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser, staffApiOf } from '../support/staff';

/**
 * The back office Staff screen (demo mode): the admin adds a support account with a generated
 * password, sees the one-time credentials, and disables and enables the account again. A support
 * user does not see the screen and the API refuses the list.
 */

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

async function staffContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
}

test('an admin adds a staff account, then disables and enables it', async ({ browser }) => {
  const staff = await staffContext(browser);
  const page = await staff.newPage();
  const suffix = randomBytes(4).toString('hex');
  const email = `e2e-staff-${suffix}@demo.vamos.test`;
  const name = `E2E Staff ${suffix}`;
  try {
    await loginInBrowser(page, 'admin');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'Staff' }).click();
    await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();

    const form = page.getByRole('form', { name: 'Add a staff account' });
    await form.getByLabel('Email').fill(email);
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Role').selectOption('support');
    await form.getByRole('button', { name: 'Add account' }).click();

    const secret = page.getByTestId('staff-secret');
    await expect(secret.getByText('They are shown only once.')).toBeVisible();
    await expect(page.getByTestId('staff-generated-password')).not.toBeEmpty();
    await expect(page.getByTestId('staff-totp-secret')).toHaveText(
      /^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/,
    );
    await expect(page.getByTestId('staff-totp-uri')).toContainText('otpauth://');
    await secret.getByRole('button', { name: 'Done' }).click();
    await expect(secret).toHaveCount(0);

    await page.getByLabel('Search name or email').fill(email);
    const row = page.getByRole('row', { name: new RegExp(email) });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name }).click();

    await expect(page.getByRole('heading', { name })).toBeVisible();
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Disable account' }).click();
    await expect(page.getByText(/^Disabled /)).toBeVisible();
    await page.getByRole('button', { name: 'Enable account' }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disable account' })).toBeVisible();
  } finally {
    await staff.close();
  }
});

test('a support user does not see Staff and the API refuses the list (403)', async ({
  browser,
}) => {
  const staff = await staffContext(browser);
  const page = await staff.newPage();
  try {
    await loginInBrowser(page, 'support');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Players' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Staff' })).toHaveCount(0);
    await page.goto(`${ADMIN_URL}/staff`);
    await expect(page.getByText('Your role does not have access to this page.')).toBeVisible();
    const api = await staffApiOf(staff.request);
    expect((await api.get('/admin/staff')).status()).toBe(403);
  } finally {
    await staff.close();
  }
});
