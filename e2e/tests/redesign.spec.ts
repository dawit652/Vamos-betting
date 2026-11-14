import { devices, expect, test, type Page } from '@playwright/test';
import { WEB_URL } from '../support/env';
import { pick } from '../support/ui';

/**
 * The redesigned player app's own behaviour: the theme switch, the market
 * filter chips of the event page, and the two homes of the betslip (the drawer
 * behind the slip bar on a phone, the docked column on a wide screen). The
 * betslip checks also cover its text, which pages no longer carry: it loads
 * with the drawer (BetslipMessages).
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
