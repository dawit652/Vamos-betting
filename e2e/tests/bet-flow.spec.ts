import { expect, test } from '@playwright/test';
import { getWallet, myBets, soonestEvents } from '../support/api';
import { WEB_URL } from '../support/env';
import { birr } from '../support/money';
import { randomPhone } from '../support/phone';
import { balanceChip, pick, registerAndVerify } from '../support/ui';

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
const SETTLE_GRACE_MS = 75_000;
/** How long to wait for the feed to offer 3 such events (one rolling fixture a minute). */
const FIND_EVENTS_MS = 90_000;
/** Sign-up and top-up, before the events are chosen. */
const SIGN_UP_MS = 60_000;
/** Picking, placing and the checks around them, besides waiting for kick-off and settlement. */
const UI_MARGIN_MS = 90_000;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  // English UI so the selectors read naturally; Amharic stays the app's default.
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

test('register, top up, place a 3-leg multi and see it settled', async ({ page }) => {
  // The budget is set in two steps so a slow feed fails with the poll's own
  // message instead of a bare test timeout: enough to sign up and find the
  // events first, then, once the last kick-off is known, exactly the time
  // still needed (kick-off + SETTLE_GRACE_MS + the UI work around it).
  const startedAt = Date.now();
  test.setTimeout(SIGN_UP_MS + FIND_EVENTS_MS + UI_MARGIN_MS);
  const phone = randomPhone();

  await test.step('register and verify with the OTP from the dev SMS inbox', async () => {
    await registerAndVerify(page, phone);
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
    timeoutMs: FIND_EVENTS_MS,
  });
  const lastKickOff = Math.max(...events.map((event) => Date.parse(event.startTime)));
  test.setTimeout(
    Date.now() - startedAt + Math.max(0, lastKickOff - Date.now()) + SETTLE_GRACE_MS + UI_MARGIN_MS,
  );
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

    // A prematch price can drift (every 30 s) between opening an event page and
    // placing: take any price, so the result does not depend on that timing.
    await slip.getByLabel('If odds change').selectOption('any');

    const place = slip.getByRole('button', { name: `Place bet · ETB ${birr(STAKE)}` });
    // Place is enabled once the quote for these legs and this stake is in.
    await expect(place).toBeEnabled({ timeout: 15_000 });
    const netPayout = slip.getByText('Net payout', { exact: true }).locator('xpath=../dd');
    await expect(netPayout).toHaveText(/^ETB \d/);
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
    console.log(`bet ${shortId} settled ${settled!.status}, net payout ${settled!.settledNet}`);
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
