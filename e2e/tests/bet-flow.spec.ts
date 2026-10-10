import { expect, test, type Locator, type Page } from '@playwright/test';
import { getWallet, myBets, soonestEvents } from '../support/api';
import { WEB_URL } from '../support/env';
import { birr } from '../support/money';
import { readOtp } from '../support/otp';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';

/**
 * The Phase 5 MVP flow, end to end against the real stack: register, verify
 * with the OTP from the dev SMS inbox, add play money, build a 3-leg
 * accumulator, place it, then let the fast simulator play the matches and the
 * worker settle the bet, and check the balance and My Bets.
 *
 * Needs the worker in fast mode (SIM_SPEED=60, FEED_ROLLING_EVERY_MINUTES=1,
 * FEED_ROLLING_HORIZON_MINUTES=10): a rolling fixture then kicks off every
 * minute and a match lasts a few seconds. Nothing is faked: settlement comes
 * from the simulator's results through the outbox and the settlement queue.
 */

const TOP_UP = '100000'; // ETB 1,000 in santim
const STAKE = '5000'; // ETB 50 in santim
/** The legs must still be prematch when the slip is placed (~20 s of UI work). */
const MIN_LEAD_MS = 60_000;
/** ...and kick off soon, so the whole test stays well under its timeout. */
const MAX_LEAD_MS = 4 * 60_000;
/** After the last kick-off: the match itself (seconds), result, outbox and settlement. */
const SETTLE_GRACE_MS = 90_000;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  // English UI so the selectors read naturally; Amharic stays the app's default.
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

/** The balance chip in the header ("Balance: ETB 1,000.00"). */
function balanceChip(page: Page): Locator {
  return page.getByRole('banner').getByRole('link', { name: /^Balance: ETB / });
}

/**
 * Clicks until the odds button reports it is on the slip. The first click can
 * land before React hydrates the button, so it is retried; a click that did
 * register is never repeated (that would take the pick off again).
 */
async function pick(button: Locator): Promise<void> {
  await expect(async () => {
    if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
}

test('register, top up, place a 3-leg multi and see it settled', async ({ page }) => {
  test.setTimeout(330_000);
  const phone = randomPhone();

  await test.step('register and verify with the OTP from the dev SMS inbox', async () => {
    await page.goto('/register');
    await page.locator('#reg-phone').fill(phone);
    await page.locator('#reg-password').fill('e2e-secret-123');
    await page.locator('#reg-dob').fill(ADULT_DATE_OF_BIRTH);
    await page.locator('input[name="acceptTerms"]').check();
    await page.getByRole('button', { name: 'Register', exact: true }).click();

    await page.waitForURL('**/verify');
    const code = await readOtp(page.request, phone);
    await page.locator('#otp-code').fill(code);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();

    // A new player lands on the wallet with a welcome note.
    await page.waitForURL(/\/wallet\?welcome=1$/);
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 0.00');
  });

  await test.step('add ETB 1,000 of play money', async () => {
    await page.getByRole('radio', { name: '1,000', exact: true }).click();
    await page.getByRole('button', { name: `Add ETB ${birr(TOP_UP)}` }).click();
    await expect(page.getByText('ETB 1,000.00 of play money was added.')).toBeVisible();
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 1,000.00');
    expect((await getWallet(page.request)).cash).toBe(TOP_UP);
  });

  const events = await soonestEvents(page.request, 3, {
    minLeadMs: MIN_LEAD_MS,
    maxLeadMs: MAX_LEAD_MS,
  });
  const lastKickOff = Math.max(...events.map((event) => Date.parse(event.startTime)));
  console.log(
    'legs kick off in ' +
      events
        .map(
          (event) =>
            `${Math.round((Date.parse(event.startTime) - Date.now()) / 1000)} s (${event.sport})`,
        )
        .join(', '),
  );

  await test.step('add one pick from each of 3 events kicking off soon', async () => {
    for (const [index, event] of events.entries()) {
      await page.goto(`/event/${event.id}`);
      // The first open accordion holds the main market (1X2, money line or winner).
      const button = page.locator('main details[open] button.odds-btn:enabled').first();
      await pick(button);
      await expect(
        page.getByRole('button', { name: `Betslip: ${index + 1} selections` }),
      ).toBeVisible();
    }
  });

  let shortId = '';
  await test.step('place the accumulator from the betslip', async () => {
    await page.getByRole('button', { name: 'Betslip: 3 selections' }).click();
    const slip = page.getByRole('dialog');
    await expect(slip.getByText('Betslip', { exact: true }).first()).toBeVisible();
    await slip
      .getByRole('group', { name: 'Quick stakes' })
      .getByRole('button', { name: '50', exact: true })
      .click();

    const place = slip.getByRole('button', { name: `Place bet · ETB ${birr(STAKE)}` });
    const accept = slip.getByRole('button', { name: 'Accept odds' });
    await expect(place.or(accept)).toBeVisible();
    // A prematch price can drift between choosing and placing.
    if (await accept.isVisible()) await accept.click();
    await expect(place).toBeEnabled({ timeout: 15_000 });
    await place.click();

    await expect(slip.getByText('Bet placed')).toBeVisible({ timeout: 15_000 });
    const idText = await slip.getByText(/^Bet ID: /).textContent();
    shortId = (idText ?? '').replace('Bet ID: ', '').trim();
    expect(shortId).toMatch(/^[A-Z0-9]{8}$/);
    await expect(slip.getByRole('status')).toHaveText('Accepted');
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 950.00');
  });

  await test.step('see the bet under My Bets (open)', async () => {
    await page.getByRole('dialog').getByRole('link', { name: 'My Bets' }).click();
    await page.waitForURL('**/my-bets');
    const card = page.locator('article').filter({ hasText: `Bet ${shortId}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Multi (3)');
    await expect(card).toContainText('Open');
    const open = await myBets(page.request, 'open');
    expect(open.map((bet) => bet.shortId)).toContain(shortId);
  });

  const settledBet = await test.step('wait for the simulator to finish the matches', async () => {
    const waitMs = Math.max(0, lastKickOff - Date.now()) + SETTLE_GRACE_MS;
    let settled: Awaited<ReturnType<typeof myBets>>[number] | undefined;
    await expect
      .poll(
        async () => {
          settled = (await myBets(page.request, 'settled')).find((bet) => bet.shortId === shortId);
          return settled?.status ?? 'not settled yet';
        },
        { timeout: waitMs, intervals: [2000] },
      )
      .toMatch(/^(won|lost|void)$/);
    return settled!;
  });

  await test.step('balance and My Bets (settled) show the result', async () => {
    const expected = BigInt(TOP_UP) - BigInt(STAKE) + BigInt(settledBet.settledNet ?? '0');
    expect((await getWallet(page.request)).cash).toBe(expected.toString());

    await page.goto('/my-bets?tab=settled');
    const card = page.locator('article').filter({ hasText: `Bet ${shortId}` });
    await expect(card).toBeVisible();
    const label = { won: 'Won', lost: 'Lost', void: 'Void' }[
      settledBet.status as 'won' | 'lost' | 'void'
    ];
    await expect(card.locator('header')).toContainText(label);
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(expected.toString())}`,
    );

    await page.goto('/my-bets');
    await expect(page.getByText('You have no open bets.')).toBeVisible();
  });
});
