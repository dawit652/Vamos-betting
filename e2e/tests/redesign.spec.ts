import { devices, expect, test, type Page } from '@playwright/test';
import { upcomingEvents } from '../support/api';
import { WEB_URL } from '../support/env';
import { loginApi } from '../support/staff';
import { pick } from '../support/ui';

/**
 * The redesigned player app's own behaviour: the theme switch, the market
 * filter chips of the event page, the list controls (day chips, 1X2 / double
 * chance), match search, the featured poster of a top match, and the two homes
 * of the betslip (the drawer behind the slip bar on a phone, the docked column
 * on a wide screen). The betslip checks also cover its text, which pages no
 * longer carry: it loads with the drawer (BetslipMessages).
 */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

/** The first odds button of the home list that can be picked (not suspended). */
function firstOpenOdds(page: Page) {
  return page.locator('main button.odds-btn:not([disabled])').first();
}

test('the theme switch applies at once and survives a reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const themeColor = page.locator('meta[name="theme-color"]');
  const darkColor = await themeColor.getAttribute('content');

  // The first click can land before React hydrates the button, so it is retried.
  await expect(async () => {
    const toLight = page.getByRole('button', { name: 'Switch to the light theme' });
    if (await toLight.isVisible()) await toLight.click();
    await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Switch to the dark theme' })).toBeVisible();
  await expect(themeColor).not.toHaveAttribute('content', darkColor ?? '');

  // The choice is a cookie the server reads: the reloaded page is light from its first byte.
  const reloaded = await page.request.get('/');
  expect(await reloaded.text()).toContain('data-theme="light"');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Switch to the dark theme' })).toBeVisible();
});

test('market filter chips show only the chosen kind of market', async ({ page }) => {
  await page.goto('/');
  await page.locator('main a[href^="/event/"]').first().click();
  await page.waitForURL(/\/event\//);

  const filter = page.getByRole('group', { name: 'Market type' });
  await expect(filter).toBeVisible();
  const groups = page.locator('.market-groups > details');
  const total = await groups.count();
  expect(total).toBeGreaterThan(1);
  await expect(filter.getByRole('radio', { name: 'All' })).toBeChecked();

  // Every chip but "All" narrows the list to its own category, and to at least one market.
  const chips = await filter.getByRole('radio').all();
  expect(chips.length).toBeGreaterThan(2);
  for (const chip of chips) {
    const category = await chip.getAttribute('value');
    if (category === 'all') continue;
    await chip.check({ force: true }); // the input is visually hidden inside its label
    const shown = page.locator('.market-groups > details:visible');
    await expect(shown).toHaveCount(
      await page.locator(`.market-groups > details[data-cat="${category}"]`).count(),
    );
    expect(await shown.count()).toBeGreaterThan(0);
    expect(await shown.count()).toBeLessThan(total);
  }

  await filter.getByRole('radio', { name: 'All' }).check({ force: true });
  await expect(page.locator('.market-groups > details:visible')).toHaveCount(total);
});

test('on a phone a pick shows the slip bar, which opens the betslip drawer', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.slip-bar')).toHaveCount(0);
  await pick(firstOpenOdds(page));

  const bar = page.getByRole('button', { name: /^Betslip: 1 selection/ });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Total odds');
  await bar.click();

  const drawer = page.getByRole('dialog', { name: 'Betslip' });
  await expect(drawer).toBeVisible();
  // The drawer's own text arrives with the drawer, not with the page.
  await expect(drawer.getByText('Single', { exact: true })).toBeVisible();
  await expect(drawer.getByLabel('Stake (ETB)')).toBeVisible();
  await expect(drawer).not.toContainText('sportsbook.betslip.');
  await expect(bar).toBeHidden();

  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  await expect(bar).toBeVisible();
});

test('the betslip drawer is in Amharic for an Amharic page', async ({ page, context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'am', url: WEB_URL }]);
  await page.goto('/');
  await pick(firstOpenOdds(page));
  await page.locator('.slip-bar').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('የውርርድ ወረቀት');
  await expect(drawer).not.toContainText('sportsbook.betslip.');
});

