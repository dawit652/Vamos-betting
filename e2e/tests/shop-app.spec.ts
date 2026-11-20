import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser } from '../support/staff';

/**
 * The shop app (docs/plans/agent-shops.md, phase 1b): the admin adds an agent, a shop and a cashier
 * with a password of the admin's choosing; the cashier registers the device in the shop app, the
 * admin approves it on the agent's page, the cashier signs in, must choose their own password and
 * then works at the desk. The stack script does not start the shop app yet: start it on port 3002
 * (or SHOP_URL) and give the API SHOP_WEB_URL of the same origin.
 */

const SHOP_URL = (
  process.env.E2E_SHOP_URL ??
  process.env.SHOP_URL ??
  'http://localhost:3002'
).replace(/\/$/, '');

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

const phoneDigits = () => `09${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

async function newContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL });
}

test('a cashier registers a device, is approved, changes the password and sees the desk', async ({
  browser,
}) => {
  const staff = await newContext(browser, ADMIN_URL);
  const counter = await newContext(browser, SHOP_URL);
  const admin = await staff.newPage();
  const shop = await counter.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Shop App ${suffix}`;
  const cashierEmail = `e2e-shop-${suffix}@demo.vamos.test`;
  const cashierName = `E2E Counter ${suffix}`;
  const givenPassword = `Given-${suffix}-pw!`;
  const ownPassword = `Own-${suffix}-counter-pw!`;
  const deviceName = `Counter PC ${suffix}`;
  let shopLabel: string;
  // The agent's page, to close its shop even when a step fails (see the finally block).
  let agentUrl: string | null = null;
  try {
    // The admin adds an agent, a shop and a cashier whose password they choose.
    await loginInBrowser(admin, 'admin');
    await admin
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    const add = admin.getByRole('form', { name: 'Add an agent' });
    await add.getByLabel('Agent name').fill(agentName);
    await add.getByLabel("Owner's full name").fill('E2E Owner');
    await add.getByLabel("Owner's phone").fill(phoneDigits());
    await add.getByLabel('Commission based on').selectOption('ggr');
    await add.getByLabel('Commission percent').fill('10');
    await add.getByRole('button', { name: 'Add agent' }).click();
    const heading = admin.getByRole('heading', {
      name: new RegExp(`^Agent \\d+ – ${agentName}$`),
    });
    await expect(heading).toBeVisible();
    const number = Number(/^Agent (\d+)/.exec((await heading.textContent()) ?? '')?.[1]);
    shopLabel = `${number}-01`;
    agentUrl = admin.url();

    const shopForm = admin.getByRole('form', { name: 'Add a shop' });
    await shopForm.getByLabel('Shop name').fill('E2E Counter Shop');
    await shopForm.getByLabel('Address').fill('Bole, Addis Ababa');
    await shopForm.getByRole('button', { name: 'Add shop' }).click();
    await expect(admin.getByRole('cell', { name: shopLabel, exact: true })).toBeVisible();

    await admin.getByRole('link', { name: 'Add a cashier' }).click();
    const form = admin.getByRole('form', { name: 'Add a staff account' });
    await form.getByLabel('Email').fill(cashierEmail);
    await form.getByLabel('Name', { exact: true }).fill(cashierName);
    await form.getByLabel('Phone').fill(phoneDigits());
    await form.getByLabel('Password (optional)').fill(givenPassword);
    await form.getByRole('button', { name: 'Add account' }).click();
    const secret = admin.getByTestId('staff-secret');
    await expect(secret.getByText('They are shown only once.')).toBeVisible();
    await secret.getByRole('button', { name: 'Done' }).click();

    // On the counter PC: an unregistered device cannot sign in; it asks to be registered.
    await shop.goto('/');
    await expect(shop).toHaveURL(`${SHOP_URL}/login`);
    const email = shop.getByLabel('Email');
    // Hydration: typing before React is attached is lost, so retry until the value sticks.
    await expect(async () => {
      await email.fill(cashierEmail);
      await expect(email).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password', { exact: false }).fill(givenPassword);
    await shop.getByRole('button', { name: /^Sign in/ }).click();
    await expect(
      shop.getByText('Wrong email or password, or this device is not registered yet.'),
    ).toBeVisible();
    await shop.getByRole('link', { name: 'Register this device' }).first().click();

    await expect(shop).toHaveURL(`${SHOP_URL}/register-device`);
    const askEmail = shop.getByLabel('Email');
    await expect(async () => {
      await askEmail.fill(cashierEmail);
      await expect(askEmail).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password').fill(givenPassword);
    await shop.getByLabel('Device name').fill(deviceName);
    await shop.getByRole('button', { name: /^Ask for approval/ }).click();
    await expect(
      shop.getByText("Asked. An admin must approve this device on the agent's page; then sign in."),
    ).toBeVisible();

    // The admin approves it on the agent's page.
    await admin
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    await admin.getByRole('link', { name: agentName }).click();
    const device = admin.getByTestId('agent-devices').getByRole('row', { name: /Counter PC/ });
    await expect(device).toContainText('pending');
    admin.once('dialog', (dialog) => void dialog.accept());
    await device.getByRole('button', { name: 'Approve' }).click();
    await expect(device).toContainText('approved');

    // The cashier signs in, must choose their own password, and lands on the desk.
    await shop.goto('/login');
    const signInEmail = shop.getByLabel('Email');
    await expect(async () => {
      await signInEmail.fill(cashierEmail);
      await expect(signInEmail).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password').fill(givenPassword);
    await shop.getByRole('button', { name: /^Sign in/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/password`);
    await expect(shop.getByText('Your password was set by an admin.')).toBeVisible();
    // Every other page leads back here until the password is replaced.
    await shop.goto('/printer');
    await expect(shop).toHaveURL(`${SHOP_URL}/password`);

    await shop.getByLabel('Current password').fill(givenPassword);
    await shop.getByLabel(/^New password ·/).fill(ownPassword);
    await shop.getByLabel('New password again').fill(ownPassword);
    await shop.getByRole('button', { name: /^Save password/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/`);
    await expect(shop.getByTestId('shop-label')).toHaveText(`${shopLabel} · E2E Counter Shop`);
    await expect(shop.getByTestId('cashier-name')).toContainText(cashierName);
    // Selling tickets is on its own page (phase 3).
    await expect(
      shop.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Sell/ }),
    ).toBeVisible();

    // The desk: open a shift with a float, then close it with the counted cash.
    const open = shop.getByRole('form', { name: 'Open shift' });
    await open.getByLabel('Opening float').fill('1,500');
    await open.getByRole('button', { name: /^Open shift/ }).click();
    const summary = shop.getByTestId('shift-summary');
    await expect(summary).toContainText('ETB 1,500.00');
    await expect(shop.getByText('No receipts in this shift yet.')).toBeVisible();
    const close = shop.getByRole('form', { name: 'Close shift' });
    await close.getByLabel('Counted cash').fill('1500');
    await close.getByRole('button', { name: /^Close shift/ }).click();
    await expect(shop.getByTestId('closed-shift')).toContainText('ETB 0.00');

    // The printer page prints at the shop's paper width.
    await shop.getByRole('link', { name: /^Printer/ }).click();
    const receipt = shop.getByTestId('test-receipt');
    await expect(receipt).toContainText('TEST PRINT · Not a receipt');
    await expect(receipt).toContainText(shopLabel);
    await expect(receipt).toContainText('0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await expect(receipt).toContainText('የሙከራ ህትመት');

    await shop.getByRole('button', { name: /^Sign out/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/login`);

    // Close the shop again: a second open shop would stop the demo cashier of other specs from
    // opening a shift (a cashier without a shop needs exactly one open shop).
    admin.once('dialog', (dialog) => void dialog.accept());
    await admin.getByRole('button', { name: 'Close shop' }).click();
    await expect(admin.getByRole('button', { name: 'Reopen shop' })).toBeVisible();
  } finally {
    // A failed step must not leave the shop open: a second open shop stops the demo cashier of
    // other specs from opening a shift. Best effort, after a failure only (the button is gone
    // once the shop was closed above).
    if (agentUrl !== null) {
      try {
        await admin.goto(agentUrl);
        await admin.getByRole('heading', { name: /^Shops/ }).waitFor({ timeout: 10_000 });
        const close = admin.getByRole('button', { name: 'Close shop' });
        if (await close.isVisible()) {
          admin.once('dialog', (dialog) => void dialog.accept());
          await close.click();
          await expect(admin.getByRole('button', { name: 'Reopen shop' })).toBeVisible();
        }
      } catch {
        // The test already failed; the next run closes nothing it did not open.
      }
    }
    await counter.close();
    await staff.close();
  }
});
