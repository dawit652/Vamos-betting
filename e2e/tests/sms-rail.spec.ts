import { randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import type { DepositView } from '@vamos/contracts';
import { getWallet } from '../support/api';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { birr, typedBirr } from '../support/money';
import { myDeposits, paymentOptions } from '../support/payments';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { loginInBrowser } from '../support/staff';
import { balanceChip, registerAndVerify } from '../support/ui';

/**
 * The SMS deposit rail (ported from Melabingo), simulated: the stack runs
 * PAYMENT_PROVIDERS=mock,sms in demo mode, and the dev SMS simulator plays
 * the bank by sending the confirmation SMS the collection handset would
 * forward. Walks a player through an exact-amount deposit, a payment from
 * someone else's phone that staff credit from the SMS rail page, the
 * "I paid" check, and saving a bank account in their own name with the SMS
 * code. (Manual payouts under four eyes are covered by the API tests.)
 */

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

async function staffContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
}

function verifiableFayda(): string {
  for (;;) {
    const fin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    if (!fin.endsWith('0000') && !fin.endsWith('9999')) return fin;
  }
}

async function latestDeposit(request: Parameters<typeof myDeposits>[0]): Promise<DepositView> {
  const [deposit] = (await myDeposits(request)).items;
  if (deposit === undefined) throw new Error('no deposit');
  return deposit;
}

