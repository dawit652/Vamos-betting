import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  AmlFlagListResponse,
  GameSettingsView,
  MeResponse,
  ReconciliationRequestResponse,
  ReconciliationRunListResponse,
  WithdrawalView,
} from '@vamos/contracts';
import { csrfHeaders, getWallet } from '../support/api';
import { ADMIN_URL, API_URL, WEB_URL } from '../support/env';
import { birr, typedBirr } from '../support/money';
import { paymentOptions } from '../support/payments';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { STAFF_CSRF_HEADER, loginApi, loginInBrowser } from '../support/staff';
import { balanceChip, registerAndVerify } from '../support/ui';

/**
 * The Phase 10 compliance flow, end to end against the real stack (demo mode):
 *
 *  - a player deposits ETB 1,000 on the simulated phone and at once asks to withdraw part of it,
 *    without having bet (the wagering multiplier is switched off for the test so the request
 *    reaches the AML rules; it is restored afterwards). The deposit-then-withdraw rule flags it
 *    (high severity) and the withdrawal waits for staff with review reason `aml_review`;
 *  - compliance staff sign in to the admin app, run the reconciliation now (queued by the API,
 *    run by the worker, polled by the page) and see a clean run, and see the AML flag of that
 *    player.
 */

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

const DEPOSIT = 100_000n; // ETB 1,000: the rule's default minimum deposit

function payablePhone(): string {
  for (;;) {
    const phone = randomPhone();
    if (!phone.endsWith('0000') && !phone.endsWith('9999')) return phone;
  }
}

function verifiableFayda(): string {
  for (;;) {
    const fin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    if (!fin.endsWith('0000') && !fin.endsWith('9999')) return fin;
  }
}

