import { devices, expect, test, type Page } from '@playwright/test';
import { getEventDetail, upcomingEvents } from '../support/api';
import { WEB_URL } from '../support/env';
import { pick } from '../support/ui';

/**
 * The redesigned player app's own behaviour: the theme switch, the market chips
 * of the event page, the list controls (starts within, day, country, 1X2 /
 * double chance), search, and the two homes of the betslip (the drawer behind
 * the slip bar on a phone, the docked column on a wide screen). None of it
 * needs a player: no registration, no money.
 */

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

/** The first odds button of the page's list that can be picked (not suspended). */
function firstOpenOdds(page: Page) {
  return page.locator('main button.odds-btn:not([disabled])').first();
}

/** The first football match with an open main market, from the API. */
async function firstFootballEvent(page: Page) {
  const event = (await upcomingEvents(page.request)).find(
    (e) => e.sport === 'football' && e.mainMarket?.status === 'open',
  );
  expect(event, 'the feed offers a football match').toBeDefined();
  return event!;
}

test('the theme switch (in the footer on a phone) applies at once and survives a reload', async ({
  page,
}) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const themeColor = page.locator('meta[name="theme-color"]');
  const darkColor = await themeColor.getAttribute('content');

  // Only one of the two toggles (header from `sm` up, footer below) is displayed.
  // The first click can land before React hydrates the button, so it is retried.
  await expect(async () => {
    const toLight = page.getByRole('button', { name: 'Switch to the light theme' });
    if (await toLight.isVisible()) await toLight.click();
    await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Switch to the dark theme' })).toBeVisible();
  await expect(themeColor).not.toHaveAttribute('content', darkColor ?? '');

  // The choice is a cookie the server reads: the page is light from its first byte.
  const reloaded = await page.request.get('/');
  expect(await reloaded.text()).toContain('data-theme="light"');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
});

test('market chips narrow the event page to one section, and market search filters', async ({
  page,
}) => {
  // The chips exist only for a match with market-factory groups (the Main section alone has
  // none). The stack's mock feed does not publish any yet, so this test skips until it does.
  const football = (await upcomingEvents(page.request)).filter((e) => e.sport === 'football');
  let grouped: string | undefined;
  for (const candidate of football.slice(0, 10)) {
    const detail = await getEventDetail(page.request, candidate.id);
    if (detail.markets.some((m) => m.group !== undefined)) {
      grouped = candidate.id;
      break;
    }
  }
  test.skip(grouped === undefined, 'no football match of the feed has market-factory groups');
  await page.goto(`/event/${grouped}`);

  const chips = page.getByRole('group', { name: 'Filter markets' });
  await expect(chips).toBeVisible();
  const all = chips.getByRole('button', { name: 'All', exact: true });
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  const sections = page.locator('section[data-section]');
  const total = await sections.count();
  expect(total).toBeGreaterThan(1);

  // Chips are client state: retry until hydration has attached the handler.
  const fullTime = chips.getByRole('button', { name: 'Full time', exact: true });
  await expect(async () => {
    await fullTime.click();
    await expect(fullTime).toHaveAttribute('aria-pressed', 'true', { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await expect(all).toHaveAttribute('aria-pressed', 'false');
  await expect(sections).toHaveCount(1);
  await expect(sections.first()).toHaveAttribute('data-section', 'full_time');
  // The chosen section opens by itself and lists its markets.
  await expect(sections.first().getByRole('button', { expanded: true })).toBeVisible();
  await expect(sections.first().locator('button.odds-btn').first()).toBeVisible();

  await all.click();
  await expect(sections).toHaveCount(total);

  // The search box matches market names; nothing matching says so.
  await page.getByRole('searchbox', { name: 'Search markets' }).fill('zzqqzz');
  await expect(page.getByText('No markets match your search.')).toBeVisible();
  await expect(sections).toHaveCount(0);
});

test('on a phone a pick shows the slip bar, which opens the betslip drawer', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.slip-bar')).toHaveCount(0);
  await pick(firstOpenOdds(page));

  const bar = page.getByRole('button', { name: /^Betslip: 1 / });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Odds');
  await expect(bar).toContainText('Net pay');
  await bar.click();

  const drawer = page.getByRole('dialog', { name: 'Betslip' });
  await expect(drawer).toBeVisible();
  // The drawer's code arrives lazily; its text must be real text, not message keys.
  await expect(drawer.getByText('Single', { exact: true })).toBeVisible();
  await expect(drawer.getByLabel('Stake (ETB)')).toBeVisible();
  await expect(drawer).not.toContainText('sportsbook.betslip.');
  await expect(bar).toBeHidden();

  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();
  await expect(bar).toBeVisible();
  await expect(firstOpenOdds(page)).toHaveAttribute('aria-pressed', 'true');
});

test('the betslip drawer is in Amharic for an Amharic page', async ({ page, context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'am', url: WEB_URL }]);
  await page.goto('/');
  await pick(firstOpenOdds(page));
  await page.locator('button.slip-bar').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('የውርርድ ወረቀት');
  await expect(drawer).not.toContainText('sportsbook.betslip.');
});

test('Today has no day chips; Upcoming has 30 days, scrolled sideways, a day is ?day=', async ({
  page,
}) => {
  // Today is today alone (owner, 23 Nov 2026): no Tomorrow, weekday or date chips.
  await page.goto('/?tab=today');
  await expect(page.getByRole('navigation', { name: 'Match day' })).toHaveCount(0);

  await page.goto('/?tab=upcoming');
  const days = page.getByRole('navigation', { name: 'Match day' });
  await expect(days.getByRole('link')).toHaveCount(30);
  // The whole 30 days are listed until a day is chosen.
  await expect(days.locator('[aria-current="true"]')).toHaveCount(0);

  await days.getByRole('link', { name: 'Tomorrow' }).click();
  await page.waitForURL(/[?&]day=\d{4}-\d{2}-\d{2}/);
  await expect(days.getByRole('link', { name: 'Tomorrow' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  // Still the Upcoming tab.
  await expect(
    page.getByRole('navigation', { name: 'Match lists' }).getByRole('link', { name: 'Upcoming' }),
  ).toHaveAttribute('aria-current', 'page');
  // Every row that is listed kicks off tomorrow (there may be none: then the list says so).
  const rows = page.locator('main li.list-row');
  if ((await rows.count()) > 0) {
    await expect(rows.filter({ hasText: 'Tomorrow' })).toHaveCount(await rows.count());
  } else {
    await expect(page.getByText('No matches to show right now.')).toBeVisible();
  }

  // A day that is not offered falls back to the whole 30 days.
  await page.goto('/?tab=upcoming&day=2020-01-01');
  await expect(
    page.getByRole('navigation', { name: 'Match day' }).locator('[aria-current="true"]'),
  ).toHaveCount(0);
});

test('starts-within chips toggle, and day chips are gone from Highlights', async ({ page }) => {
  await page.goto('/?tab=highlights');
  await expect(page.getByRole('navigation', { name: 'Match day' })).toHaveCount(0);
  const within = page.getByRole('navigation', { name: 'Starts within' });
  await expect(within.getByRole('link')).toHaveText(['1h', '3h', '6h', '12h', '24h']);

  await within.getByRole('link', { name: '24h' }).click();
  await page.waitForURL(/[?&]within=24/);
  await expect(within.getByRole('link', { name: '24h' })).toHaveAttribute('aria-current', 'true');
  // The window is a list of its own: no featured poster.
  await expect(page.getByRole('region', { name: /Featured/ })).toHaveCount(0);

  // The active chip is a toggle: a second click drops the filter.
  await within.getByRole('link', { name: '24h' }).click();
  await expect(page).not.toHaveURL(/within=/);
  await expect(within.getByRole('link', { name: '24h' })).not.toHaveAttribute('aria-current');
});

test('a country chip lists only that country, All clears it', async ({ page }) => {
  await page.goto('/?tab=upcoming');
  const countries = page.getByRole('navigation', { name: 'Country' });
  await expect(countries.getByRole('link', { name: 'All' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const chips = countries.getByRole('link');
  expect(await chips.count()).toBeGreaterThan(2);
  const chip = chips.nth(1);
  // The chip is a flag emoji (aria-hidden) and the country's name.
  const name = (await chip.innerText()).trim().replace(/^\P{L}+/u, '');
  await chip.click();
  await page.waitForURL(/[?&]country=/);
  await expect(countries.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current');

  // Every league card on the page belongs to that country ("Country · League").
  const summaries = page.locator('main details:not(.rail-panel) > summary');
  await expect(summaries.first()).toBeVisible();
  await expect(summaries.filter({ hasNotText: name })).toHaveCount(0);

  await countries.getByRole('link', { name: 'All' }).click();
  await expect(page).not.toHaveURL(/country=/);
});

test('football rows switch to double chance, and the pick lands on the slip', async ({ page }) => {
  await page.goto('/?tab=upcoming');
  const market = page.getByRole('navigation', { name: 'Market' });
  await expect(market.getByRole('link', { name: '1X2' })).toHaveAttribute('aria-current', 'true');
  await expect(firstOpenOdds(page)).toHaveAccessibleName(/, Match Result, /);

  await market.getByRole('link', { name: 'Double chance' }).click();
  await page.waitForURL(/[?&]market=dc/);
  await expect(market.getByRole('link', { name: 'Double chance' })).toHaveAttribute(
    'aria-current',
    'true',
  );

  const button = firstOpenOdds(page);
  await expect(button).toHaveAccessibleName(/, Double Chance, /);
  await pick(button);
  await page.locator('button.slip-bar').click();
  await expect(page.getByRole('dialog', { name: 'Betslip' })).toContainText('Double Chance');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  // The choice follows the tabs; other sports have no switch.
  await page
    .getByRole('navigation', { name: 'Match lists' })
    .getByRole('link', { name: 'Today' })
    .click();
  // Today is the default tab (owner, 23 Nov 2026): no tab in the URL, the market kept.
  await page.waitForURL(/^(?!.*tab=).*market=dc/);
  await page.goto('/sport/basketball');
  await expect(page.getByRole('navigation', { name: 'Market' })).toHaveCount(0);
});

test('search finds a coming match by team name, and says so when nothing matches', async ({
  page,
}) => {
  const event = await firstFootballEvent(page);
  const team = event.home.name.en;

  await page.goto('/');
  await page.getByRole('link', { name: 'Search teams and leagues' }).click();
  await page.waitForURL('**/search');
  // A plain GET form: it works as soon as the page is there.
  const box = page.getByRole('searchbox', { name: 'Team or league' });
  await box.fill(team.toLowerCase());
  await box.press('Enter');
  await page.waitForURL(/\/search\?q=/);
  await expect(page.locator(`main a[href="/event/${event.id}"]`).first()).toBeVisible();
  await expect(page.locator('main li.list-row').filter({ hasText: team }).first()).toBeVisible();

  await page.goto('/search?q=a');
  await expect(page.getByRole('status')).toHaveText('Type at least 2 letters to search.');
  await page.goto('/search?q=zzqqzz');
  await expect(page.getByRole('status')).toHaveText(
    'Nothing found for "zzqqzz". Try another spelling.',
  );
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
    // The header carries the navigation (the phone's bottom bar becomes header links).
    await expect(page.getByRole('banner').getByRole('link', { name: 'Live' })).toBeVisible();

    await pick(firstOpenOdds(page));
    await expect(dock.getByText('Single', { exact: true })).toBeVisible();
    await expect(dock.getByLabel('Stake (ETB)')).toBeVisible();
    await expect(dock).not.toContainText('sportsbook.betslip.');
    // No slip bar and no drawer here: the slip is already on screen.
    await expect(page.locator('button.slip-bar')).toBeHidden();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the theme switch sits in the header', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(async () => {
      await page
        .getByRole('banner')
        .getByRole('button', { name: 'Switch to the light theme' })
        .click();
      await expect(html).toHaveAttribute('data-theme', 'light', { timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Switch to the dark theme' }),
    ).toBeVisible();
  });
});
