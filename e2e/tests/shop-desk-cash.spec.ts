import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { randomPhone } from '../support/phone';
import { loginApi, loginInBrowser, staffApiOf } from '../support/staff';
import { registerAndVerify } from '../support/ui';

/**
 * The shop app's player-cash desk (docs/plans/agent-shops.md): at an agent's shop the desk takes no
 * player cash until an admin switches it on; then a cashier finds a player by phone, takes an ETB
 * 100 deposit paid from the agent's balance, lands on the receipt page and prints the original once.
 * The agent, shop, cashier and balance are created here, so the spec needs no other spec's data.
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

test('a cashier at an agent shop takes a player deposit and prints the receipt', async ({
  browser,
  page: playerPage,
}) => {
  await playerPage.context().addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
  const playerPhone = randomPhone();
  await registerAndVerify(playerPage, playerPhone);

  const staff = await newContext(browser, ADMIN_URL);
  const financeContext = await newContext(browser, ADMIN_URL);
  const counter = await newContext(browser, SHOP_URL);
  const admin = await staff.newPage();
  const shop = await counter.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Desk Cash ${suffix}`;
  const cashierEmail = `e2e-desk-${suffix}@demo.vamos.test`;
  const givenPassword = `Given-${suffix}-pw!`;
  const ownPassword = `Own-${suffix}-counter-pw!`;
  let agentUrl: string | null = null;
  try {
    // The admin adds an agent, a shop and a cashier.
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
    await expect(
      admin.getByRole('heading', { name: new RegExp(`^Agent \\d+ – ${agentName}$`) }),
    ).toBeVisible();
    agentUrl = admin.url();
    const agentId = agentUrl.split('/').pop() ?? '';

    const shopForm = admin.getByRole('form', { name: 'Add a shop' });
    await shopForm.getByLabel('Shop name').fill('E2E Desk Cash Shop');
    await shopForm.getByLabel('Address').fill('Bole, Addis Ababa');
    await shopForm.getByRole('button', { name: 'Add shop' }).click();
    await expect(admin.getByRole('button', { name: 'Close shop' })).toBeVisible();

    await admin.getByRole('link', { name: 'Add a cashier' }).click();
    const form = admin.getByRole('form', { name: 'Add a staff account' });
    await form.getByLabel('Email').fill(cashierEmail);
    await form.getByLabel('Name', { exact: true }).fill(`E2E Desk ${suffix}`);
    await form.getByLabel('Phone').fill(phoneDigits());
    await form.getByLabel('Password (optional)').fill(givenPassword);
    await form.getByRole('button', { name: 'Add account' }).click();
    const secret = admin.getByTestId('staff-secret');
    await expect(secret.getByText('They are shown only once.')).toBeVisible();
    await secret.getByRole('button', { name: 'Done' }).click();

    // The cashier's device: ask for approval, an admin approves.
    await shop.goto('/register-device');
    const askEmail = shop.getByLabel('Email');
    await expect(async () => {
      await askEmail.fill(cashierEmail);
      await expect(askEmail).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password').fill(givenPassword);
    await shop.getByLabel('Device name').fill(`Desk PC ${suffix}`);
    await shop.getByRole('button', { name: /^Ask for approval/ }).click();
    await expect(shop.getByText(/^Asked\./)).toBeVisible();

    await admin.goto(agentUrl);
    const device = admin.getByTestId('agent-devices').getByRole('row', { name: /Desk PC/ });
    admin.once('dialog', (dialog) => void dialog.accept());
    await device.getByRole('button', { name: 'Approve' }).click();
    await expect(device).toContainText('approved');

    // Sign in and choose an own password.
    await shop.goto('/login');
    const signInEmail = shop.getByLabel('Email');
    await expect(async () => {
      await signInEmail.fill(cashierEmail);
      await expect(signInEmail).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password').fill(givenPassword);
    await shop.getByRole('button', { name: /^Sign in/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/password`);
    await shop.getByLabel('Current password').fill(givenPassword);
    await shop.getByLabel(/^New password ·/).fill(ownPassword);
    await shop.getByLabel('New password again').fill(ownPassword);
    await shop.getByRole('button', { name: /^Save password/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/`);

    // Open a shift. Player cash is still off for this agent: a notice, no forms.
    const open = shop.getByRole('form', { name: 'Open shift' });
    await open.getByLabel('Opening float').fill('500');
    await open.getByRole('button', { name: /^Open shift/ }).click();
    await expect(shop.getByTestId('shift-summary')).toContainText('ETB 500.00');
    await expect(shop.getByTestId('player-cash-off')).toBeVisible();
    await expect(shop.getByTestId('player-phone')).toHaveCount(0);

    // The admin tops the agent up (finance approves: four eyes) and switches player cash on.
    const adminApi = await staffApiOf(staff.request);
    const topup = await adminApi.post(`/admin/agents/${agentId}/topups`, {
      direction: 'in',
      amount: '500000',
      method: 'cash',
    });
    expect(topup.ok()).toBe(true);
    const topupId = ((await topup.json()) as { topup: { id: string } }).topup.id;
    const financeApi = await loginApi(financeContext.request, 'finance');
    expect((await financeApi.post(`/admin/agent-topups/${topupId}/approve`)).ok()).toBe(true);
    expect(
      (await adminApi.post(`/admin/agents/${agentId}/player-cash`, { enabled: true })).ok(),
    ).toBe(true);

    await shop.reload();
    await expect(shop.getByTestId('desk-players')).toBeVisible();
    await expect(shop.getByTestId('player-cash-off')).toHaveCount(0);
    await expect(shop.getByTestId('desk-agent-balance')).toContainText('ETB 5,000.00');

    // Find the player and take ETB 100; window.print never opens a dialog.
    await shop.evaluate(() => {
      const w = window as unknown as { __prints: number };
      w.__prints = 0;
      window.print = () => {
        w.__prints += 1;
      };
    });
    const phone = shop.getByTestId('player-phone');
    await expect(async () => {
      await phone.fill(`0${playerPhone.slice(4)}`);
      await expect(phone).toHaveValue(`0${playerPhone.slice(4)}`, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByTestId('player-lookup').click();
    await expect(shop.getByTestId('player-card')).toContainText(playerPhone);
    await shop.getByTestId('deposit-amount').fill('100');
    await shop.getByTestId('deposit-submit').click();

    // The receipt page: the original is printed once (no COPY), the Print button makes a copy.
    await expect(shop.getByTestId('receipt-page')).toBeVisible();
    await expect(shop).toHaveURL(/\/receipt\/[0-9a-f-]+\?print=1$/);
    const receipt = shop.getByTestId('receipt');
    await expect(receipt).toContainText('CASH DEPOSIT');
    await expect(receipt).toContainText('ETB 100.00');
    await expect(receipt).toContainText(`${playerPhone.slice(0, 5)}****${playerPhone.slice(-4)}`);
    await expect(shop.getByTestId('receipt-copy-badge')).toHaveCount(0);
    await expect
      .poll(() => shop.evaluate(() => (window as unknown as { __prints: number }).__prints))
      .toBe(1);
    await shop.getByTestId('receipt-print').click();
    await expect(shop.getByTestId('receipt-copy-badge')).toBeVisible();

    // Back at the desk the receipt is listed with its copy count.
    await shop.getByRole('link', { name: 'Back to the desk' }).click();
    await expect(shop.getByTestId('shift-summary')).toContainText('ETB 100.00');
  } finally {
    // Close the shop again so a second open shop does not stop other specs' cashiers.
    if (agentUrl !== null) {
      try {
        await admin.goto(agentUrl);
        const close = admin.getByRole('button', { name: 'Close shop' });
        await close.waitFor({ timeout: 10_000 });
        admin.once('dialog', (dialog) => void dialog.accept());
        await close.click();
        await expect(admin.getByRole('button', { name: 'Reopen shop' })).toBeVisible();
      } catch {
        // The test already failed; nothing more to clean up.
      }
    }
    await counter.close();
    await financeContext.close();
    await staff.close();
  }
});
