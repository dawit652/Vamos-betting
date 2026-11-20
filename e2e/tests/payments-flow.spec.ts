import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { EventSummary } from '@vamos/contracts';
import { getWallet, myBets, soonestEvents } from '../support/api';
import { WEB_URL } from '../support/env';
import { birr, typedBirr } from '../support/money';
import { devInbox } from '../support/otp';
import { devApproveWithdrawal, myWithdrawals, paymentOptions } from '../support/payments';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { balanceChip, pick, registerAndVerify } from '../support/ui';

/**
 * The Phase 6 money flow, end to end against the real stack (demo mode, mock
 * payment provider): register and verify, submit KYC, deposit through the
 * wallet page and approve it on the simulated phone, meet the wagering
 * requirement with real bets that the fast simulator settles, request a
 * withdrawal, approve it with the dev back-office stand-in and watch the
 * worker pay it out.
 *
 * Why the bets look the way they do. Every deposit must be staked once
 * (wagering multiplier 1x) and the stake leaves the balance, so a player can
 * only withdraw what they WIN. To make that deterministic, the player backs
 * every outcome of one event's main market (2 or 3 singles of equal stake S,
 * deposit = outcomes x S): exactly one wins, odds are at least 1.01, so the
 * balance afterwards is at least S. The withdrawal is S, which is not below
 * the auto-approval threshold (S is the threshold), so it waits for review.
 *
 * Needs the same worker as the bet flow (SIM_SPEED=60, rolling fixtures every
 * minute) plus the payouts / sms queues, which the worker always runs. Nothing
 * is faked: the deposit is credited by the signed mock webhook, the bets are
 * settled by the simulator's results and the payout is sent by the worker.
 */

/** The legs must still be prematch when the last single is placed. */
const MIN_LEAD_MS = 100_000;
const MAX_LEAD_MS = 5 * 60_000;
const FIND_EVENT_MS = 90_000;
/** After the last kick-off: the match itself (seconds), result, outbox and settlement. */
const SETTLE_GRACE_MS = 75_000;
/** Worker pays an approved withdrawal within seconds (payouts queue; sweep every 15 s). */
const PAYOUT_MS = 60_000;
/** Sign-up, KYC, deposits and the checks around them, before the event is chosen. */
const SETUP_MS = 120_000;
/** Placing the bets, withdrawing and the checks around them. */
const UI_MARGIN_MS = 150_000;

