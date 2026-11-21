import { randomInt } from 'node:crypto';
import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
} from '@playwright/test';
import type { EventSummary, MarketView, TradingEventView } from '@vamos/contracts';
import {
  demoTopUp,
  getBet,
  getEventDetail,
  getWallet,
  myBets,
  placeBetApi,
  soonestEvents,
  tryPlaceBet,
  upcomingEvents,
} from '../support/api';
import { ADMIN_URL, API_URL, WEB_URL } from '../support/env';
import { birr, typedBirr } from '../support/money';
import { myWithdrawals } from '../support/payments';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { loginApi, loginInBrowser, staffApiOf } from '../support/staff';
import { balanceChip, registerAndVerify } from '../support/ui';

/**
 * The Phase 9 back office, end to end against the real stack (demo mode): the admin app (:3001)
 * talking to the API with the staff session cookie and CSRF header, and the player web app / the
 * worker on the other side.
 *
 *  - finance approves a player's withdrawal in the admin UI and the worker pays it (the dev
 *    stand-in of payments-flow.spec.ts is not used here);
 *  - a trader suspends an event, then voids a market, voids a selection and results an event as
 *    cancelled; the player's bets settle void and the stakes come back;
 *  - a support user is refused trading on the API (403) and does not see the trading nav.
 *
 * Staff sign in with a TOTP code computed from the demo secret (support/staff.ts). The server
 * refuses a second sign-in of the same account within one 30 s time step, so each test uses a
 * different role and the helper waits for the next step when it must reuse one.
 */

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

/** A fresh browser context (own cookies) for the staff side, phone-sized like the rest of the suite. */
async function staffContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
}

function verifiableFayda(): string {
  for (;;) {
    const fin = String(randomInt(100_000_000_000, 1_000_000_000_000));
    if (!fin.endsWith('0000') && !fin.endsWith('9999')) return fin;
  }
}

function payablePhone(): string {
  for (;;) {
    const phone = randomPhone();
    if (!phone.endsWith('0000') && !phone.endsWith('9999')) return phone;
  }
}

