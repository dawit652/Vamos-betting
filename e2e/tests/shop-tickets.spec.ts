import { randomBytes, randomInt } from 'node:crypto';
import { devices, expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { soonestEvents } from '../support/api';
import { ADMIN_URL, API_URL } from '../support/env';
import { loginApi, loginInBrowser, staffApiOf } from '../support/staff';

/**
 * The shop app's ticket screens (docs/plans/agent-shops.md phase 3): a cashier with an open shift
 * sees the agent's top-up balance empty until HQ tops it up, sells an ETB 20 single from a Game ID
 * and the pick `1`, lands on the printable ticket (number and barcode, the original printed once),
 * cancels it inside the cancel window and sees CANCELLED; then sells a ticket from a 6-digit
 * booking code, which the ticket prints, and a visitor's slip ID with its stake in one press of
 * Sell and print (owner, 24 Nov 2026); last, this device's print settings. The agent, shop,
 * cashier and balance are created here, so the spec needs no other spec's data.
 */

const SHOP_URL = (
  process.env.E2E_SHOP_URL ??
  process.env.SHOP_URL ??
  'http://localhost:3002'
).replace(/\/$/, '');

test.use({ actionTimeout: 20_000 });

const phoneDigits = () => `09${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;

async function newContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL });
}

test('a cashier sells a ticket by Game ID, prints it with a barcode and cancels it', async ({
  browser,
}) => {
  const staff = await newContext(browser, ADMIN_URL);
  const financeContext = await newContext(browser, ADMIN_URL);
  const counter = await newContext(browser, SHOP_URL);
  await counter.addInitScript(() => {
    const w = window as unknown as { __prints: number };
    w.__prints = 0;
    window.print = () => {
      w.__prints += 1;
    };
  });
  const admin = await staff.newPage();
  const shop = await counter.newPage();
  const suffix = randomBytes(4).toString('hex');
  const agentName = `E2E Tickets ${suffix}`;
  const cashierEmail = `e2e-ticket-${suffix}@demo.vamos.test`;
  const givenPassword = `Given-${suffix}-pw!`;
  const ownPassword = `Own-${suffix}-counter-pw!`;
  let agentUrl: string | null = null;
  try {
    // The admin adds an agent, a shop and a cashier.
    await loginInBrowser(admin, 'admin');
    await admin
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Agents' })
      .click();
    const add = admin.getByRole('form', { name: 'Add an agent' });
    await add.getByLabel('Agent name').fill(agentName);
    await add.getByLabel("Owner's full name").fill('E2E Owner');
    await add.getByLabel("Owner's phone").fill(phoneDigits());
    await add.getByLabel('Commission based on').selectOption('ggr');
    await add.getByLabel('Commission percent').fill('10');
    await add.getByRole('button', { name: 'Add agent' }).click();
    await expect(
      admin.getByRole('heading', { name: new RegExp(`^Agent \\d+ – ${agentName}$`) }),
    ).toBeVisible();
    agentUrl = admin.url();
    const agentId = agentUrl.split('/').pop() ?? '';

    const shopForm = admin.getByRole('form', { name: 'Add a shop' });
    await shopForm.getByLabel('Shop name').fill('E2E Tickets Shop');
    await shopForm.getByLabel('Address').fill('Bole, Addis Ababa');
    await shopForm.getByRole('button', { name: 'Add shop' }).click();
    await expect(admin.getByRole('button', { name: 'Close shop' })).toBeVisible();

    await admin.getByRole('link', { name: 'Add a cashier' }).click();
    const form = admin.getByRole('form', { name: 'Add a staff account' });
    await form.getByLabel('Email').fill(cashierEmail);
    await form.getByLabel('Name', { exact: true }).fill(`E2E Ticket ${suffix}`);
    await form.getByLabel('Phone').fill(phoneDigits());
    await form.getByLabel('Password (optional)').fill(givenPassword);
    await form.getByRole('button', { name: 'Add account' }).click();
    const secret = admin.getByTestId('staff-secret');
    await expect(secret.getByText('They are shown only once.')).toBeVisible();
    await secret.getByRole('button', { name: 'Done' }).click();

    // The cashier's device: ask for approval, an admin approves.
    await shop.goto('/register-device');
    const askEmail = shop.getByLabel('Email');
    await expect(async () => {
      await askEmail.fill(cashierEmail);
      await expect(askEmail).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password').fill(givenPassword);
    await shop.getByLabel('Device name').fill(`Ticket PC ${suffix}`);
    await shop.getByRole('button', { name: /^Ask for approval/ }).click();
    await expect(shop.getByText(/^Asked\./)).toBeVisible();

    await admin.goto(agentUrl);
    const device = admin.getByTestId('agent-devices').getByRole('row', { name: /Ticket PC/ });
    admin.once('dialog', (dialog) => void dialog.accept());
    await device.getByRole('button', { name: 'Approve' }).click();
    await expect(device).toContainText('approved');

    // Sign in and choose an own password.
    await shop.goto('/login');
    const signInEmail = shop.getByLabel('Email');
    await expect(async () => {
      await signInEmail.fill(cashierEmail);
      await expect(signInEmail).toHaveValue(cashierEmail, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await shop.getByLabel('Password').fill(givenPassword);
    await shop.getByRole('button', { name: /^Sign in/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/password`);
    await shop.getByLabel('Current password').fill(givenPassword);
    await shop.getByLabel(/^New password ·/).fill(ownPassword);
    await shop.getByLabel('New password again').fill(ownPassword);
    await shop.getByRole('button', { name: /^Save password/ }).click();
    await expect(shop).toHaveURL(`${SHOP_URL}/`);

    // Open a shift.
    const open = shop.getByRole('form', { name: 'Open shift' });
    await open.getByLabel('Opening float').fill('500');
    await open.getByRole('button', { name: /^Open shift/ }).click();
    await expect(shop.getByTestId('shift-summary')).toContainText('ETB 500.00');
    await expect(shop.getByTestId('desk-tickets')).toContainText('No tickets in this shift yet.');
    // The agent's top-up balance is empty: no ticket can be sold until the owner tops up.
    await expect(shop.getByTestId('topup-card')).toHaveAttribute('data-state', 'empty');
    await expect(shop.getByTestId('topup-balance')).toHaveText('ETB 0.00');
    await expect(shop.getByTestId('topup-empty')).toContainText('no ticket can be sold');

    // The admin tops the agent up (finance approves: four eyes): the stake leaves this balance.
    const adminApi = await staffApiOf(staff.request);
    const topup = await adminApi.post(`/admin/agents/${agentId}/topups`, {
      direction: 'in',
      amount: '500000',
      method: 'cash',
    });
    expect(topup.ok()).toBe(true);
    const topupId = ((await topup.json()) as { topup: { id: string } }).topup.id;
    const financeApi = await loginApi(financeContext.request, 'finance');
    expect((await financeApi.post(`/admin/agent-topups/${topupId}/approve`)).ok()).toBe(true);

    // The admin's ticket-limits card shows the limits in force.
    await admin.goto(agentUrl);
    await expect(admin.getByTestId('ticket-limits-card')).toContainText('Maximum win per ticket');
    await expect(admin.getByTestId('ticket-limits-save')).toBeVisible();

    // A prematch football match (the match list shows football only) that kicks off in a minute
    // or more; window.print never opens a dialog.
    const [event] = await soonestEvents(counter.request, 1, {
      minLeadMs: 90_000,
      maxLeadMs: 10 * 60_000,
      timeoutMs: 90_000,
      sport: 'football',
    });
    expect(event!.mainMarket!.selections.find((s) => s.code === '1' && s.open)).toBeDefined();
    await shop
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Sell/ })
      .click();
    await expect(shop.getByTestId('sell-page')).toBeVisible();
    // Topped up with ETB 5,000, above HQ's low-balance threshold (ETB 1,000).
    await expect(shop.getByTestId('topup-card')).toHaveAttribute('data-state', 'ok');
    await expect(shop.getByTestId('topup-balance')).toHaveText('ETB 5,000.00');

    // The match list: search the home team; a pick adds that leg (removed again here).
    const panel = shop.getByTestId('matches-panel');
    await panel.getByTestId('matches-search').fill(event!.home.name.en);
    const listed = panel.getByTestId('match-row').filter({ hasText: `#${event!.gameId}` });
    await expect(listed).toHaveCount(1);
    await listed.getByTestId('match-pick').first().click();
    await expect(shop.getByTestId('slip-leg')).toHaveCount(1);
    await expect(shop.getByTestId('slip-leg')).toContainText(event!.gameId);
    await shop.getByTestId('leg-remove').click();
    await expect(shop.getByTestId('slip-leg')).toHaveCount(0);

    // Build the ticket from a Game ID and the pick 1, check it, sell it.
    await shop.getByTestId('pick-game').fill(event!.gameId);
    await shop.getByTestId('pick-code').fill('1');
    await shop.getByTestId('pick-add').click();
    const leg = shop.getByTestId('slip-leg');
    await expect(leg).toHaveCount(1);
    await expect(leg).toContainText(event!.gameId);
    await expect(shop.getByTestId('sell-submit')).toBeDisabled();
    await shop.getByTestId('slip-stake').fill('20');
    await shop.getByTestId('slip-check').click();
    await expect(shop.getByTestId('slip-net')).toContainText(/^ETB \d/);
    await expect(shop.getByTestId('sell-submit')).toBeEnabled();
    await shop.getByTestId('sell-submit').click();

    // The ticket page: the number, the barcode, the original printed once (no COPY).
    await expect(shop.getByTestId('ticket-page')).toBeVisible();
    await expect(shop).toHaveURL(/\/ticket\/[0-9a-f-]+\?print=1$/);
    const number = (await shop.getByTestId('ticket-number').textContent()) ?? '';
    expect(number).toMatch(/^[A-Z0-9]{8}$/);
    await expect(shop.getByTestId('ticket-barcode')).toBeVisible();
    await expect(shop.getByTestId('ticket-barcode')).toHaveAttribute('data-code', number);
    await expect(shop.getByTestId('ticket')).toContainText('ETB 20.00');
    await expect(shop.getByTestId('ticket')).toContainText(event!.gameId);
    await expect(shop.getByTestId('ticket-copy-badge')).toHaveCount(0);
    await expect
      .poll(() => shop.evaluate(() => (window as unknown as { __prints: number }).__prints))
      .toBe(1);

    // Cancel it from the ticket page (a reason prompt, then a confirmation): CANCELLED, no Print.
    shop.on('dialog', (dialog) => void dialog.accept());
    await shop.getByTestId('ticket-cancel').click();
    await expect(shop.getByTestId('ticket-cancelled')).toBeVisible();
    await expect(shop.getByTestId('ticket-print')).toHaveCount(0);
    await expect(shop.getByTestId('ticket-cancel')).toHaveCount(0);

    // The desk lists it as cancelled.
    await shop.getByRole('link', { name: 'Back to the desk' }).click();
    const row = shop.getByTestId('desk-tickets').getByRole('row', { name: new RegExp(number) });
    await expect(row).toContainText('Cancelled');

    // A player without an account made a 6-digit booking code online (owner, 21 Nov: G1 and G2):
    // the cashier types it as the player says it, sells it, and the ticket prints it.
    const home = event!.mainMarket!.selections.find((s) => s.code === '1')!;
    const made = await counter.request.post(`${API_URL}/booking-codes`, {
      data: { legs: [{ selectionId: home.id }] },
    });
    expect(made.status()).toBe(201);
    const bookingCode = ((await made.json()) as { code: string }).code;
    expect(bookingCode).toMatch(/^[1-9]\d{5}$/);
    const said = `${bookingCode.slice(0, 3)} ${bookingCode.slice(3)}`;
    await shop
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Sell/ })
      .click();
    await expect(shop.getByTestId('sell-page')).toBeVisible();
    await shop.getByTestId('booking-code').fill(said);
    await shop.getByTestId('booking-load').click();
    await expect(shop.getByTestId('slip-leg')).toHaveCount(1);
    await shop.getByTestId('slip-stake').fill('20');
    await shop.getByTestId('slip-check').click();
    await expect(shop.getByTestId('sell-submit')).toBeEnabled();
    await shop.getByTestId('sell-submit').click();
    await expect(shop.getByTestId('ticket-page')).toBeVisible();
    await expect(shop.getByTestId('ticket-booking-code')).toContainText(`Booking code`);
    await expect(shop.getByTestId('ticket-booking-code')).toContainText(said);

    // A visitor's slip ID keeps their stake (GS3): loaded, the ticket names the match, the market
    // and the pick at once, the stake is filled in, and one press of Sell and print checks and
    // sells (no separate Check).
    const guest = await counter.request.post(`${API_URL}/booking-codes`, {
      data: { legs: [{ selectionId: home.id }], stake: '3000' },
    });
    expect(guest.status()).toBe(201);
    const slipId = ((await guest.json()) as { code: string }).code;
    await shop
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Sell/ })
      .click();
    await expect(shop.getByTestId('sell-page')).toBeVisible();
    await expect(shop.getByTestId('sell-submit')).toBeDisabled();
    await expect(shop.getByTestId('sell-hint')).toContainText('Add a match');
    await shop.getByTestId('booking-code').fill(slipId);
    await shop.getByTestId('booking-load').click();
    const loaded = shop.getByTestId('slip-leg');
    await expect(loaded).toHaveCount(1);
    await expect(loaded.getByTestId('slip-leg-match')).toHaveText(
      `${event!.home.name.en} vs ${event!.away.name.en}`,
    );
    await expect(loaded.getByTestId('slip-leg-about')).toContainText(`#${event!.gameId}`);
    await expect(loaded.getByTestId('slip-leg-pick')).toContainText(event!.home.name.en);
    await expect(shop.getByTestId('slip-stake')).toHaveValue('30');
    await expect(shop.getByTestId('sell-submit')).toBeEnabled();
    const printsBefore = await shop.evaluate(
      () => (window as unknown as { __prints: number }).__prints,
    );
    await shop.getByTestId('sell-submit').click();
    await expect(shop.getByTestId('ticket-page')).toBeVisible();
    await expect(shop).toHaveURL(/\/ticket\/[0-9a-f-]+\?print=1$/);
    await expect(shop.getByTestId('ticket')).toContainText('ETB 30.00');
    await expect(shop.getByTestId('ticket-booking-code')).toContainText(
      `${slipId.slice(0, 3)} ${slipId.slice(3)}`,
    );
    await expect(shop.getByTestId('ticket-payout-code')).toHaveCount(1);
    await expect
      .poll(() => shop.evaluate(() => (window as unknown as { __prints: number }).__prints))
      .toBe(printsBefore + 1);
    // On paper the whole document is the receipt's page: no empty sheet after the ticket.
    await shop.emulateMedia({ media: 'print' });
    expect(
      await shop.evaluate(() => [
        getComputedStyle(document.body).getPropertyValue('page'),
        getComputedStyle(document.querySelector('[data-testid=ticket]')!).getPropertyValue('page'),
      ]),
    ).toEqual(['receipt80', 'receipt80']);
    await shop.emulateMedia({ media: 'screen' });
    // Opening the same page again prints nothing by itself (the Print button makes a copy).
    await shop.reload();
    await expect(shop.getByTestId('ticket-page')).toBeVisible();
    await expect(shop.getByTestId('ticket-copy-badge')).toBeVisible();
    await expect(shop.getByTestId('ticket-code-lost')).toHaveCount(0);
    await shop.waitForTimeout(500);
    expect(await shop.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(0);

    // This device's print settings: bigger and bold, saved here, used by every print.
    await shop
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Printer/ })
      .click();
    const settings = shop.getByTestId('print-settings');
    await settings.getByTestId('print-font-size').selectOption('16');
    await settings.getByTestId('print-thickness').selectOption('bold');
    await settings.getByTestId('print-save').click();
    await expect(settings.getByTestId('print-saved')).toBeVisible();
    const receiptStyle = () =>
      shop.getByTestId('test-receipt').evaluate((el) => {
        const style = getComputedStyle(el);
        return `${style.fontSize} ${style.fontWeight}`;
      });
    await expect.poll(receiptStyle).toBe('16px 700');
    await shop.reload();
    await expect(shop.getByTestId('print-settings')).toBeVisible();
    await expect.poll(receiptStyle).toBe('16px 700');
    await expect(shop.getByTestId('print-font-size')).toHaveValue('16');
    await expect(shop.getByTestId('print-thickness')).toHaveValue('bold');
    // The heaviest thickness also outlines every character (thicker on a thermal head).
    await shop.getByTestId('print-thickness').selectOption('heaviest');
    await expect
      .poll(() =>
        shop
          .getByTestId('test-receipt')
          .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-text-stroke-width')),
      )
      .toBe('0.6px');
    await shop.getByTestId('print-reset').click();
    await expect.poll(receiptStyle).toBe('13px 400');
  } finally {
    // Close the shop again so a second open shop does not stop other specs' cashiers.
    if (agentUrl !== null) {
      try {
        await admin.goto(agentUrl);
        const close = admin.getByRole('button', { name: 'Close shop' });
        await close.waitFor({ timeout: 10_000 });
        admin.once('dialog', (dialog) => void dialog.accept());
        await close.click();
        await expect(admin.getByRole('button', { name: 'Reopen shop' })).toBeVisible();
      } catch {
        // The test already failed; nothing more to clean up.
      }
    }
    await counter.close();
    await financeContext.close();
    await staff.close();
  }
});
