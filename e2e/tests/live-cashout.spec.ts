import { expect, test } from '@playwright/test';
import type { BetView, EventSummary } from '@vamos/contracts';
import { getBet, getWallet, myBets, placeBetApi, upcomingEvents } from '../support/api';
import { API_URL, WEB_URL } from '../support/env';
import { birr } from '../support/money';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { balanceChip, registerAndVerify } from '../support/ui';

/**
 * Phase 7 end to end: a cash-out on a running bet, through the confirm sheet.
 *
 * With the fast simulator (SIM_SPEED=60) a match is live for about two
 * seconds, too short to click through a sheet while it is on. So the bet is
 * built to be cashed out as soon as a match has been played, which is the
 * situation cash-out exists for (a part of the bet is decided, the rest is
 * still to play):
 *
 * - match A kicks off in under two minutes, match B a few minutes later;
 * - one 2-leg accumulator per outcome of A's main market, each with the same
 *   pick on B. Exactly one outcome of A happens, so the simulator and the
 *   worker settle the others as lost and leave one bet open with a won leg;
 * - that bet's offer (the won leg counts at once, B is priced at its current
 *   odds) is shown in My Bets; the player cashes out through the sheet, and
 *   the card, the balance chip and the API all agree on the paid amount.
 *
 * Nothing is faked: results come from the simulator, settlement from the
 * worker, the cash-out from the real endpoint. A live-delta refresh of the
 * offers and the /me/stream push are exercised by the page while it waits.
 */

const TOP_UP = '100000'; // ETB 1,000
const STAKE = '5000'; // ETB 50 on each accumulator
/** Match A: late enough to place the bets while it is prematch, early enough to keep the test short. */
const A_MIN_LEAD_MS = 35_000;
const A_MAX_LEAD_MS = 110_000;
/** Match B starts well after A is over, but within the rolling feed's 10 minute horizon. */
const B_MIN_LEAD_MS = 200_000;
const B_MAX_LEAD_MS = 540_000;
const FIND_EVENTS_MS = 120_000;
const SIGN_UP_MS = 60_000;
/** After A's kick-off: the match (seconds), result, outbox, settlement. */
const SETTLE_GRACE_MS = 60_000;
const UI_MARGIN_MS = 90_000;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

function mainSelections(event: EventSummary) {
  return event.mainMarket!.selections;
}

