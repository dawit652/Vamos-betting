import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { EventSummary } from '@vamos/contracts';
import { getWallet, myBets, soonestEvents } from '../support/api';
import { ADMIN_URL, API_URL, WEB_URL } from '../support/env';
import { birr, typedBirr } from '../support/money';
import { myWithdrawals, paymentOptions } from '../support/payments';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { loginAccountInBrowser, type StaffCredentials } from '../support/staff';
import { PASSWORD, balanceChip, pick } from '../support/ui';

/**
 * Deposit and withdrawal on a DEPLOYED demo (NODE_ENV=production, OPERATING_MODE=demo, the
 * compose stack of docs/deployment.md), through the public pages only: no dev SMS inbox and no
 * stand-in back office exist there.
 *
 * register (code shown on screen) → KYC (mock Fayda) → deposit, approved with PIN 1234 on the
 * simulated phone → back every outcome of one match (the 1x wagering rule; exactly one wins) →
 * the simulator and worker settle → withdraw → a staff member approves it in the back office →
 * the worker pays it → the player sees Paid.
 *
 * Needs a staff account made with `admin:create` (admin or finance role):
 *   E2E_WEB_URL, E2E_API_URL, E2E_ADMIN_URL, E2E_STAFF_EMAIL, E2E_STAFF_PASSWORD,
 *   E2E_STAFF_TOTP_SECRET.  Run: pnpm e2e:deployment
 * With the production simulator speed (90 s matches, a fixture every 5 minutes) it takes 5–10 min.
 */

const STAFF: StaffCredentials | null =
  process.env.E2E_STAFF_EMAIL && process.env.E2E_STAFF_PASSWORD && process.env.E2E_STAFF_TOTP_SECRET
    ? {
        email: process.env.E2E_STAFF_EMAIL,
        password: process.env.E2E_STAFF_PASSWORD,
        totpSecret: process.env.E2E_STAFF_TOTP_SECRET,
      }
    : null;

/** The legs must still be prematch when the last single is placed. */
const MIN_LEAD_MS = 120_000;
/** Rolling demo fixtures kick off every 5 minutes by default. */
const MAX_LEAD_MS = 11 * 60_000;
const FIND_EVENT_MS = 6 * 60_000;
/** After the kick-off: a 90 s match at SIM_SPEED=1, its result, outbox and settlement. */
const SETTLE_GRACE_MS = 4 * 60_000;
const PAYOUT_MS = 90_000;
const SCREENSHOTS = process.env.E2E_SCREENSHOTS_DIR;

