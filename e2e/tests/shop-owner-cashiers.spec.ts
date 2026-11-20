import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser, nextTotpCode } from '../support/staff';

/**
 * An agent owner adds a cashier to their shop on the owner page, blocks and unblocks the
 * account (a confirm each time). The cashier's own sign-in needs a device an admin approves and is
 * covered by the cashier specs.
 */

const SHOP_URL = (
  process.env.E2E_SHOP_URL ??
  process.env.SHOP_URL ??
  'http://localhost:3002'
).replace(/\/$/, '');

test.use({ actionTimeout: 20_000 });

const phoneDigits = () => `09${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

async function newContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL });
}

test('an owner adds a cashier, blocks and unblocks it', async ({ browser }) => {
  const staff = await newContext(browser, ADMIN_URL);
  const office = await newContext(browser, SHOP_URL);
  const admin = await staff.newPage();
  const shop = await office.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Owner Cashiers ${suffix}`;
  const ownerEmail = `e2e-owner-c-${suffix}@demo.vamos.test`;
  const ownPassword = `Own-${suffix}-owner-pw!`;
  const cashierName = `E2E Added ${suffix}`;
  try {
    await loginInBrowser(admin, 'admin');
    await admin
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    const add = admin.getByRole('form', { name: 'Add an agent' });
    await add.getByLabel('Agent name').fill(agentName);
    await add.getByLabel("Owner's full name").fill('E2E Agent Owner');
    await add.getByLabel("Owner's phone").fill(phoneDigits());
    await add.getByLabel('Commission based on').selectOption('ggr');
    await add.getByLabel('Commission percent').fill('10');
    await add.getByRole('button', { name: 'Add agent' }).click();
    await expect(
      admin.getByRole('heading', { name: new RegExp(`^Agent \\d+ – ${agentName}$`) }),
    ).toBeVisible();

    const shopForm = admin.getByRole('form', { name: 'Add a shop' });
    await shopForm.getByLabel('Shop name').fill('E2E Owner Shop');
    await shopForm.getByLabel('Address').fill('Bole, Addis Ababa');
    await shopForm.getByRole('button', { name: 'Add shop' }).click();
    await expect(admin.getByRole('button', { name: 'Close shop' })).toBeVisible();

    // The owner's account: the password and the authenticator secret are shown once.
    const make = admin.getByRole('form', { name: "Make the owner's account" });
    await make.getByLabel("Owner's email").fill(ownerEmail);
    await make.getByRole('button', { name: 'Make account' }).click();
    const secretPanel = admin.getByTestId('staff-secret');
    const givenPassword = (
      (await secretPanel.getByTestId('staff-generated-password').textContent()) ?? ''
    ).trim();
    const totpSecret = (
      (await secretPanel.getByTestId('staff-totp-secret').textContent()) ?? ''
    ).replace(/\s/g, '');
    expect(givenPassword.length).toBeGreaterThanOrEqual(12);
    expect(totpSecret).toMatch(/^[A-Z2-7]+$/);
    await secretPanel.getByRole('button', { name: 'Done' }).click();
    await expect(admin.getByText('Must change the generated password')).toBeVisible();

    // The owner signs in to the shop app: password and authenticator code, no device.
    await shop.goto('/login');
    const email = shop.getByLabel('Email');
    await expect(async () => {
      await email.fill(ownerEmail);
      await expect(email).toHaveValue(ownerEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password', { exact: false }).first().fill(givenPassword);
    await shop
      .getByLabel(/^Authenticator code \(agent owners only\)/)
      .fill(await nextTotpCode(ownerEmail, totpSecret));
    await shop.getByRole('button', { name: /^Sign in/ }).click();

    // The generated password first, confirmed with a fresh code.
    await expect(shop).toHaveURL(`${SHOP_URL}/password`);
    await shop.getByLabel('Current password').fill(givenPassword);
    await shop.getByLabel(/^New password ·/).fill(ownPassword);
    await shop.getByLabel('New password again').fill(ownPassword);
    await shop.getByLabel(/^Authenticator code ·/).fill(await nextTotpCode(ownerEmail, totpSecret));
    await shop.getByRole('button', { name: /^Save password/ }).click();

    await expect(shop).toHaveURL(`${SHOP_URL}/owner`);

    // Add a cashier to the shop.
    const form = shop.getByTestId('owner-add-cashier');
    await expect(form.getByTestId('owner-cashier-shop')).toContainText('E2E Owner Shop');
    await form.getByTestId('owner-cashier-name').fill(cashierName);
    await form.getByTestId('owner-cashier-email').fill(`e2e-added-${suffix}@demo.vamos.test`);
    await form.getByTestId('owner-cashier-phone').fill(phoneDigits());
    await form.getByTestId('owner-cashier-password').fill(`Added-${suffix}-pw-1`);
    await form.getByTestId('owner-cashier-submit').click();
    const row = shop.getByTestId('owner-cashier-row').filter({ hasText: cashierName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Active');
    await expect(form.getByTestId('owner-cashier-error')).toHaveCount(0);

    // Block it (accept the confirm), see it blocked, then unblock it.
    shop.once('dialog', (dialog) => void dialog.accept());
    await row.getByTestId('owner-cashier-block').click();
    await expect(row).toContainText('Disabled');
    await expect(row.getByTestId('owner-cashier-unblock')).toBeVisible();
    shop.once('dialog', (dialog) => void dialog.accept());
    await row.getByTestId('owner-cashier-unblock').click();
    await expect(row).toContainText('Active');
    await expect(row.getByTestId('owner-cashier-block')).toBeVisible();
  } finally {
    await staff.close();
    await office.close();
  }
});