/** A pair of events: A (soon) and B (later), both with an open main market. */
async function findMatches(
  request: Parameters<typeof upcomingEvents>[0],
  timeoutMs: number,
): Promise<{ a: EventSummary; b: EventSummary }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = Date.now();
    const open = (await upcomingEvents(request)).filter(
      (event) =>
        event.status === 'scheduled' &&
        event.mainMarket?.status === 'open' &&
        mainSelections(event).length > 0 &&
        mainSelections(event).every((selection) => selection.open),
    );
    const lead = (event: EventSummary) => Date.parse(event.startTime) - now;
    const a = open.find((event) => lead(event) >= A_MIN_LEAD_MS && lead(event) <= A_MAX_LEAD_MS);
    const b = open.find(
      (event) => event.id !== a?.id && lead(event) >= B_MIN_LEAD_MS && lead(event) <= B_MAX_LEAD_MS,
    );
    if (a && b) return { a, b };
    if (Date.now() > deadline) {
      throw new Error(
        `no pair of matches (one kicking off in ${A_MIN_LEAD_MS / 1000}-${A_MAX_LEAD_MS / 1000} s, ` +
          `one in ${B_MIN_LEAD_MS / 1000}-${B_MAX_LEAD_MS / 1000} s); is the worker running with ` +
          'FEED_ROLLING_EVERY_MINUTES=1?',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

test('cash out a running accumulator through the confirm sheet', async ({ page }) => {
  const startedAt = Date.now();
  test.setTimeout(SIGN_UP_MS + FIND_EVENTS_MS + UI_MARGIN_MS);
  const phone = randomPhone();

  await test.step('register, verify and add ETB 1,000 of play money', async () => {
    await registerAndVerify(page, phone, ADULT_DATE_OF_BIRTH);
    await page.getByRole('radio', { name: '1,000', exact: true }).click();
    await page.getByRole('button', { name: `Add ETB ${birr(TOP_UP)}` }).click();
    await expect(page.getByText('ETB 1,000.00 of play money was added.')).toBeVisible();
    expect((await getWallet(page.request)).cash).toBe(TOP_UP);
  });

  const { a, b } = await findMatches(page.request, FIND_EVENTS_MS);
  const aKickOff = Date.parse(a.startTime);
  test.setTimeout(
    Date.now() - startedAt + Math.max(0, aKickOff - Date.now()) + SETTLE_GRACE_MS + UI_MARGIN_MS,
  );
  console.log(
    `A (${a.sport}) kicks off in ${Math.round((aKickOff - Date.now()) / 1000)} s, ` +
      `B (${b.sport}) in ${Math.round((Date.parse(b.startTime) - Date.now()) / 1000)} s`,
  );

  const bets: BetView[] = [];
  await test.step('place one 2-leg accumulator per outcome of A (same pick on B)', async () => {
    const bPick = mainSelections(b)[0]!;
    for (const outcome of mainSelections(a)) {
      bets.push(
        await placeBetApi(
          page.request,
          [
            { selectionId: outcome.id, oddsMilli: outcome.oddsMilli },
            { selectionId: bPick.id, oddsMilli: bPick.oddsMilli },
          ],
          STAKE,
        ),
      );
    }
    for (const bet of bets) expect(bet.status).toBe('open');
    const stakes = BigInt(STAKE) * BigInt(bets.length);
    expect((await getWallet(page.request)).cash).toBe((BigInt(TOP_UP) - stakes).toString());
    // Before A is played every bet is cashable (prematch prices).
    for (const bet of bets) expect(bet.cashOutOffer?.available).toBe(true);
  });

  const survivor =
    await test.step('A is played: the losing accumulators settle, one stays open', async () => {
      let open: BetView | undefined;
      await expect
        .poll(
          async () => {
            const list = await myBets(page.request, 'open');
            open = list.length === 1 ? list[0] : undefined;
            return open?.legs.map((leg) => leg.state).join(',') ?? `${list.length} open`;
          },
          { timeout: Math.max(0, aKickOff - Date.now()) + SETTLE_GRACE_MS, intervals: [1000] },
        )
        .toBe('won,open');
      const lost = (await myBets(page.request, 'settled')).filter((bet) => bet.status === 'lost');
      expect(lost).toHaveLength(bets.length - 1);
      return open!;
    });

  let offerNet = '0';
  await test.step('My Bets offers to cash out the bet with the won leg', async () => {
    await page.goto('/my-bets');
    const card = page.locator('article').filter({ hasText: `Bet ${survivor.shortId}` });
    await expect(card).toBeVisible();
    await expect(page.locator('article')).toHaveCount(1);
    const button = card.getByRole('button', { name: /^Cash out ETB / });
    await expect(button).toBeVisible();
    const offer = await getBet(page.request, survivor.id).then((bet) => bet.cashOutOffer);
    expect(offer?.available).toBe(true);
    offerNet = offer!.net;
    // The offer is real money for a bet whose first leg has won.
    expect(BigInt(offer!.gross)).toBeGreaterThan(0n);
    expect(BigInt(offer!.gross) - BigInt(offer!.tax)).toBe(BigInt(offer!.net));
  });

  const cash = await getWallet(page.request).then((wallet) => BigInt(wallet.cash));

  await test.step('cash out through the confirm sheet', async () => {
    const card = page.locator('article').filter({ hasText: `Bet ${survivor.shortId}` });
    await card.getByRole('button', { name: /^Cash out ETB / }).click();

    const sheet = page.getByRole('dialog', { name: 'Cash out this bet' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Your stake')).toBeVisible();
    await expect(sheet.getByText('Cash-out value')).toBeVisible();
    await expect(sheet.getByText('You receive')).toBeVisible();

    // The offer follows the odds: whatever the sheet ends up confirming is paid.
    // A "changed" note asks for one more confirmation (the sheet shows the new amounts).
    const confirm = sheet.getByRole('button', { name: /^(Cash out|Accept) ETB / });
    await expect(async () => {
      if (await sheet.isVisible()) await confirm.click();
      await expect(sheet).toBeHidden({ timeout: 5000 });
    }).toPass({ timeout: 30_000 });
    expect(offerNet).not.toBe('0');
  });

  await test.step('the API, the balance and My Bets agree on what was paid', async () => {
    const paid = await getBet(page.request, survivor.id);
    expect(paid.status).toBe('cashed_out');
    expect(paid.cashedOut).not.toBeNull();
    const { gross, tax, net } = paid.cashedOut!;
    expect(BigInt(gross) - BigInt(tax)).toBe(BigInt(net));
    expect(BigInt(net)).toBeGreaterThan(0n);
    expect(paid.cashOutOffer).toBeNull();

    const expected = cash + BigInt(net);
    expect((await getWallet(page.request)).cash).toBe(expected.toString());
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(expected.toString())}`,
    );

    // Gone from Open (the list reacts to the response and the /me/stream push)...
    await expect(page.getByText('You have no open bets.')).toBeVisible();
    // ...and shown as cashed out under Settled.
    await page.goto('/my-bets?tab=settled');
    const card = page.locator('article').filter({ hasText: `Bet ${survivor.shortId}` });
    await expect(card).toBeVisible();
    await expect(card.locator('header')).toContainText('Cashed out');
    await expect(card.getByRole('button', { name: /^Cash out ETB / })).toHaveCount(0);
  });

  await test.step('a second cash-out of the same bet is refused', async () => {
    const response = await page.request.get(`${API_URL}/me/bets/${survivor.id}/cash-out`);
    expect(response.ok()).toBe(true);
    const offer = (await response.json()) as { available: boolean; reason: string | null };
    expect(offer.available).toBe(false);
    expect(offer.reason).toBe('bet_not_open');
  });
});