test.use({ actionTimeout: 20_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

async function shot(page: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

/** A number the mock provider pays at once (0000 fails, 9999 stays pending). */
function payablePhone(): string {
  for (;;) {
    const phone = randomPhone();
    if (!phone.endsWith('0000') && !phone.endsWith('9999')) return phone;
  }
}

/** A Fayda FIN the mock registry verifies (0000 unknown, 9999 review). */
function verifiableFayda(): string {
  for (;;) {
    const fin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    if (!fin.endsWith('0000') && !fin.endsWith('9999')) return fin;
  }
}

/** Registers and verifies the phone with the code a demo shows on screen (no SMS is sent). */
async function registerWithOnScreenCode(page: Page, phone: string): Promise<void> {
  await page.goto('/register');
  await page.locator('#reg-phone').fill(phone);
  await page.locator('#reg-password').fill(PASSWORD);
  await page.locator('#reg-dob').fill(ADULT_DATE_OF_BIRTH);
  await page.locator('input[name="acceptTerms"]').check();
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  await page.waitForURL('**/verify');
  await expect(page.getByText(/^Demo: no real SMS is sent\. Your code is \d{6}\./)).toBeVisible();
  await shot(page, '01-verify-code-on-screen');
  await page.getByRole('button', { name: 'Fill in', exact: true }).click();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await page.waitForURL(/\/wallet\?welcome=1$/);
  await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 0.00');
}

async function placeSingle(page: Page, event: EventSummary, index: number, stake: bigint) {
  await page.goto(`/event/${event.id}`);
  const buttons = page.locator('main details[open]').first().locator('button.odds-btn:enabled');
  await expect(buttons).toHaveCount(event.mainMarket!.selections.length);
  await pick(buttons.nth(index));
  await page.getByRole('button', { name: 'Betslip: 1 selections' }).click();
  const slip = page.getByRole('dialog');
  await slip.getByLabel('Stake (ETB)', { exact: true }).fill(typedBirr(stake.toString()));
  await slip.getByLabel('If odds change').selectOption('any');
  const place = slip.getByRole('button', { name: `Place bet · ETB ${birr(stake.toString())}` });
  await expect(place).toBeEnabled({ timeout: 15_000 });
  await place.click();
  await expect(slip.getByText('Bet placed')).toBeVisible({ timeout: 15_000 });
  if (index === 0) await shot(page, '05-bet-placed');
  await slip.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(slip).toBeHidden();
}

test('deposit and withdraw on a deployed demo', async ({ page, context, browser, request }) => {
  test.skip(STAFF === null, 'set E2E_STAFF_EMAIL, E2E_STAFF_PASSWORD and E2E_STAFF_TOTP_SECRET');
  const staff = STAFF!;
  test.setTimeout(FIND_EVENT_MS + MAX_LEAD_MS + SETTLE_GRACE_MS + PAYOUT_MS + 5 * 60_000);
  console.log(`testing web ${WEB_URL}, api ${API_URL}, back office ${ADMIN_URL}`);

  const options = await paymentOptions(request);
  expect(options.demo).toBe(true);
  expect(options.providers.map((p) => p.name)).toContain('mock');
  const { minWithdrawal, autoApproveBelow } = options.limits;
  // The stake on each outcome, and the withdrawal: not below auto-approval, so staff review it.
  const stake =
    BigInt(autoApproveBelow) > BigInt(minWithdrawal)
      ? BigInt(autoApproveBelow)
      : BigInt(minWithdrawal);
  const phone = payablePhone();

  await test.step('register with the on-screen code', async () => {
    await registerWithOnScreenCode(page, phone);
  });

  await test.step('verify identity (mock Fayda)', async () => {
    await page.goto('/account/kyc');
    const fin = verifiableFayda();
    await page.locator('#kyc-id').fill(fin);
    await page.locator('#kyc-name').fill('Abebe Kebede');
    await page.locator('#kyc-dob').fill(ADULT_DATE_OF_BIRTH);
    await page.getByRole('button', { name: 'Submit for verification' }).click();
    await expect(
      page.getByText(`Your identity is verified (ID ending in ${fin.slice(-4)}).`),
    ).toBeVisible();
  });

  const [event] = await soonestEvents(page.request, 1, {
    minLeadMs: MIN_LEAD_MS,
    maxLeadMs: MAX_LEAD_MS,
    timeoutMs: FIND_EVENT_MS,
  });
  const outcomes = event!.mainMarket!.selections.length;
  const deposit = stake * BigInt(outcomes);

  await test.step(`deposit ETB ${birr(deposit.toString())} and approve it on the simulated phone`, async () => {
    await page.goto('/wallet/deposit');
    await page.locator('#deposit-amount').fill(typedBirr(deposit.toString()));
    await page.getByRole('button', { name: `Deposit ETB ${birr(deposit.toString())}` }).click();
    await expect(page.getByText('Waiting for approval')).toBeVisible();
    await shot(page, '02-deposit-waiting');

    const phoneTab = await context.newPage();
    await phoneTab.goto('/dev/phone');
    await expect(phoneTab.getByText(`Pay ETB ${birr(deposit.toString())}`)).toBeVisible({
      timeout: 15_000,
    });
    await phoneTab.getByLabel('PIN', { exact: true }).fill('1234');
    await shot(phoneTab, '03-simulated-phone');
    await phoneTab.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(phoneTab.getByText(/^Approved\./)).toBeVisible();
    await phoneTab.close();

    await expect(
      page.getByText(`ETB ${birr(deposit.toString())} was added to your balance.`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(deposit.toString())}`,
    );
    await shot(page, '04-deposit-credited');
  });

  const kickOff = Date.parse(event!.startTime);
  await test.step(`bet the deposit: ETB ${birr(stake.toString())} on each of ${outcomes} outcomes`, async () => {
    for (let index = 0; index < outcomes; index += 1) {
      await placeSingle(page, event!, index, stake);
    }
    expect(Date.now()).toBeLessThan(kickOff);
    expect((await myWithdrawals(page.request)).wageringRemaining).toBe('0');
  });

  await test.step('wait for the match to be played and the bets settled', async () => {
    console.log(`kick-off in ${Math.round((kickOff - Date.now()) / 1000)} s`);
    await expect
      .poll(async () => (await myBets(page.request, 'settled')).length, {
        timeout: Math.max(0, kickOff - Date.now()) + SETTLE_GRACE_MS,
        intervals: [5000],
      })
      .toBe(outcomes);
  });

  const cashBefore = BigInt((await getWallet(page.request)).cash);
  expect(cashBefore).toBeGreaterThanOrEqual(stake);

  let withdrawalId = '';
  await test.step(`withdraw ETB ${birr(stake.toString())}`, async () => {
    await page.goto('/wallet/withdraw');
    await page.locator('#withdraw-amount').fill(typedBirr(stake.toString()));
    await page.getByRole('button', { name: `Withdraw ETB ${birr(stake.toString())}` }).click();
    await expect(page.getByText(/^Withdrawal requested\./)).toBeVisible();
    await shot(page, '06-withdrawal-requested');
    const [withdrawal] = (await myWithdrawals(page.request)).items;
    expect(withdrawal).toMatchObject({ status: 'requested', amount: stake.toString(), phone });
    withdrawalId = withdrawal!.id;
  });

  await test.step('a staff member approves it in the back office', async () => {
    const staffContext = await browser.newContext();
    try {
      const staffPage = await staffContext.newPage();
      await loginAccountInBrowser(staffPage, staff);
      await staffPage.goto(`${ADMIN_URL}/withdrawals`);
      await staffPage.getByRole('button', { name: 'All withdrawals' }).click();
      const row = staffPage.getByTestId(`withdrawal-${withdrawalId}`);
      await expect(row).toContainText('requested');
      await shot(staffPage, '07-back-office-queue');
      await row.getByRole('button', { name: 'Approve' }).click();
      await expect(row).not.toContainText('requested');
    } finally {
      await staffContext.close();
    }
  });

  await test.step('the worker pays it and the player sees Paid', async () => {
    await expect
      .poll(async () => (await myWithdrawals(page.request)).items[0]?.status, {
        timeout: PAYOUT_MS,
        intervals: [2000],
      })
      .toBe('paid');
    await page.goto('/wallet/withdraw');
    const card = page.getByRole('listitem').filter({ hasText: `To ${phone}` });
    await expect(card.getByText('Paid', { exact: true })).toHaveCount(2);
    expect((await getWallet(page.request)).cash).toBe((cashBefore - stake).toString());
    await shot(page, '08-withdrawal-paid');
  });
});