test.describe.configure({ mode: 'serial' });
// A step that cannot find its element fails after 20 s, not after the whole test budget.
test.use({ actionTimeout: 20_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

/** A test phone the mock provider pays at once (not ending 0000 = fails, 9999 = pending). */
function payablePhone(): string {
  for (;;) {
    const phone = randomPhone();
    if (!phone.endsWith('0000') && !phone.endsWith('9999')) return phone;
  }
}

/** A 12-digit Fayda FIN the mock registry verifies (not ending 0000 = unknown, 9999 = review). */
function verifiableFayda(): string {
  for (;;) {
    const fin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    if (!fin.endsWith('0000') && !fin.endsWith('9999')) return fin;
  }
}

/** Places one single of `stake` santim on the `index`-th selection of the event's main market. */
async function placeSingle(
  page: Page,
  event: EventSummary,
  index: number,
  stake: bigint,
): Promise<string> {
  await page.goto(`/event/${event.id}`);
  // The first open accordion holds the main market (1X2, money line or winner).
  const buttons = page
    .locator('main details[open]:not(.rail-panel)')
    .first()
    .locator('button.odds-btn:enabled');
  await expect(buttons).toHaveCount(event.mainMarket!.selections.length);
  await pick(buttons.nth(index));
  await page.getByRole('button', { name: 'Betslip: 1 selections' }).click();

  const slip = page.getByRole('dialog');
  await expect(slip.getByText('Betslip', { exact: true }).first()).toBeVisible();
  await slip.getByLabel('Stake (ETB)', { exact: true }).fill(typedBirr(stake.toString()));
  // A prematch price can drift between opening the page and placing: take any price.
  await slip.getByLabel('If odds change').selectOption('any');
  const place = slip.getByRole('button', { name: `Place bet · ETB ${birr(stake.toString())}` });
  await expect(place).toBeEnabled({ timeout: 15_000 });
  await expect(slip.getByText('Net payout', { exact: true }).locator('xpath=../dd')).toHaveText(
    /^ETB \d/,
  );
  await place.click();

  await expect(slip.getByText('Bet placed')).toBeVisible({ timeout: 15_000 });
  const idText = await slip.getByText(/^Bet ID: /).textContent();
  const shortId = (idText ?? '').replace('Bet ID: ', '').trim();
  expect(shortId).toMatch(/^[A-Z0-9]{8}$/);
  await expect(slip.getByRole('status')).toHaveText('Accepted');
  await slip.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(slip).toBeHidden();
  return shortId;
}

test('KYC, deposit, wager, withdraw, approve and see it paid', async ({
  page,
  context,
  request,
}) => {
  const startedAt = Date.now();
  test.setTimeout(SETUP_MS + FIND_EVENT_MS + UI_MARGIN_MS);
  const phone = payablePhone();
  const timings: string[] = [];
  const lap = (name: string, from: number) => timings.push(`${name} ${Date.now() - from} ms`);

  const options = await paymentOptions(request);
  expect(options.demo).toBe(true);
  // The mock provider comes first, so it is the default (the stack also runs the simulated SMS rail).
  expect(options.providers[0]?.name).toBe('mock');
  const { minDeposit, minWithdrawal, autoApproveBelow } = options.limits;
  // S: the stake on each outcome, and the withdrawal. Not below auto-approval, so it is reviewed.
  const stake =
    BigInt(autoApproveBelow) > BigInt(minWithdrawal)
      ? BigInt(autoApproveBelow)
      : BigInt(minWithdrawal);

  await test.step('register and verify the phone', async () => {
    const t0 = Date.now();
    await registerAndVerify(page, phone);
    lap('register', t0);
  });

  await test.step('withdrawing is blocked before KYC (the rules say so)', async () => {
    await page.goto('/wallet/withdraw');
    await expect(page.getByText('Verify your identity first.')).toBeVisible();
  });

  await test.step('submit KYC (mock Fayda registry) and get verified', async () => {
    const t0 = Date.now();
    await page.goto('/account/kyc');
    const fin = verifiableFayda();
    await page.locator('#kyc-id').fill(fin);
    await page.locator('#kyc-name').fill('Abebe Kebede');
    await page.locator('#kyc-dob').fill(ADULT_DATE_OF_BIRTH);
    await page.getByRole('button', { name: 'Submit for verification' }).click();
    await expect(
      page.getByText(`Your identity is verified (ID ending in ${fin.slice(-4)}).`),
    ).toBeVisible();
    lap('kyc', t0);
  });

  // The simulated phone: a second tab of the same browser (same session).
  const phoneTab = await context.newPage();

  await test.step('a deposit declined on the simulated phone adds nothing', async () => {
    await page.goto('/wallet/deposit');
    await expect(page.locator('#deposit-provider')).toHaveValue('mock');
    await page.locator('#deposit-amount').fill(typedBirr(minDeposit));
    await page.getByRole('button', { name: `Deposit ETB ${birr(minDeposit)}` }).click();
    await expect(page.getByText('Waiting for approval')).toBeVisible();

    await phoneTab.goto('/dev/phone');
    await expect(phoneTab.getByText('Simulated phone').first()).toBeVisible();
    await expect(phoneTab.getByText(`Pay ETB ${birr(minDeposit)}`)).toBeVisible({
      timeout: 15_000,
    });
    await phoneTab.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(phoneTab.getByText(/^Declined\./)).toBeVisible();

    await page.bringToFront();
    await expect(page.getByText('The payment was declined on your phone.')).toBeVisible({
      timeout: 20_000,
    });
    expect((await getWallet(page.request)).cash).toBe('0');
    await page.getByRole('button', { name: 'Make another deposit' }).click();
  });

  const events = await soonestEvents(page.request, 1, {
    minLeadMs: MIN_LEAD_MS + 45_000, // the deposit below takes about this long
    maxLeadMs: MAX_LEAD_MS,
    timeoutMs: FIND_EVENT_MS,
  });
  const event = events[0]!;
  const outcomes = event.mainMarket!.selections.length;
  const deposit = stake * BigInt(outcomes);

  await test.step(`deposit ETB ${birr(deposit.toString())}, approve with the PIN on /dev/phone`, async () => {
    const t0 = Date.now();
    await page.locator('#deposit-amount').fill(typedBirr(deposit.toString()));
    await page.getByRole('button', { name: `Deposit ETB ${birr(deposit.toString())}` }).click();
    await expect(page.getByText('Waiting for approval')).toBeVisible();

    await phoneTab.bringToFront();
    // The tab polls for pushes; the declined one is gone, the new one arrives.
    await expect(phoneTab.getByText(`Pay ETB ${birr(deposit.toString())}`)).toBeVisible({
      timeout: 15_000,
    });
    // A wrong PIN is refused and nothing is credited.
    await phoneTab.getByLabel('PIN', { exact: true }).fill('0000');
    await phoneTab.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(phoneTab.getByText('Wrong PIN. Try again.')).toBeVisible();
    expect((await getWallet(page.request)).cash).toBe('0');

    await phoneTab.getByLabel('PIN', { exact: true }).fill('1234');
    await phoneTab.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(phoneTab.getByText(/^Approved\./)).toBeVisible();

    await page.bringToFront();
    await expect(
      page.getByText(`ETB ${birr(deposit.toString())} was added to your balance.`),
    ).toBeVisible({ timeout: 20_000 });
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(deposit.toString())}`,
    );
    expect((await getWallet(page.request)).cash).toBe(deposit.toString());
    lap('deposit', t0);
  });

  await test.step('the withdrawal is refused until the deposit has been bet', async () => {
    const remaining = (await myWithdrawals(page.request)).wageringRemaining;
    expect(remaining).toBe(deposit.toString());
    await page.goto('/wallet/withdraw');
    const text = `Bet ETB ${birr(remaining)} more before you can withdraw.`;
    await expect(page.getByText(text)).toBeVisible(); // the rules card
    await page.locator('#withdraw-amount').fill(typedBirr(stake.toString()));
    await page.getByRole('button', { name: `Withdraw ETB ${birr(stake.toString())}` }).click();
    await expect(page.getByText(text)).toHaveCount(2); // ...and the API's refusal
    expect((await myWithdrawals(page.request)).items).toHaveLength(0);
  });

  const lastKickOff = Date.parse(event.startTime);
  console.log(
    `event kicks off in ${Math.round((lastKickOff - Date.now()) / 1000)} s (${event.sport}, ${outcomes} outcomes)`,
  );
  test.setTimeout(
    Date.now() -
      startedAt +
      Math.max(0, lastKickOff - Date.now()) +
      SETTLE_GRACE_MS +
      PAYOUT_MS +
      UI_MARGIN_MS,
  );

  const shortIds: string[] = [];
  await test.step(`back every outcome with a single of ETB ${birr(stake.toString())}`, async () => {
    const t0 = Date.now();
    for (let index = 0; index < outcomes; index += 1) {
      shortIds.push(await placeSingle(page, event, index, stake));
    }
    expect(Date.now()).toBeLessThan(lastKickOff); // still prematch when the last one went in
    expect((await getWallet(page.request)).cash).toBe('0');
    // The stakes count as wagered at once: the requirement is met before settlement.
    expect((await myWithdrawals(page.request)).wageringRemaining).toBe('0');
    lap('bets', t0);
  });

  const settled =
    await test.step('wait for the simulator and the worker to settle them', async () => {
      const waitMs = Math.max(0, lastKickOff - Date.now()) + SETTLE_GRACE_MS;
      let bets: Awaited<ReturnType<typeof myBets>> = [];
      await expect
        .poll(
          async () => {
            bets = await myBets(page.request, 'settled');
            return bets.length;
          },
          { timeout: waitMs, intervals: [2000] },
        )
        .toBe(outcomes);
      expect(bets.map((bet) => bet.shortId).sort()).toEqual([...shortIds].sort());
      console.log(`settled: ${bets.map((bet) => `${bet.status} ${bet.settledNet}`).join(', ')}`);
      return bets;
    });

  const cashBefore =
    await test.step('exactly one outcome won, so the balance covers a withdrawal', async () => {
      expect(settled.filter((bet) => bet.status === 'won')).toHaveLength(1);
      const winnings = settled.reduce((sum, bet) => sum + BigInt(bet.settledNet ?? '0'), 0n);
      expect(winnings).toBeGreaterThanOrEqual(stake);
      const cash = (await getWallet(page.request)).cash;
      expect(cash).toBe(winnings.toString());
      return BigInt(cash);
    });

  let withdrawalId = '';
  await test.step(`request a withdrawal of ETB ${birr(stake.toString())}: it waits for review`, async () => {
    const t0 = Date.now();
    await page.goto('/wallet/withdraw');
    await expect(page.getByText('You have bet your deposits at least once.')).toBeVisible();
    await page.locator('#withdraw-amount').fill(typedBirr(stake.toString()));
    await page.getByRole('button', { name: `Withdraw ETB ${birr(stake.toString())}` }).click();
    await expect(page.getByText(/^Withdrawal requested\./)).toBeVisible();

    const card = page.getByRole('listitem').filter({ hasText: `To ${phone}` });
    await expect(card).toContainText(`ETB ${birr(stake.toString())}`);
    await expect(card).toContainText('Waiting for staff review because of the amount.');
    await expect(card.getByRole('button', { name: 'Cancel withdrawal' })).toBeVisible();

    // The amount is held at once.
    const held = cashBefore - stake;
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(held.toString())}`,
    );
    const [withdrawal] = (await myWithdrawals(page.request)).items;
    expect(withdrawal).toMatchObject({ status: 'requested', amount: stake.toString(), phone });
    withdrawalId = withdrawal!.id;
    lap('withdrawal request', t0);
  });

  await test.step('staff approve it (dev back-office stand-in)', async () => {
    // `request` has no cookies: it is the staff side, not the player.
    const approved = await devApproveWithdrawal(request, withdrawalId);
    expect(approved.id).toBe(withdrawalId);
    expect(['approved', 'processing', 'paid']).toContain(approved.status);
  });

  await test.step('the tracker shows it paid and the balance stays reduced', async () => {
    const t0 = Date.now();
    const card = page.getByRole('listitem').filter({ hasText: `To ${phone}` });
    // The page refreshes open withdrawals every 8 s; the worker pays within seconds.
    const steps = card.getByRole('list', { name: 'Withdrawal progress' }).getByRole('listitem');
    await expect(steps).toHaveCount(4);
    await expect(steps.filter({ hasText: 'Paid' })).toContainText('✓', { timeout: PAYOUT_MS });
    for (const label of ['Requested', 'Approved', 'Processing']) {
      await expect(steps.filter({ hasText: label })).toContainText('✓');
    }
    // The status chip and the last step both read "Paid".
    await expect(card.getByText('Paid', { exact: true })).toHaveCount(2);
    await expect(card.getByRole('button', { name: 'Cancel withdrawal' })).toHaveCount(0);
    lap('payout', t0);

    const [paid] = (await myWithdrawals(page.request)).items;
    expect(paid).toMatchObject({ id: withdrawalId, status: 'paid' });
    const expected = cashBefore - stake;
    expect((await getWallet(page.request)).cash).toBe(expected.toString());
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(expected.toString())}`,
    );
  });

  await test.step('the player got both payment SMS', async () => {
    await expect
      .poll(async () => (await devInbox(page.request, phone)).map((sms) => sms.template), {
        timeout: 20_000,
      })
      .toEqual(expect.arrayContaining(['deposit_succeeded', 'withdrawal_paid']));
  });

  console.log(`payments flow timings: ${timings.join(', ')}; total ${Date.now() - startedAt} ms`);
});
