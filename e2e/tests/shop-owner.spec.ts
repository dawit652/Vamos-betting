import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser, nextTotpCode } from '../support/staff';

/**
 * Agent owner accounts (docs/plans/agent-shops.md, phase 1b step 1): the admin makes the owner's
 * account on the agent's page (password and authenticator secret shown once); the owner signs in
 * to the shop app with the authenticator code (no device), replaces the generated password and
 * sees their agent's overview.
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

test('an admin makes the owner account; the owner signs in to the shop app with the code', async ({
  browser,
}) => {
  const staff = await newContext(browser, ADMIN_URL);
  const office = await newContext(browser, SHOP_URL);
  const admin = await staff.newPage();
  const shop = await office.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Owner Agent ${suffix}`;
  const ownerEmail = `e2e-owner-${suffix}@demo.vamos.test`;
  const ownPassword = `Own-${suffix}-owner-pw!`;
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

    // The overview of their agent; the desk is not theirs.
    await expect(shop).toHaveURL(`${SHOP_URL}/owner`);
    await expect(shop.getByText(agentName).first()).toBeVisible();
    await expect(shop.getByText('Nahubet approves new devices in the back office.')).toBeVisible();
    await shop.goto('/');
    await expect(shop).toHaveURL(`${SHOP_URL}/owner`);

    // The back office shows the password changed.
    await admin.reload();
    await expect(admin.getByText('Must change the generated password')).toHaveCount(0);
  } finally {
    await staff.close();
    await office.close();
  }
});
