import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { soonestEvents } from '../support/api';
import { ADMIN_URL } from '../support/env';
import { loginApi, loginInBrowser, staffApiOf } from '../support/staff';

/**
 * Head office approval of a shop payout (docs/plans/agent-shops.md): the agent's limit
 * `hqApprovalAbove` is ETB 1, so a winning ticket cannot be paid at the counter at once. The
 * cashier asks (the Pay screen says it awaits head office approval), finance approves on the
 * back office's Ticket payouts page, and the cashier then pays and prints the payout slip. Two or
 * three tickets (picks 1, 2 and X) go on the same match so that one of them is likely to win.
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

/** After kick-off: the match itself (seconds at SIM_SPEED), result, outbox and settlement. */
const SETTLE_GRACE_MS = 90_000;
/** Set-up, selling and paying around the wait. */
const UI_MARGIN_MS = 150_000;

test('a payout above the agent limit waits for head office approval, then the cashier pays it', async ({
  browser,
}) => {
  const startedAt = Date.now();
  // Raised again once the match is known (its kick-off decides the wait), as bet-flow does.
  test.setTimeout(5 * 60_000);
  const staff = await newContext(browser, ADMIN_URL);
  const financeContext = await newContext(browser, ADMIN_URL);
  const counter = await newContext(browser, SHOP_URL);
  await counter.addInitScript(() => {
    window.print = () => {};
  });
  const admin = await staff.newPage();
  const shop = await counter.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Approval ${suffix}`;
  const cashierEmail = `e2e-approval-${suffix}@demo.vamos.test`;
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
    // Any prize above ETB 1 needs head office approval, set before anything is sold.
    const limitsApi = await staffApiOf(staff.request);
    const limits = await limitsApi.put(`/admin/agents/${agentId}/ticket-limits`, {
      hqApprovalAbove: '100',
    });
    expect(limits.ok()).toBe(true);

    const shopForm = admin.getByRole('form', { name: 'Add a shop' });
    await shopForm.getByLabel('Shop name').fill('E2E Approval Shop');
    await shopForm.getByLabel('Address').fill('Bole, Addis Ababa');
    await shopForm.getByRole('button', { name: 'Add shop' }).click();
    await expect(admin.getByRole('button', { name: 'Close shop' })).toBeVisible();

    await admin.getByRole('link', { name: 'Add a cashier' }).click();
    const form = admin.getByRole('form', { name: 'Add a staff account' });
    await form.getByLabel('Email').fill(cashierEmail);
    await form.getByLabel('Name', { exact: true }).fill(`E2E Approval ${suffix}`);
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
    await shop.getByLabel('Device name').fill(`Approval PC ${suffix}`);
    await shop.getByRole('button', { name: /^Ask for approval/ }).click();
    await expect(shop.getByText(/^Asked\./)).toBeVisible();

    await admin.goto(agentUrl);
    const device = admin.getByTestId('agent-devices').getByRole('row', { name: /Approval PC/ });
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

    // Open a shift.
    const open = shop.getByRole('form', { name: 'Open shift' });
    await open.getByLabel('Opening float').fill('500');
    await open.getByRole('button', { name: /^Open shift/ }).click();
    await expect(shop.getByTestId('shift-summary')).toContainText('ETB 500.00');
    await expect(shop.getByTestId('desk-tickets')).toContainText('No tickets in this shift yet.');

    // The admin tops the agent up (finance approves: four eyes): the stake leaves this balance.
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

    // A prematch match that kicks off in a minute or more; window.print never opens a dialog.
    const [event] = await soonestEvents(counter.request, 1, {
      minLeadMs: 90_000,
      maxLeadMs: 4 * 60_000,
      timeoutMs: 90_000,
    });
    const kickoff = Date.parse(event!.startTime);
    test.setTimeout(
      Date.now() - startedAt + Math.max(0, kickoff - Date.now()) + SETTLE_GRACE_MS + UI_MARGIN_MS,
    );

    // Sell an ETB 20 single per pick on the same match, so that one of them is likely to win.
    const codes = ['1', '2', 'X'].filter((code) =>
      event!.mainMarket!.selections.some((s) => s.code === code && s.open),
    );
    expect(codes.length).toBeGreaterThanOrEqual(2);
    const numbers: string[] = [];
    for (const code of codes) {
      await shop
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Sell/ })
        .click();
      await expect(shop.getByTestId('sell-page')).toBeVisible();
      await shop.getByTestId('pick-game').fill(event!.gameId);
      await shop.getByTestId('pick-code').fill(code);
      await shop.getByTestId('pick-add').click();
      await expect(shop.getByTestId('slip-leg')).toHaveCount(1);
      await shop.getByTestId('slip-stake').fill('20');
      await shop.getByTestId('slip-check').click();
      await expect(shop.getByTestId('sell-submit')).toBeEnabled();
      await shop.getByTestId('sell-submit').click();
      await expect(shop.getByTestId('ticket-page')).toBeVisible();
      const number = (await shop.getByTestId('ticket-number').textContent()) ?? '';
      expect(number).toMatch(/^[A-Z0-9]{8}$/);
      numbers.push(number);
    }

    await shop
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Pay/ })
      .click();
    await expect(shop.getByTestId('pay-page')).toBeVisible();
    const find = async (number: string) => {
      await shop.getByTestId('pay-number').fill(number);
      await shop.getByTestId('pay-find').click();
      await expect(shop.getByTestId('pay-ticket-number')).toHaveText(number);
    };

    // Wait for the result: the first ticket is looked up until it is no longer open.
    await expect(async () => {
      await find(numbers[0]!);
      await expect(shop.getByTestId('pay-state')).not.toContainText('Not settled yet', {
        timeout: 5_000,
      });
    }).toPass({
      timeout: Math.max(0, kickoff - Date.now()) + SETTLE_GRACE_MS,
      intervals: [5_000],
    });

    // Which ticket won? (A draw or an odd result can leave every picked outcome lost.)
    let winner: string | null = null;
    for (const number of numbers) {
      await find(number);
      if (/^Payable/.test((await shop.getByTestId('pay-state').textContent()) ?? '')) {
        winner = number;
        break;
      }
    }
    if (winner === null) {
      test.info().annotations.push({
        type: 'skipped-part',
        description: `no ticket of ${codes.join('/')} won on game ${event!.gameId}; nothing to approve`,
      });
      test.skip(true, 'no payable ticket: the result fits none of the picks sold');
      return;
    }

    // Paying asks for approval: nothing is handed over.
    await find(winner);
    shop.once('dialog', (dialog) => void dialog.accept());
    await shop.getByTestId('pay-submit').click();
    await expect(shop.getByTestId('pay-message')).toContainText('head office');
    await expect(shop.getByTestId('pay-state')).toContainText('Awaiting head office approval');
    await expect(shop.getByTestId('pay-submit')).toHaveCount(0);

    // Finance approves the row of this ticket in the back office.
    // Signed in already: the top-up approval above went through this context's API session.
    const office = await financeContext.newPage();
    await office.goto('/retail-payouts');
    const row = office.getByTestId('retail-payout-row').filter({ hasText: winner });
    await expect(row).toHaveCount(1);
    office.once('dialog', (dialog) => void dialog.accept());
    await row.getByTestId('retail-payout-approve').click();
    await expect(office.getByTestId('retail-payout-row').filter({ hasText: winner })).toHaveCount(
      0,
    );

    // Back at the counter: Find again, now payable; pay; the payout slip.
    await find(winner);
    await expect(shop.getByTestId('pay-state')).toContainText('Payable');
    const due = (await shop.getByTestId('pay-amount').textContent()) ?? '';
    shop.once('dialog', (dialog) => void dialog.accept());
    await shop.getByTestId('pay-submit').click();
    await expect(shop).toHaveURL(/\/payout\/[0-9a-f-]+\?number=.+&print=1$/);
    await expect(shop.getByTestId('payout-slip')).toContainText('PAYOUT');
    await expect(shop.getByTestId('payout-slip')).toContainText(winner);
    await expect(shop.getByTestId('payout-amount')).toHaveText(due);
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
