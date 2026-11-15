import { expect, test } from '@playwright/test';
import {
  createDevJackpotRound,
  getJackpotEntry,
  getJackpotRound,
  getWallet,
  myJackpotEntries,
} from '../support/api';
import { WEB_URL } from '../support/env';
import { birr } from '../support/money';
import { randomPhone } from '../support/phone';
import { balanceChip, pick, registerAndVerify } from '../support/ui';

/**
 * The Phase 8 jackpot flow, end to end against the real stack: register,
 * verify, add play money, open a small 3-game round through the demo-only dev
 * route (POST /dev/jackpots/rounds: the next scheduled football events), pick
 * outcomes on /jackpot with double and triple picks (18 combinations), place the entry
 * and see the balance drop by its cost. The round closes at its first
 * kick-off, the fast simulator plays the games, the worker settles the round
 * through the outbox and the entry shows up settled in My Bets (Jackpot tab)
 * with its correct count and prize; the balance matches the API.
 *
 * Needs the same worker settings as bet-flow.spec.ts (SIM_SPEED=60, a rolling
 * fixture every minute).
 */

const TOP_UP = '100000'; // ETB 1,000 in santim
const COST = '18000'; // 2 x 3 x 3 = 18 combinations x ETB 10
/** The entry has to be placed before the first game kicks off (~20 s of UI work). */
const LEAD_SECONDS = 50;
/** After the last kick-off: the match itself (seconds), result, outbox and settlement. */
const SETTLE_GRACE_MS = 90_000;
/** Sign-up and top-up, before the round is opened. */
const SIGN_UP_MS = 60_000;
/** Waiting for the feed to offer 3 upcoming football events (one rolling fixture a minute). */
const FIND_EVENTS_MS = 150_000;
/** Picking, placing and the checks around them, besides waiting for kick-off and settlement. */
const UI_MARGIN_MS = 90_000;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