test('a deposit followed at once by a withdrawal is flagged; compliance reconciles and sees the flag', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(300_000);
  const phone = payablePhone();
  let userId = '';
  let withdrawalId = '';

  // Staff side: admin changes the wagering multiplier (restored in `finally`).
  const adminContext = await browser.newContext();
  const admin = await loginApi(adminContext.request, 'admin');
  const settingsResponse = await admin.get('/admin/settings');
  expect(settingsResponse.ok()).toBe(true);
  const original = ((await settingsResponse.json()) as { settings: GameSettingsView }).settings
    .payments;
  const putPayments = async (value: unknown) =>
    adminContext.request.put(`${API_URL}/admin/settings/payments`, {
      headers: { [STAFF_CSRF_HEADER]: admin.session.csrfToken },
      data: { value },
    });

  try {
    const lowered = await putPayments({ ...original, wageringMultiplierBps: 0 });
    expect(lowered.ok(), await lowered.text()).toBe(true);

    await test.step('the player registers, passes KYC and deposits ETB 1,000 on the simulated phone', async () => {
      await registerAndVerify(page, phone);
      const me = (await (await page.request.get(`${API_URL}/me`)).json()) as MeResponse;
      userId = me.id;

      await page.goto('/account/kyc');
      const fin = verifiableFayda();
      await page.locator('#kyc-id').fill(fin);
      await page.locator('#kyc-name').fill('Abebe Kebede');
      await page.locator('#kyc-dob').fill(ADULT_DATE_OF_BIRTH);
      await page.getByRole('button', { name: 'Submit for verification' }).click();
      await expect(
        page.getByText(`Your identity is verified (ID ending in ${fin.slice(-4)}).`),
      ).toBeVisible();

      const phoneTab = await context.newPage();
      await page.goto('/wallet/deposit');
      await page.locator('#deposit-amount').fill(typedBirr(DEPOSIT.toString()));
      await page.getByRole('button', { name: `Deposit ETB ${birr(DEPOSIT.toString())}` }).click();
      await expect(page.getByText('Waiting for approval')).toBeVisible();
      await phoneTab.goto('/dev/phone');
      await expect(phoneTab.getByText(`Pay ETB ${birr(DEPOSIT.toString())}`)).toBeVisible({
        timeout: 15_000,
      });
      await phoneTab.getByLabel('PIN', { exact: true }).fill('1234');
      await phoneTab.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(phoneTab.getByText(/^Approved\./)).toBeVisible();
      await page.bringToFront();
      await expect(
        page.getByText(`ETB ${birr(DEPOSIT.toString())} was added to your balance.`),
      ).toBeVisible({ timeout: 20_000 });
      await expect(balanceChip(page)).toHaveAttribute(
        'aria-label',
        `Balance: ETB ${birr(DEPOSIT.toString())}`,
      );
      await phoneTab.close();
    });

    await test.step('the player asks to withdraw part of it without betting: it waits for staff (manual_review to the player)', async () => {
      const { minWithdrawal } = (await paymentOptions(page.request)).limits;
      const amount = BigInt(minWithdrawal) > 10_000n ? minWithdrawal : '10000';
      const response = await page.request.post(`${API_URL}/payments/withdrawals`, {
        headers: { ...(await csrfHeaders(page.request)), 'idempotency-key': crypto.randomUUID() },
        data: { amount },
      });
      expect(response.status(), await response.text()).toBe(201);
      const withdrawal = (await response.json()) as WithdrawalView;
      withdrawalId = withdrawal.id;
      // The player never learns it is an AML review (tipping-off): a generic reason only.
      expect(withdrawal).toMatchObject({ status: 'requested', reviewReason: 'manual_review' });
      expect(JSON.stringify(withdrawal)).not.toContain('aml');
      expect(BigInt((await getWallet(page.request)).cash)).toBe(DEPOSIT - BigInt(amount));
    });
  } finally {
    const restored = await putPayments(original);
    expect(restored.ok(), await restored.text()).toBe(true);
    await adminContext.close();
  }

  const staff = await browser.newContext({ baseURL: ADMIN_URL });
  const staffPage = await staff.newPage();
  try {
    await test.step('compliance signs in and sees the compliance nav', async () => {
      await loginInBrowser(staffPage, 'compliance');
      const nav = staffPage.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Reconciliation' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'AML flags' })).toBeVisible();
    });

    await test.step('run reconciliation now (queued, run by the worker): the run is clean', async () => {
      await staffPage.goto(`${ADMIN_URL}/compliance/reconciliation`);
      // The API answers 202 with the queued request; the page polls it until the worker is done.
      const accepted = staffPage.waitForResponse(
        (response) =>
          response.url().endsWith('/admin/compliance/reconciliation-runs') &&
          response.request().method() === 'POST',
      );
      await staffPage.getByRole('button', { name: 'Run reconciliation now' }).click();
      const response = await accepted;
      expect(response.status()).toBe(202);
      const { request } = (await response.json()) as ReconciliationRequestResponse;
      expect(request.status).toBe('queued');
      expect(response.headers()['location']).toBe(
        `/admin/compliance/reconciliation-requests/${request.id}`,
      );
      await expect(staffPage.getByText('Run clean: 0 mismatches.')).toBeVisible({
        timeout: 60_000,
      });
      const polled = await staff.request.get(
        `${API_URL}/admin/compliance/reconciliation-requests/${request.id}`,
      );
      expect(((await polled.json()) as ReconciliationRequestResponse).request).toMatchObject({
        status: 'done',
        runId: request.id,
      });
      const runs = await staff.request.get(
        `${API_URL}/admin/compliance/reconciliation-runs?limit=1`,
      );
      const [latest] = ((await runs.json()) as ReconciliationRunListResponse).items;
      expect(latest).toMatchObject({
        id: request.id,
        kind: 'manual',
        status: 'clean',
        mismatchCount: 0,
      });
      expect(latest!.checks.every((check) => check.ok)).toBe(true);
      await staffPage.getByRole('link', { name: 'Open the run' }).click();
      await expect(staffPage.getByRole('heading', { name: 'Reconciliation run' })).toBeVisible();
    });

    await test.step("the player's deposit-then-withdraw flag is in the AML list", async () => {
      const flagsResponse = await staff.request.get(
        `${API_URL}/admin/compliance/aml-flags?userId=${userId}`,
      );
      expect(flagsResponse.ok(), await flagsResponse.text()).toBe(true);
      const flags = ((await flagsResponse.json()) as AmlFlagListResponse).items;
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({
        rule: 'deposit_then_withdraw',
        severity: 'high',
        status: 'open',
        source: 'withdrawal',
      });

      await staffPage.goto(`${ADMIN_URL}/compliance/aml`);
      const row = staffPage.getByRole('row').filter({ hasText: userId.slice(0, 8) });
      await expect(row).toContainText(/deposit then withdraw/i);
      await expect(row).toContainText('high');
      await staffPage.goto(`${ADMIN_URL}/compliance/aml/${flags[0]!.id}`);
      await expect(staffPage.getByText(withdrawalId.slice(0, 8)).first()).toBeVisible();
    });
  } finally {
    await staff.close();
  }
});
