import { randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser } from '../support/staff';

/**
 * Deposit accounts (the SMS rail's collection accounts): an admin adds one, cannot approve it
 * (four eyes), finance approves it, then the admin edits its hint and deletes it. The demo
 * accounts stay untouched: other specs need them.
 */

test.use({ actionTimeout: 20_000 });

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Desktop Chrome'], baseURL: ADMIN_URL });
}

test('an admin adds a deposit account, finance approves it, the admin edits and deletes it', async ({
  browser,
}) => {
  const adminContext = await newContext(browser);
  const financeContext = await newContext(browser);
  const admin = await adminContext.newPage();
  const finance = await financeContext.newPage();
  const number = String(randomInt(10_000_000_000, 100_000_000_000));
  try {
    await loginInBrowser(admin, 'admin');
    await admin.goto('/collection-accounts');
    const page = admin.getByTestId('collection-accounts-page');
    await expect(page.getByRole('heading', { name: 'Deposit accounts' })).toBeVisible();
    const active = page.getByTestId('ca-active-row');
    await expect(active.filter({ hasText: '0900000000' })).toHaveCount(1);
    await expect(active.filter({ hasText: '1000000000000' })).toHaveCount(1);

    await admin.getByTestId('ca-institution').selectOption({ label: 'Awash Bank' });
    await admin.getByTestId('ca-number').fill(number);
    await admin.getByTestId('ca-name').fill('Vamos Demo');
    await admin.getByTestId('ca-add-submit').click();
    await expect(admin.getByTestId('ca-message')).toContainText('waiting for a second person');
    const pending = page.getByTestId('ca-pending-row').filter({ hasText: number });
    await expect(pending).toHaveCount(1);

    // The person who added it cannot approve it.
    await pending.getByTestId('ca-approve').click();
    await expect(admin.getByTestId('ca-error')).toBeVisible();
    await expect(pending).toHaveCount(1);

    await loginInBrowser(finance, 'finance');
    await finance.goto('/collection-accounts');
    const toApprove = finance.getByTestId('ca-pending-row').filter({ hasText: number });
    await toApprove.getByTestId('ca-approve').click();
    await expect(finance.getByTestId('ca-active-row').filter({ hasText: number })).toHaveCount(1);

    await admin.reload();
    const row = page.getByTestId('ca-active-row').filter({ hasText: number });
    await row.getByTestId('ca-edit').click();
    await row.getByTestId('ca-edit-hint').fill('E2E hint');
    await row.getByTestId('ca-edit-save').click();
    await expect(admin.getByTestId('ca-message')).toContainText('Saved');
    await expect(row).toContainText('E2E hint');

    admin.once('dialog', (d) => void d.accept());
    await row.getByTestId('ca-delete').click();
    await expect(page.getByTestId('ca-active-row').filter({ hasText: number })).toHaveCount(0);
  } finally {
    await adminContext.close();
    await financeContext.close();
  }
});