test('place a jackpot entry with a double pick and see it settled', async ({ page, request }) => {
  const startedAt = Date.now();
  test.setTimeout(SIGN_UP_MS + FIND_EVENTS_MS + UI_MARGIN_MS);
  const phone = randomPhone();

  await test.step('register, verify and add ETB 1,000 of play money', async () => {
    await registerAndVerify(page, phone);
    await page.getByRole('radio', { name: '1,000', exact: true }).click();
    await page.getByRole('button', { name: `Add ETB ${birr(TOP_UP)}` }).click();
    await expect(page.getByText('ETB 1,000.00 of play money was added.')).toBeVisible();
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 1,000.00');
    expect((await getWallet(page.request)).cash).toBe(TOP_UP);
  });

  // The dev route needs the signed-in player's session.
  const round = await createDevJackpotRound(page.request, {
    games: 3,
    leadSeconds: LEAD_SECONDS,
    timeoutMs: FIND_EVENTS_MS,
  });
  const lastKickOff = Math.max(...round.games.map((game) => Date.parse(game.startTime)));
  test.setTimeout(
    Date.now() - startedAt + Math.max(0, lastKickOff - Date.now()) + SETTLE_GRACE_MS + UI_MARGIN_MS,
  );
  console.log(
    `round ${round.id}: closes in ${Math.round((Date.parse(round.closesAt) - Date.now()) / 1000)} s, ` +
      `last game kicks off in ${Math.round((lastKickOff - Date.now()) / 1000)} s`,
  );
  expect(round.status).toBe('open');
  expect(round.gameCount).toBe(3);
  expect(round.costPerCombination).toBe('1000');

  // Picks: a double pick on game 1, every outcome of games 2 and 3. Whatever the
  // results, 2 games are always right, so the entry always wins a prize (the
  // jackpot itself when game 1 is right too): the payout path gets exercised.
  const picks = [
    ['1', 'X'],
    ['1', 'X', '2'],
    ['1', 'X', '2'],
  ] as const;
  const outcomeName = { '1': 'Home win', X: 'Draw', '2': 'Away win' } as const;
  const gameButton = (position: number, outcome: '1' | 'X' | '2') => {
    const game = round.games[position]!;
    return page.getByRole('button', {
      name: `${game.homeTeam.en} v ${game.awayTeam.en}: ${outcomeName[outcome]}`,
      exact: true,
    });
  };

  // Other rounds may be open too (the worker's own, earlier runs): ours holds these games.
  const roundCard = page
    .locator('article')
    .filter({ has: gameButton(0, '1') })
    .filter({ has: gameButton(2, '2') });

  await test.step('pick outcomes on /jackpot: the combinations and cost follow', async () => {
    await page.goto('/jackpot?tab=daily9');
    await expect(page.getByRole('heading', { name: 'Jackpot', exact: true })).toBeVisible();
    await expect(roundCard).toHaveCount(1);
    const combinations = roundCard.getByTestId('jackpot-combinations');
    const cost = roundCard.getByTestId('jackpot-cost');
    // Only some games picked: nothing to pay yet.
    await pick(gameButton(0, '1'));
    await expect(combinations).toHaveText('0');
    await expect(roundCard.getByRole('button', { name: 'Place entry' })).toBeDisabled();

    await pick(gameButton(1, '1'));
    await pick(gameButton(2, '2'));
    await expect(combinations).toHaveText('1');
    await expect(cost).toHaveText(`ETB ${birr('1000')}`);

    await pick(gameButton(0, 'X'));
    await expect(combinations).toHaveText('2');
    await expect(cost).toHaveText(`ETB ${birr('2000')}`);

    await pick(gameButton(1, 'X'));
    await pick(gameButton(1, '2'));
    await expect(combinations).toHaveText('6');
    await pick(gameButton(2, '1'));
    await pick(gameButton(2, 'X'));
    await expect(combinations).toHaveText('18');
    await expect(cost).toHaveText(`ETB ${birr(COST)}`);
    await expect(gameButton(0, 'X')).toHaveAttribute('aria-pressed', 'true');
    await expect(gameButton(0, '2')).toHaveAttribute('aria-pressed', 'false');
  });

  const entryId =
    await test.step('place the entry and see the balance drop by its cost', async () => {
      await roundCard.getByRole('button', { name: 'Place entry' }).click();
      await expect(roundCard.getByText('Confirm your entry')).toBeVisible();
      await roundCard.getByRole('button', { name: `Confirm and pay ETB ${birr(COST)}` }).click();
      await expect(
        roundCard.getByText(`Entry placed. Good luck! ETB ${birr(COST)} was taken`),
      ).toBeVisible({ timeout: 15_000 });
      await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 820.00');
      expect((await getWallet(page.request)).cash).toBe((BigInt(TOP_UP) - BigInt(COST)).toString());

      const open = await myJackpotEntries(page.request, 'open');
      expect(open).toHaveLength(1);
      const entry = open[0]!;
      expect(entry.roundId).toBe(round.id);
      expect(entry.picks).toEqual(picks.map((outcomes) => [...outcomes]));
      expect(entry.combinations).toBe(18);
      expect(entry.cost).toBe(COST);
      expect(entry.status).toBe('open');
      return entry.id;
    });

  await test.step('see the open entry in My Bets (Jackpot tab)', async () => {
    await page.goto('/my-bets?tab=jackpot');
    const card = page.locator('article').filter({ hasText: 'Daily Jackpot' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('18 combinations');
    await expect(card.locator('header')).toContainText('Open');
    await expect(card).toContainText(`ETB ${birr(COST)}`);
  });

  const settled =
    await test.step('wait for the games to be played and the round settled', async () => {
      const waitMs = Math.max(0, lastKickOff - Date.now()) + SETTLE_GRACE_MS;
      await expect
        .poll(async () => (await getJackpotEntry(page.request, entryId)).status, {
          timeout: waitMs,
          intervals: [2000],
        })
        .toMatch(/^(won|lost|void)$/);
      return getJackpotEntry(page.request, entryId);
    });

  await test.step('the entry and the round agree with the results', async () => {
    const finished = await getJackpotRound(request, round.id);
    expect(finished.status).toBe('settled');
    expect(finished.games.every((game) => game.result !== null)).toBe(true);

    // Recount the 18 combinations against the results: how many have exactly
    // k games right (a cancelled game counts as correct for everyone).
    const results = finished.games.map((game) => game.result!);
    const distribution = [0n, 0n, 0n, 0n];
    for (const first of picks[0]) {
      for (const second of picks[1]) {
        for (const third of picks[2]) {
          const right = [first, second, third].filter(
            (outcome, index) => results[index] === 'cancelled' || results[index] === outcome,
          ).length;
          distribution[right]! += 1n;
        }
      }
    }
    const best = distribution.findLastIndex((count) => count > 0n);
    expect(best).toBeGreaterThanOrEqual(2);
    expect(settled.correct?.map(BigInt)).toEqual(distribution);
    expect(settled.bestCorrect).toBe(best);
    expect(settled.status).toBe('won');

    // The 3-game round pays 2 correct a fixed amount per combination and 3
    // correct the shared pool, which this entry alone takes (nobody else played).
    const tier = (correct: number) => finished.prizeTiers.find((t) => t.correct === correct)!;
    expect(tier(2).kind).toBe('fixed');
    expect(tier(3).kind).toBe('shared');
    const gross =
      distribution[2]! * BigInt(tier(2).amount) +
      (distribution[3]! > 0n ? BigInt(tier(3).amount) : 0n);
    expect(BigInt(settled.prizeGross!)).toBe(gross);
    expect(BigInt(settled.prizeTax!)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(settled.prizeNet!)).toBe(BigInt(gross) - BigInt(settled.prizeTax!));
    console.log(
      `entry ${entryId} won: ${results.join('/')}, best ${best} correct, ` +
        `prize ${settled.prizeGross} - tax ${settled.prizeTax} = ${settled.prizeNet}`,
    );
  });

  await test.step('the balance matches, and My Bets shows the settled entry', async () => {
    const expected = BigInt(TOP_UP) - BigInt(COST) + BigInt(settled.prizeNet ?? '0');
    expect((await getWallet(page.request)).cash).toBe(expected.toString());
    expect(await myJackpotEntries(page.request, 'open')).toHaveLength(0);

    await page.goto('/my-bets?tab=jackpot');
    const card = page.locator('article').filter({ hasText: 'Daily Jackpot' });
    await expect(card).toHaveCount(1);
    await expect(card.locator('header')).toContainText('Won');
    await expect(card).toContainText(`Best: ${settled.bestCorrect} correct`);
    for (const game of settled.games) {
      await expect(card).toContainText(`Result: ${game.result}`);
    }
    await expect(card).toContainText(`ETB ${birr(settled.prizeGross!)}`);
    await expect(card).toContainText(`ETB ${birr(settled.prizeNet!)}`);
    await expect(balanceChip(page)).toHaveAttribute(
      'aria-label',
      `Balance: ETB ${birr(expected.toString())}`,
    );

    // The recent rounds on /jackpot list the settled round with its results.
    await page.goto('/jackpot?tab=daily9');
    await expect(page.getByRole('heading', { name: 'Recent jackpots' })).toBeVisible();
  });
});