test('the Today tab has day chips; a later day lists only that day', async ({ page }) => {
  await page.goto('/?tab=today');
  const days = page.getByRole('navigation', { name: 'Day' });
  await expect(days.getByRole('link')).toHaveCount(7);
  await expect(days.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');

  await days.getByRole('link', { name: 'Tomorrow' }).click();
  await page.waitForURL(/[?&]day=\d{4}-\d{2}-\d{2}/);
  await expect(days.getByRole('link', { name: 'Tomorrow' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Still the Today tab; every row of the list kicks off tomorrow.
  await expect(
    page.getByRole('navigation', { name: 'Match lists' }).getByRole('link', { name: 'Today' }),
  ).toHaveAttribute('aria-current', 'page');
  const rows = page.locator('main li.list-row');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await expect(rows.filter({ hasText: 'Tomorrow' })).toHaveCount(count);

  // A day that is not offered falls back to today.
  await page.goto('/?tab=today&day=2020-01-01');
  await expect(days.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
});

test('football rows switch to double chance, and the pick lands on the slip', async ({ page }) => {
  await page.goto('/?tab=upcoming');
  const market = page.getByRole('navigation', { name: 'Odds shown' });
  await expect(market.getByRole('link', { name: '1X2' })).toHaveAttribute('aria-current', 'page');
  await market.getByRole('link', { name: 'Double chance' }).click();
  await page.waitForURL(/[?&]market=dc/);
  await expect(market.getByRole('link', { name: 'Double chance' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const button = firstOpenOdds(page);
  await expect(button).toHaveAccessibleName(/, Double Chance, /);
  await pick(button);
  await page.locator('.slip-bar').click();
  await expect(page.getByRole('dialog', { name: 'Betslip' })).toContainText('Double Chance');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // The choice follows the tabs and the next page; other sports have no switch.
  await page
    .getByRole('navigation', { name: 'Match lists' })
    .getByRole('link', { name: 'Today' })
    .click();
  await page.waitForURL(/tab=today.*market=dc/);
  await page.goto('/sport/basketball');
  await expect(page.getByRole('navigation', { name: 'Odds shown' })).toHaveCount(0);
});

test('search finds a coming match by team name and by Game ID', async ({ page }) => {
  const [event] = (await upcomingEvents(page.request)).filter((e) => e.sport === 'football');
  expect(event).toBeDefined();
  const team = event!.home.name.en;

  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sports' })
    .getByRole('link', { name: 'Search' })
    .click();
  await page.waitForURL('**/search');
  const box = page.getByRole('searchbox', { name: 'Team, league or game ID' });
  // Hydration can reset an input typed into too early: retry until the value sticks.
  await expect(async () => {
    await box.fill(team.toLowerCase());
    await expect(box).toHaveValue(team.toLowerCase(), { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await box.press('Enter');
  await page.waitForURL(/\/search\?q=/);
  await expect(page.locator('main li.list-row').filter({ hasText: team }).first()).toBeVisible();
  await expect(page.locator(`main a[href="/event/${event!.id}"]`).first()).toBeVisible();

  await page.goto(`/search?q=${event!.gameId}`);
  await expect(page.locator('main li.list-row')).toHaveCount(1);
  await expect(page.locator(`main a[href="/event/${event!.id}"]`).first()).toBeVisible();

  await page.goto('/search?q=zzqqzz');
  await expect(page.getByRole('status')).toHaveText('No live or coming match found for "zzqqzz".');
});

test('a match a trader marks as top match becomes the featured poster', async ({
  page,
  playwright,
}) => {
  // A football match far enough ahead that it is still open for the whole test.
  const events = (await upcomingEvents(page.request)).filter(
    (e) =>
      e.sport === 'football' &&
      e.mainMarket?.status === 'open' &&
      Date.parse(e.startTime) - Date.now() > 30 * 60_000,
  );
  const event = events.at(-1);
  expect(event).toBeDefined();
  const title = `${event!.home.name.en} v ${event!.away.name.en}`;

  const staffRequest = await playwright.request.newContext();
  const trader = await loginApi(staffRequest, 'trader');
  const poster = page.getByRole('region', { name: 'Featured' });
  try {
    expect((await trader.post(`/admin/trading/events/${event!.id}/top`, { top: true })).ok()).toBe(
      true,
    );
    await expect(async () => {
      await page.goto('/');
      await expect(poster.locator(`a[href="/event/${event!.id}"]`)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    // The poster's odds buttons are for this match.
    await expect(poster.locator('button.odds-btn').first()).toHaveAccessibleName(
      new RegExp(`, ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `),
    );
  } finally {
    await trader.post(`/admin/trading/events/${event!.id}/top`, { top: false });
    await staffRequest.dispose();
  }
});

test.describe('on a wide screen', () => {
  // Same browser as the phone profile, with a desktop viewport and no touch.
  test.use({
    viewport: devices['Desktop Chrome'].viewport,
    userAgent: devices['Desktop Chrome'].userAgent,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  });

  test('the betslip is a docked column and picks land in it without a tap', async ({ page }) => {
    await page.goto('/');
    const dock = page.getByRole('region', { name: 'Betslip' });
    await expect(dock).toBeVisible();
    await expect(dock).toContainText('Your betslip is empty. Tap any odds to add a selection.');
    // The header carries the navigation; the phone's bottom bar is gone.
    await expect(page.getByRole('banner').getByRole('link', { name: 'Live' })).toBeVisible();

    await pick(firstOpenOdds(page));
    await expect(dock.getByText('Single', { exact: true })).toBeVisible();
    await expect(dock.getByLabel('Stake (ETB)')).toBeVisible();
    await expect(dock).not.toContainText('sportsbook.betslip.');
    // No slip bar and no drawer here: the slip is already on screen.
    await expect(page.locator('.slip-bar')).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