test('deposit by exact-amount transfer, staff credit a third-party payment, save a bank account', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  const options = await paymentOptions(request);
  expect(options.smsRail?.mode).toBe('simulated');
  const phone = randomPhone();

  await test.step('register, verify and pass KYC', async () => {
    await registerAndVerify(page, phone);
    await page.goto('/account/kyc');
    const fin = verifiableFayda();
    await page.locator('#kyc-id').fill(fin);
    await page.locator('#kyc-name').fill('Abebe Kebede');
    await page.locator('#kyc-dob').fill(ADULT_DATE_OF_BIRTH);
    await page.getByRole('button', { name: 'Submit for verification' }).click();
    await expect(page.getByText(/Your identity is verified/)).toBeVisible();
  });

  let first: DepositView;
  await test.step('open a transfer deposit: the exact amount, the account and the dial code', async () => {
    await page.goto('/wallet/deposit');
    await page.locator('#deposit-provider').selectOption('sms');
    await expect(page.locator('#deposit-phone')).toHaveCount(0);
    await page.locator('#deposit-amount').fill('100');
    await page.getByRole('button', { name: 'Deposit ETB 100.00' }).click();
    await expect(page.getByText(/^Send exactly ETB [\d,.]+$/)).toBeVisible();
    first = await latestDeposit(page.request);
    expect(first.transfer?.requestedAmount).toBe('10000');
    const send = first.transfer!.sendAmount;
    await expect(page.getByText(`Send exactly ETB ${birr(send)}`, { exact: true })).toBeVisible();
    await expect(page.getByText('0900000000')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Dial *127#' })).toHaveAttribute(
      'href',
      'tel:*127%23',
    );
  });

  await test.step('the bank sends the SMS (simulator): credited within seconds', async () => {
    await page.getByRole('button', { name: 'Pay the exact amount' }).click();
    const send = first.transfer!.sendAmount;
    await expect(page.getByText(`ETB ${birr(send)} was added to your balance.`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(balanceChip(page)).toHaveAttribute('aria-label', `Balance: ETB ${birr(send)}`);
    expect((await getWallet(page.request)).cash).toBe(send);
  });

  let second: DepositView;
  await test.step('a payment from someone else’s phone waits for staff', async () => {
    await page.getByRole('button', { name: 'Make another deposit' }).click();
    await page.locator('#deposit-provider').selectOption('sms');
    await page.locator('#deposit-amount').fill('200');
    await page.getByRole('button', { name: 'Deposit ETB 200.00' }).click();
    await expect(page.getByText(/^Send exactly ETB 200\.\d{2}$/)).toBeVisible();
    second = await latestDeposit(page.request);
    await page.getByRole('button', { name: 'Pay from another phone' }).click();
    await expect(page.getByText(/staff are checking this payment/)).toBeVisible({
      timeout: 15_000,
    });
    expect((await getWallet(page.request)).cash).toBe(first.transfer!.sendAmount);
  });

  await test.step('the "I paid" check does not credit an unknown reference', async () => {
    await page.locator('#deposit-check').fill('ZZ12345678');
    await page.getByRole('button', { name: 'Check my payment' }).click();
    await expect(page.getByText(/No payment with that reference has reached us yet/)).toBeVisible();
  });

  const staff = await staffContext(browser);
  const staffPage = await staff.newPage();
  try {
    await test.step('finance credits the flagged SMS from the SMS rail page', async () => {
      await loginInBrowser(staffPage, 'finance');
      await staffPage.goto(`${ADMIN_URL}/sms`);
      const row = staffPage
        .getByRole('row')
        .filter({ hasText: 'flagged' })
        .filter({ hasText: birr(second.transfer!.sendAmount) });
      await expect(row).toHaveCount(1);
      await row.getByRole('button', { name: 'Credit to player' }).click();
      await row.getByLabel('Note').fill('The player’s sister paid; confirmed by phone.');
      await row.getByRole('button', { name: /^Credit/ }).click();
      await expect(row).toHaveCount(0, { timeout: 15_000 });
    });
  } finally {
    await staff.close();
  }

  await test.step('the player’s balance includes both payments', async () => {
    const total = BigInt(first.transfer!.sendAmount) + BigInt(second.transfer!.sendAmount);
    await expect
      .poll(async () => (await getWallet(page.request)).cash, { timeout: 15_000 })
      .toBe(total.toString());
  });

  await test.step('save a bank account in the KYC name with the SMS code', async () => {
    await page.goto('/wallet/withdraw');
    await page.locator('#withdraw-provider').selectOption('sms');
    await expect(page.getByLabel(`Your phone wallet (${phone})`)).toBeChecked();
    await page.getByRole('button', { name: 'Add a bank account' }).click();
    await page.locator('#payout-bank').selectOption('cbe');
    await page.locator('#payout-account').fill('1000123456789');
    await page.locator('#payout-name').fill('Someone Else');
    await page.getByRole('button', { name: 'Save and send the code' }).click();
    await expect(
      page.getByText('The account must be in your own name, as on your ID.'),
    ).toBeVisible();
    await page.locator('#payout-name').fill('ABEBE KEBEDE');
    await page.getByRole('button', { name: 'Save and send the code' }).click();
    const demoCode = page.getByText(/^Demo code: \d{6}$/);
    await expect(demoCode).toBeVisible();
    const code = ((await demoCode.textContent()) ?? '').replace('Demo code: ', '').trim();
    await page.locator('#payout-code').fill(code);
    await page.getByRole('button', { name: 'Confirm the account' }).click();
    await expect(page.getByLabel(/Commercial Bank of Ethiopia · 1000123456789/)).toBeEnabled();
  });

  await test.step('deposited money is not withdrawn: only winnings (owner, 21 Nov)', async () => {
    await page.locator('#withdraw-amount').fill(typedBirr('5000'));
    await page.getByRole('button', { name: 'Withdraw ETB 50.00' }).click();
    await expect(page.getByText(/only winnings can be withdrawn/).last()).toBeVisible();
  });

  await test.step('a transfer deposit through the second institution shows its account', async () => {
    const methods = options.smsRail?.methods ?? [];
    expect(methods.map((m) => m.institution).slice(0, 2)).toEqual(['telebirr', 'cbe']);
    await page.goto('/wallet/deposit');
    await page.locator('#deposit-provider').selectOption('sms');
    await page.locator('#deposit-institution').selectOption('cbe');
    await page.locator('#deposit-amount').fill('200');
    await page.getByRole('button', { name: 'Deposit ETB 200.00' }).click();
    await expect(page.getByText(/^Send exactly ETB [\d,.]+$/)).toBeVisible();
    await expect(page.getByText('1000000000000')).toBeVisible();
    await expect(page.getByText('0900000000')).toHaveCount(0);
  });
});