test('staff cannot reach anything without signing in, and a failed sign-in gives one generic message', async ({
  page,
  request,
}) => {
  // No staff session: 401 on the API, and the admin app sends the visitor to the login form.
  const dashboard = await request.get(`${API_URL}/admin/dashboard`);
  expect(dashboard.status()).toBe(401);
  await page.goto(`${ADMIN_URL}/`);
  await page.waitForURL('**/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  const email = page.getByLabel('Email', { exact: true });
  await expect(async () => {
    await email.fill('nobody@demo.vamos.test');
    await expect(email).toHaveValue('nobody@demo.vamos.test', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.getByLabel('Password', { exact: true }).fill('vamos-demo-staff');
  await page.getByLabel('Authenticator code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // One generic message, whatever was wrong.
  await expect(page.getByText(/Sign-in failed/)).toBeVisible();
  await expect(page.getByTestId('staff-role')).toHaveCount(0);
});

test('finance approves a player withdrawal in the back office and it gets paid', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const phone = payablePhone();

  // The wagering rule applies to demo top-ups too (every credit must be staked once) and a stake
  // leaves the balance, so a player can only withdraw what they WIN. As in payments-flow.spec.ts:
  // back every outcome of one match with equal singles of S = the auto-approval threshold (exactly
  // one wins and pays at least S), then withdraw S, which waits for staff review.
  const stake = 500_000n; // ETB 5,000
  await test.step('register and get verified (KYC, mock Fayda registry)', async () => {
    await registerAndVerify(page, phone);
    await page.goto('/account/kyc');
    const fin = verifiableFayda();
    await page.locator('#kyc-id').fill(fin);
    await page.locator('#kyc-name').fill('Abebe Kebede');
    await page.locator('#kyc-dob').fill(ADULT_DATE_OF_BIRTH);
    await page.getByRole('button', { name: 'Submit for verification' }).click();
    await expect(
      page.getByText(`Your identity is verified (ID ending in ${fin.slice(-4)}).`),
    ).toBeVisible();
  });

  const [event] = await soonestEvents(page.request, 1, {
    minLeadMs: 40_000, // the top-ups and bets below take a few seconds
    maxLeadMs: 5 * 60_000,
    timeoutMs: 90_000,
  });
  const selections = event!.mainMarket!.selections;
  const kickOff = Date.parse(event!.startTime);
  test.setTimeout(Math.max(0, kickOff - Date.now()) + 5 * 60_000);

  await test.step(`back every outcome of one match with a single of ETB ${birr(stake.toString())}`, async () => {
    for (let i = 0; i < selections.length; i += 1) await demoTopUp(page.request, stake.toString());
    expect((await getWallet(page.request)).cash).toBe(
      (stake * BigInt(selections.length)).toString(),
    );
    for (const selection of selections) {
      await placeBetApi(
        page.request,
        [{ selectionId: selection.id, oddsMilli: selection.oddsMilli }],
        stake.toString(),
      );
    }
    expect(Date.now()).toBeLessThan(kickOff); // still prematch when the last one went in
    expect((await myWithdrawals(page.request)).wageringRemaining).toBe('0');
  });

  await test.step('the simulator and the worker settle them: one outcome won', async () => {
    await expect
      .poll(async () => (await myBets(page.request, 'settled')).length, {
        timeout: Math.max(0, kickOff - Date.now()) + 90_000,
        intervals: [2000],
      })
      .toBe(selections.length);
    expect(Number((await getWallet(page.request)).cash)).toBeGreaterThanOrEqual(Number(stake));
  });

  await test.step('the player asks for a withdrawal of ETB 5,000: it waits for review', async () => {
    await page.goto('/wallet/withdraw');
    await expect(page.getByText('Your whole balance can be withdrawn.')).toBeVisible();
    await page.locator('#withdraw-amount').fill(typedBirr(stake.toString()));
    await page.getByRole('button', { name: `Withdraw ETB ${birr(stake.toString())}` }).click();
    await expect(page.getByText(/^Withdrawal requested\./)).toBeVisible();
    const card = page.getByRole('listitem').filter({ hasText: `To ${phone}` });
    await expect(card).toContainText('Waiting for staff review because of the amount.');
  });
  const cashBefore = BigInt((await getWallet(page.request)).cash);
  const [withdrawal] = (await myWithdrawals(page.request)).items;
  expect(withdrawal).toMatchObject({ status: 'requested', amount: stake.toString(), phone });
  const withdrawalId = withdrawal!.id;

  const staff = await staffContext(browser);
  const staffPage = await staff.newPage();
  try {
    await test.step('finance signs in and sees the finance nav only', async () => {
      await loginInBrowser(staffPage, 'finance');
      const nav = staffPage.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Withdrawals' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Trading' })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    });

    await test.step('the withdrawal waits in the queue and finance approves it', async () => {
      await staffPage.goto(`${ADMIN_URL}/withdrawals`);
      await staffPage.getByRole('button', { name: 'All withdrawals' }).click();
      const row = staffPage.getByTestId(`withdrawal-${withdrawalId}`);
      await expect(row).toContainText(phone);
      await expect(row).toContainText('requested');
      await row.getByRole('button', { name: 'Approve' }).click();
      await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(row).not.toContainText('requested');
    });

    await test.step('the worker pays it and the player sees it paid', async () => {
      await expect
        .poll(async () => (await myWithdrawals(page.request)).items[0]?.status, {
          timeout: 90_000,
          intervals: [2000],
        })
        .toBe('paid');
      expect((await getWallet(page.request)).cash).toBe(cashBefore.toString());
      await page.goto('/wallet/withdraw');
      const card = page.getByRole('listitem').filter({ hasText: `To ${phone}` });
      await expect(card.getByText('Paid', { exact: true })).toHaveCount(2);

      await staffPage.reload();
      await staffPage.getByRole('button', { name: 'All withdrawals' }).click();
      await expect(staffPage.getByTestId(`withdrawal-${withdrawalId}`)).toContainText('paid');
    });

    await test.step('the approval is in the audit log (read as compliance, over the API)', async () => {
      const context = await browser.newContext();
      try {
        const compliance = await loginApi(context.request, 'compliance');
        const response = await compliance.get('/admin/audit?limit=50');
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as {
          items: { action: string; entityId?: string | null; actor?: unknown }[];
        };
        const mine = body.items.filter((entry) => JSON.stringify(entry).includes(withdrawalId));
        expect(mine.length).toBeGreaterThan(0);
        expect(JSON.stringify(mine)).toContain('finance@demo.vamos.test');
      } finally {
        await context.close();
      }
    });
  } finally {
    await staff.close();
  }
});

/** Events kicking off in more than `minLeadMs`, with an open main market: the simulator leaves them alone. */
async function farEvents(
  request: APIRequestContext,
  count: number,
  minLeadMs: number,
): Promise<EventSummary[]> {
  const now = Date.now();
  const picked = (await upcomingEvents(request)).filter(
    (event) =>
      Date.parse(event.startTime) - now > minLeadMs &&
      event.status === 'scheduled' &&
      event.sport === 'football' && // many markets
      event.mainMarket?.status === 'open' &&
      event.mainMarket.selections.every((selection) => selection.open),
  );
  // Pick from the far end so a re-run (events already voided or cancelled) and the other specs
  // (which use the soonest ones) do not collide.
  const start = randomInt(0, Math.max(1, picked.length - count + 1));
  expect(picked.length, 'upcoming events far enough away').toBeGreaterThanOrEqual(count);
  return picked.slice(start, start + count);
}

function firstOpenSelection(market: MarketView): { selectionId: string; oddsMilli: number } {
  const selection = market.selections.find((s) => s.open);
  if (selection === undefined) throw new Error(`market ${market.id} has no open selection`);
  return { selectionId: selection.id, oddsMilli: selection.oddsMilli };
}

test('a trader suspends an event, voids a market and a selection, results another event, and the bets settle', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const phone = payablePhone();
  const stake = '1000'; // ETB 10

  await test.step('a player with ETB 1,000', async () => {
    await registerAndVerify(page, phone);
    await demoTopUp(page.request, '100000');
    expect((await getWallet(page.request)).cash).toBe('100000');
  });

  const [event1, event2] = await farEvents(page.request, 2, 4 * 3_600_000);
  const detail1 = await getEventDetail(page.request, event1!.id);
  const detail2 = await getEventDetail(page.request, event2!.id);
  // Two different markets of the first event; the main market of the second.
  const [marketA, marketB] = detail1.markets.filter(
    (market) => market.status === 'open' && market.selections.length >= 2,
  );
  expect(marketA && marketB, 'event with two open markets').toBeTruthy();
  const marketC = detail2.mainMarket!;

  const legA = firstOpenSelection(marketA!);
  const legB = firstOpenSelection(marketB!);
  const legC = firstOpenSelection(marketC);
  const betA = await placeBetApi(page.request, [legA], stake);
  const betB = await placeBetApi(page.request, [legB], stake);
  const betC = await placeBetApi(page.request, [legC], stake);
  expect((await getWallet(page.request)).cash).toBe('97000');

  const staff = await staffContext(browser);
  const staffPage = await staff.newPage();
  try {
    await loginInBrowser(staffPage, 'trader');
    const staffApi = await staffApiOf(staff.request);

    await test.step('find the event by Game ID and open it', async () => {
      await staffPage.goto(`${ADMIN_URL}/trading`);
      const search = staffPage.getByLabel('Team, competition or Game ID');
      await expect(async () => {
        await search.fill(event1!.gameId);
        await expect(search).toHaveValue(event1!.gameId, { timeout: 1000 });
      }).toPass({ timeout: 15_000 });
      await staffPage.getByRole('button', { name: 'Search', exact: true }).click();
      await staffPage
        .getByRole('link', { name: /.+ v .+/ })
        .first()
        .click();
      await staffPage.waitForURL(`**/trading/${event1!.id}`);
      await expect(staffPage.getByText(`Game ${event1!.gameId}`)).toBeVisible();
    });

    const adminEvent = (await (
      await staffApi.get(`/admin/trading/events/${event1!.id}`)
    ).json()) as TradingEventView;
    const keyOf = (id: string) => adminEvent.markets.find((m) => m.id === id)!.key;
    const cardA = staffPage.getByTestId(`market-${keyOf(marketA!.id)}`);
    const cardB = staffPage.getByTestId(`market-${keyOf(marketB!.id)}`);
    await expect(cardA).toBeVisible();

    await test.step('suspending the event stops bets; resuming allows them again', async () => {
      await staffPage.getByRole('button', { name: 'Suspend event' }).click();
      await staffPage.getByLabel('Reason', { exact: true }).fill('e2e: pitch inspection');
      await staffPage.getByRole('button', { name: 'Suspend event' }).click();
      await expect(cardA).toContainText(/suspended/i);

      const refused = await tryPlaceBet(page.request, [legA], stake);
      expect(refused.status, refused.body).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);

      await staffPage.getByRole('button', { name: 'Resume event' }).click();
      await staffPage.getByLabel('Reason', { exact: true }).fill('e2e: all clear');
      await staffPage.getByRole('button', { name: 'Resume event' }).click();
      await expect(cardA).not.toContainText(/suspended/i);
      // Nothing else of the player's changed meanwhile.
      expect((await getWallet(page.request)).cash).toBe('97000');
    });

    await test.step('voiding market A refunds the single on it', async () => {
      await cardA.getByRole('button', { name: 'Void market' }).click();
      await cardA.getByLabel('Reason').fill('e2e: market offered by mistake');
      await cardA.getByRole('button', { name: 'Void market' }).click();
      await expect(cardA).toContainText(/void/i);
    });

    await test.step('voiding one selection of market B voids the single on it', async () => {
      const code = marketB!.selections.find((s) => s.id === legB.selectionId)!.code;
      const row = cardB
        .getByRole('row')
        .filter({ has: staffPage.getByRole('cell', { name: code, exact: true }) });
      await row.getByRole('button', { name: 'Void selection' }).click();
      await row.getByLabel('Reason').fill('e2e: selection withdrawn');
      await row.getByRole('button', { name: 'Void selection' }).click();
      await expect(row).toContainText(/void/i);
    });

    await test.step('resulting the second event as cancelled voids the single on it', async () => {
      await staffPage.goto(`${ADMIN_URL}/trading/${event2!.id}`);
      const form = staffPage.getByRole('form', { name: 'Enter result' });
      await expect(form).toBeVisible();
      await form.getByLabel('Outcome').selectOption('cancelled');
      await form.getByRole('button', { name: 'Submit result' }).click();
      await expect(form.getByText(/^Result /)).toBeVisible();
    });
  } finally {
    await staff.close();
  }

  await test.step('the worker settles the three bets void and the stakes are back', async () => {
    for (const bet of [betA, betB, betC]) {
      await expect
        .poll(async () => (await getBet(page.request, bet.id)).status, {
          timeout: 60_000,
          intervals: [1000],
        })
        .toBe('void');
    }
    expect((await getWallet(page.request)).cash).toBe('100000');
    await page.goto('/wallet');
    await expect(balanceChip(page)).toHaveAttribute('aria-label', 'Balance: ETB 1,000.00');
  });
});

