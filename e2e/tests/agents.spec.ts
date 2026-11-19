import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser, staffApiOf } from '../support/staff';

/**
 * Agent shops, phase 1a (docs/plans/agent-shops.md): the admin adds an agent, a shop and a cashier
 * and blocks the agent; a finance user can read the agents but not change them.
 */

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

async function staffContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
}

const phoneDigits = () => `09${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

test('an admin adds an agent, a shop and a cashier, and blocks and unblocks the agent', async ({
  browser,
}) => {
  const staff = await staffContext(browser);
  const page = await staff.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Agent ${suffix}`;
  const cashierEmail = `e2e-cashier-${suffix}@demo.vamos.test`;
  const cashierName = `E2E Cashier ${suffix}`;
  const cashierPhone = phoneDigits();
  try {
    await loginInBrowser(page, 'admin');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();

    const add = page.getByRole('form', { name: 'Add an agent' });
    await add.getByLabel('Agent name').fill(agentName);
    await add.getByLabel("Owner's full name").fill('E2E Owner');
    await add.getByLabel("Owner's phone").fill(phoneDigits());
    await add.getByLabel('Commission based on').selectOption('ggr');
    await add.getByLabel('Commission percent').fill('10');
    await add.getByRole('button', { name: 'Add agent' }).click();

    const heading = page.getByRole('heading', { name: new RegExp(`^Agent \\d+ – ${agentName}$`) });
    await expect(heading).toBeVisible();
    const number = Number(/^Agent (\d+)/.exec((await heading.textContent()) ?? '')?.[1]);
    expect(number).toBeGreaterThanOrEqual(1001);
    await expect(page.getByText('10% of GGR')).toBeVisible();

    const shop = page.getByRole('form', { name: 'Add a shop' });
    await shop.getByLabel('Shop name').fill('E2E Shop');
    await shop.getByLabel('Address').fill('Bole, Addis Ababa');
    await shop.getByRole('button', { name: 'Add shop' }).click();
    await expect(page.getByRole('cell', { name: `${number}-01`, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Block agent' }).click();
    await page.getByLabel('Reason').fill('E2E check of the block');
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(page.getByText('Blocked', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Unblock agent' }).click();
    await page.getByLabel('Reason').fill('E2E check of the unblock');
    await page.getByRole('button', { name: 'Unblock', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Block agent' })).toBeVisible();

    await page.getByRole('link', { name: 'Add a cashier' }).click();
    const form = page.getByRole('form', { name: 'Add a staff account' });
    await expect(form.getByLabel('Role')).toHaveValue('cashier');
    await expect(form.getByLabel('Shop')).toContainText(`${number}-01`);
    await form.getByLabel('Email').fill(cashierEmail);
    await form.getByLabel('Name', { exact: true }).fill(cashierName);
    await form.getByLabel('Phone').fill(cashierPhone);
    await form.getByRole('button', { name: 'Add account' }).click();
    const secret = page.getByTestId('staff-secret');
    await expect(secret.getByText('They are shown only once.')).toBeVisible();
    await secret.getByRole('button', { name: 'Done' }).click();

    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    await page.getByRole('link', { name: agentName }).click();
    const row = page.getByRole('row', { name: new RegExp(cashierEmail) });
    await expect(row).toBeVisible();
    const local = `${cashierPhone.slice(0, 4)} ${cashierPhone.slice(4, 6)} ${cashierPhone.slice(6, 8)} ${cashierPhone.slice(8)}`;
    await expect(row).toContainText(local);
    await expect(row).toContainText(`${number}-01 E2E Shop`);

    // Close the shop again: a second open shop would stop the demo cashier of other specs from
    // opening a shift (a cashier without a shop needs exactly one open shop).
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Close shop' }).click();
    await expect(page.getByRole('button', { name: 'Reopen shop' })).toBeVisible();
  } finally {
    await staff.close();
  }
});

test('a finance user sees the agents but cannot add, block or create one (403)', async ({
  browser,
}) => {
  const staff = await staffContext(browser);
  const page = await staff.newPage();
  try {
    await loginInBrowser(page, 'finance');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    await expect(page.getByRole('link', { name: 'Nahubet HQ' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Add an agent' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Nahubet HQ' }).click();
    await expect(page.getByRole('heading', { name: /^Agent 1000 – / })).toBeVisible();
    await expect(page.getByRole('button', { name: /Block agent/ })).toHaveCount(0);

    const api = await staffApiOf(staff.request);
    const response = await api.post('/admin/agents', {
      name: 'Finance Agent',
      ownerName: 'Finance Owner',
      ownerPhone: phoneDigits(),
      commissionKind: 'ggr',
      commissionBps: 1000,
    });
    expect(response.status()).toBe(403);
  } finally {
    await staff.close();
  }
});
