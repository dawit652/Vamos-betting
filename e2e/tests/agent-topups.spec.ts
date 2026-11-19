import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser } from '../support/staff';

/**
 * The agent balance (docs/plans/agent-shops.md, phase 2): an admin records a top-up on the agent's
 * page; the admin cannot approve it (four eyes); a finance user approves it and the balance shows.
 */

test.use({ actionTimeout: 20_000 });

const phoneDigits = () => `09${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Desktop Chrome'], baseURL: ADMIN_URL });
}

test('an admin records a top-up, finance approves it, the balance grows', async ({ browser }) => {
  const adminContext = await newContext(browser);
  const financeContext = await newContext(browser);
  const admin = await adminContext.newPage();
  const finance = await financeContext.newPage();
  const agentName = `E2E Topup Agent ${randomBytes(4).toString('hex')}`;
  try {
    await loginInBrowser(admin, 'admin');
    await admin
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    const add = admin.getByRole('form', { name: 'Add an agent' });
    await add.getByLabel('Agent name').fill(agentName);
    await add.getByLabel("Owner's full name").fill('E2E Topup Owner');
    await add.getByLabel("Owner's phone").fill(phoneDigits());
    await add.getByLabel('Commission based on').selectOption('ggr');
    await add.getByLabel('Commission percent').fill('10');
    await add.getByRole('button', { name: 'Add agent' }).click();
    await expect(
      admin.getByRole('heading', { name: new RegExp(`^Agent \\d+ – ${agentName}$`) }),
    ).toBeVisible();
    const agentUrl = admin.url();
    await expect(admin.getByTestId('agent-balance')).toContainText('ETB 0.00');

    const record = admin.getByRole('form', { name: 'Record a top-up or take-back' });
    await record.getByLabel('Kind').selectOption('in');
    await record.getByLabel('Amount (ETB)').fill('5,000');
    await record.getByLabel('Method').selectOption('cash');
    await record.getByRole('button', { name: 'Record' }).click();
    const row = admin.getByTestId('agent-topups').getByRole('row').nth(1);
    await expect(row).toContainText('requested');
    await expect(row).toContainText('ETB 5,000.00');
    // The recorder sees no Approve button (four eyes).
    await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(admin.getByTestId('agent-balance')).toContainText('ETB 0.00');

    // A finance user approves it.
    await loginInBrowser(finance, 'finance');
    await finance.goto(agentUrl);
    const pending = finance.getByTestId('agent-topups').getByRole('row').nth(1);
    await pending.getByRole('button', { name: 'Approve' }).click();
    await pending.getByRole('button', { name: 'Approve' }).click();
    await expect(pending).toContainText('approved');
    await expect(finance.getByTestId('agent-balance')).toContainText('ETB 5,000.00');

    await admin.reload();
    await expect(admin.getByTestId('agent-balance')).toContainText('ETB 5,000.00');
  } finally {
    await adminContext.close();
    await financeContext.close();
  }
});