test('a support user is refused trading: 403 on the API and no trading nav', async ({
  page,
  browser,
}) => {
  const staff = await staffContext(browser);
  const staffPage = await staff.newPage();
  try {
    await loginInBrowser(staffPage, 'support');
    await expect(staffPage.getByTestId('staff-role')).toHaveText('support');

    const nav = staffPage.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Players' })).toBeVisible();
    for (const hidden of ['Trading', 'Risk', 'KYC queue', 'Withdrawals', 'Settings', 'Audit log']) {
      await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
    }

    // Every role has its own account page (own password, authenticator and sessions).
    await staffPage.getByRole('link', { name: 'My account' }).click();
    await expect(staffPage.getByRole('heading', { name: 'Change password' })).toBeVisible();
    await expect(staffPage.getByRole('heading', { name: 'Authenticator app' })).toBeVisible();
    const sessions = staffPage.getByRole('region', { name: 'Signed-in sessions' });
    await expect(sessions.getByText('this session')).toBeVisible();

    // Typing the URL does not help: the page itself says no.
    await staffPage.goto(`${ADMIN_URL}/trading`);
    await expect(staffPage.getByText('Your role does not have access to this page.')).toBeVisible();

    // The API says no as well, with the staff cookie and a valid CSRF token.
    const api = await staffApiOf(staff.request);
    const [event] = await farEvents(page.request, 1, 4 * 3_600_000);
    const suspend = await api.post(`/admin/trading/events/${event!.id}/suspend`, {
      reason: 'support must not do this',
    });
    expect(suspend.status()).toBe(403);
    expect(await suspend.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await api.get('/admin/trading/events')).status()).toBe(403);
    expect((await api.get('/admin/users')).status()).toBe(200);

    // And the event is untouched.
    const after = await getEventDetail(page.request, event!.id);
    expect(after.mainMarket?.status).toBe('open');
  } finally {
    await staff.close();
  }
});
