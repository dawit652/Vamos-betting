import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { devices, expect, test } from '@playwright/test';
import { ADMIN_URL } from '../support/env';
import { loginInBrowser, staffApiOf } from '../support/staff';

/**
 * The scraper's back-office pages (/feed, /feed/review, /feed/review/[id], /feed/aliases) against the
 * real stack: a trader reads the overview and the review queue, opens the typed detail of a few item
 * kinds, walks the "Apply this result" confirm step without confirming, and dismisses one item with a
 * note. The data is seeded by `pnpm --filter @vamos/scraper-app seed:review <tag>` (demo mode only):
 * two sources, a competition, teams, events, an alias and one open review item of every kind, all
 * carrying the tag so a second run adds a second set.
 */

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

interface Seeded {
  tag: string;
  items: Record<string, string>;
  teams: Record<string, string>;
  names: { home: string; away: string };
  alias: { raw: string };
}

function seed(tag: string): Seeded {
  const output = execFileSync('pnpm', ['--filter', '@vamos/scraper-app', 'seed:review', tag], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    timeout: 90_000,
  });
  const line = output
    .trim()
    .split('\n')
    .reverse()
    .find((text) => text.startsWith('{'));
  if (line === undefined) throw new Error(`seed:review printed no JSON: ${output}`);
  return JSON.parse(line) as Seeded;
}

test('a trader reads the feed overview and review queue, inspects items and dismisses one with a note', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const tag = randomBytes(3).toString('hex');
  const data = seed(tag);

  const context = await browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
  const page = await context.newPage();
  try {
    await loginInBrowser(page, 'trader');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Feed' })).toBeVisible();

    await test.step('the overview lists the seeded sources, the queue counts and the competitions', async () => {
      await page.goto(`${ADMIN_URL}/feed`);
      await expect(page.getByRole('heading', { name: 'Feed', exact: true })).toBeVisible();
      const source = page.getByRole('row').filter({ hasText: `Seed fixtures ${tag}` });
      await expect(source).toContainText('openfootball');
      await expect(source).toContainText('ok');
      await expect(source.getByRole('button', { name: 'Disable' })).toBeVisible();
      const broken = page.getByRole('row').filter({ hasText: `Seed results ${tag}` });
      await expect(broken).toContainText('broken');
      await expect(page.getByRole('heading', { name: /^Review queue \(\d+ open\)/ })).toBeVisible();
      const league = page.getByRole('row').filter({ hasText: `Feed League ${tag}` });
      await expect(league.getByRole('button')).toHaveText(['on', 'off', 'on', 'off']);
      // A trader may switch a flag off, not on.
      await expect(league.getByRole('button', { name: 'off' }).first()).toBeDisabled();
    });

    await test.step('the queue lists the items of this run and filters by kind', async () => {
      await page.goto(`${ADMIN_URL}/feed/review?status=open&kind=result_ready`);
      await expect(page.getByRole('link', { name: `result ready [${tag}]` })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: `[${tag}]` })).toContainText(
        `${data.names.home} v ${data.names.away}: 2-1 (HT 1-0)`,
      );
      await expect(page.getByRole('link', { name: `fixture missing [${tag}]` })).toHaveCount(0);
    });

    await test.step('a result item shows its typed payload; applying asks to confirm the score', async () => {
      await page.getByRole('link', { name: `result ready [${tag}]` }).click();
      await page.waitForURL(`**/feed/review/${data.items.result_ready}`);
      await expect(page.getByText('Proposed score')).toBeVisible();
      await expect(page.getByText('2-1 (HT 1-0)').first()).toBeVisible();
      await expect(page.getByText('3 open bets, stake ETB 4,500.00')).toBeVisible();
      await page.getByRole('button', { name: 'Apply this result' }).click();
      await expect(
        page.getByText(`Apply ${data.names.home} 2-1 ${data.names.away}?`),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Confirm 2-1 (HT 1-0)' })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click(); // nothing is applied here
      await expect(page.getByRole('button', { name: 'Apply this result' })).toBeVisible();
    });

    await test.step('an unknown team shows its suggestions and the mapping form', async () => {
      await page.goto(`${ADMIN_URL}/feed/review/${data.items.unknown_team}`);
      await expect(page.getByText(`Gamma ${tag} Town (91%)`).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Map to this team' })).toBeVisible();
    });

    await test.step('dismissing needs a note, then the item is closed with it', async () => {
      const id = data.items.fixture_missing!;
      await page.goto(`${ADMIN_URL}/feed/review/${id}`);
      await expect(page.getByText(`A fixture of ${tag} vanished`)).toBeVisible();
      await page.getByRole('button', { name: 'Dismiss' }).click();
      await page.getByRole('button', { name: 'Dismiss' }).last().click();
      await expect(page.getByText('A reason is required.')).toBeVisible(); // empty note refused
      await page.getByLabel('Note (required)').fill('e2e: checked by hand');
      await page.getByRole('button', { name: 'Dismiss' }).last().click();
      await expect(page.getByText('Saved.')).toBeVisible();
      await expect(page.getByText('dismiss: e2e: checked by hand')).toBeVisible();

      const api = await staffApiOf(context.request);
      const response = await api.get(`/admin/feed/review/${id}`);
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as {
        item: { status: string; resolution: { decision: string; note: string } };
      };
      expect(body.item.status).toBe('dismissed');
      expect(body.item.resolution).toMatchObject({
        decision: 'dismiss',
        note: 'e2e: checked by hand',
      });
    });

    await test.step('the aliases page lists the seeded alias', async () => {
      await page.goto(`${ADMIN_URL}/feed/aliases`);
      await page.getByLabel('Name contains').fill(`alpha ${tag}`);
      await page.getByRole('button', { name: 'Filter' }).click();
      await expect(page.getByRole('row').filter({ hasText: `alpha ${tag} f c` })).toContainText(
        data.names.home,
      );
    });
  } finally {
    await context.close();
  }
});
