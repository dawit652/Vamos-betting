import { devices, expect, test, type Page } from '@playwright/test';
import { demoTopUp, getWallet, myBets, soonestEvents } from '../support/api';
import { ADMIN_URL, WEB_URL } from '../support/env';
import { devInbox } from '../support/otp';
import { ADULT_DATE_OF_BIRTH, randomPhone } from '../support/phone';
import { loginInBrowser } from '../support/staff';
import { registerAndVerify } from '../support/ui';

/**
 * Phase 11: betting by text message and by USSD through the demo simulator
 * (/dev/channels). The page sends as the signed-in player's own phone; the API
 * signs the request like the aggregator and forwards it to the real inbound
 * routes (POST /channels/sms/inbound, POST /channels/ussd), so this exercises
 * the whole path: webhook, parser, placeBet, the outbox, the worker and the
 * mock SMS provider (replies are read from the dev inbox).
 *
 * Needs the SMS_BETTING_ENABLED and USSD_ENABLED flags on, as e2e/scripts/stack.sh
 * starts the stack. Both stay off everywhere else.
 */

const TOP_UP = '100000'; // ETB 1,000 in santim
const STAKE_BIRR = 50;
/** The event must still be prematch when the text arrives. */
const MIN_LEAD_MS = 30_000;
const MAX_LEAD_MS = 6 * 60_000;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'vamos_locale', value: 'en', url: WEB_URL }]);
});

const smsSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'Text messages' }) });
const ussdSection = (page: Page) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: 'USSD phone' }) });

/** Sends a text from the composer and waits until the form is ready for the next one. */
async function sendSms(page: Page, text: string): Promise<void> {
  const sms = smsSection(page);
  await sms.getByLabel('Message').fill(text);
  await sms.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sms.getByLabel('Message')).toHaveValue('');
}

/** One USSD reply typed on the emulator; returns once the screen changed. */
async function ussdReply(page: Page, input: string): Promise<void> {
  const phone = ussdSection(page);
  const before = await phone.locator('.font-mono').innerText();
  await phone.getByLabel('Your reply').fill(input);
  await phone.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(phone.locator('.font-mono')).not.toHaveText(before);
}

test('bet and balance by text message, an invalid command gets the help reply', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const phone = randomPhone();
  await registerAndVerify(page, phone, ADULT_DATE_OF_BIRTH);
  await demoTopUp(page.request, TOP_UP);

  const [event] = await soonestEvents(page.request, 1, {
    minLeadMs: MIN_LEAD_MS,
    maxLeadMs: MAX_LEAD_MS,
    timeoutMs: 90_000,
  });
  const homePick = event!.mainMarket!.selections.find((s) => s.code === '1' && s.open);
  expect(homePick, 'the event offers a "1" pick').toBeDefined();

  await page.goto('/dev/channels');
  await expect(page.getByRole('heading', { name: 'Text messages' })).toBeVisible();
  const sms = smsSection(page);

  await test.step('BAL answers with the balance', async () => {
    await sendSms(page, 'BAL');
    await expect(sms.getByText(/Balance ETB 1,000\.00/)).toBeVisible({ timeout: 20_000 });
    await expect(sms.getByText('Result: info')).toBeVisible();
  });

  let shortId = '';
  let replyOddsMilli = 0;
  await test.step('GAMEID#PICK#STAKE places a bet and the reply names it', async () => {
    await sendSms(page, `${event!.gameId}#1#${STAKE_BIRR}`);
    const reply = sms.getByText(/Bet [A-Z0-9]{8} placed\./);
    await expect(reply).toBeVisible({ timeout: 20_000 });
    const text = (await reply.textContent()) ?? '';
    shortId = /Bet ([A-Z0-9]{8}) placed/.exec(text)![1]!;
    // The bet takes the price at receipt; a prematch price can drift (every 30 s) after the
    // snapshot above, so the reply's odds are checked for shape, then against the placed bet.
    const odds = /Odds (\d+)\.(\d{2,3})\b/.exec(text);
    expect(odds, 'the reply names the odds').not.toBeNull();
    replyOddsMilli = Number(odds![1]) * 1000 + Number(odds![2]!.padEnd(3, '0'));
    expect(replyOddsMilli).toBeGreaterThan(1000);
    expect(text).toContain(`stake ETB ${STAKE_BIRR}.00`);
    expect(text).toMatch(/possible win ETB [\d,]+\.\d\d/);
    await expect(sms.getByText('Result: bet_placed')).toBeVisible();
    // The reply also went through the SMS provider (the dev inbox is its mock).
    const inbox = await devInbox(page.request, phone);
    expect(inbox.some((m) => m.template === 'channel_reply' && m.body.includes(shortId))).toBe(
      true,
    );
  });

  await test.step('the bet is in My Bets with channel sms and the stake left the wallet', async () => {
    const stake = BigInt(STAKE_BIRR) * 100n;
    const open = await myBets(page.request, 'open');
    const bet = open.find((b) => b.shortId === shortId);
    expect(bet?.channel).toBe('sms');
    expect(bet?.betType).toBe('single');
    expect(bet?.stake).toBe(stake.toString());
    expect(bet?.totalOddsMilli).toBe(String(replyOddsMilli));
    expect((await getWallet(page.request)).cash).toBe((BigInt(TOP_UP) - stake).toString());

    await page.goto('/my-bets');
    const card = page.locator('article').filter({ hasText: `Bet ${shortId}` });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Single');
    await expect(card).toContainText('Open');
  });

  await test.step('an invalid command gets the help reply and places nothing', async () => {
    await page.goto('/dev/channels');
    await sendSms(page, 'hello there');
    await expect(sms.getByText(/Unknown command\. .*GAMEID#PICK#STAKE/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(sms.getByText('Result: invalid_command')).toBeVisible();
    expect((await myBets(page.request, 'open')).length).toBe(1);
  });

  await test.step('HELP lists the commands', async () => {
    await sendSms(page, 'help');
    await expect(sms.getByText(/Bet: GAMEID#PICK#STAKE/)).toBeVisible({ timeout: 20_000 });
  });
});

test('a bet completed through the USSD phone emulator', async ({ page }) => {
  test.setTimeout(150_000);
  const phone = randomPhone();
  await registerAndVerify(page, phone, ADULT_DATE_OF_BIRTH);
  await demoTopUp(page.request, TOP_UP);

  const [event] = await soonestEvents(page.request, 1, {
    minLeadMs: MIN_LEAD_MS,
    maxLeadMs: MAX_LEAD_MS,
    timeoutMs: 90_000,
  });

  await page.goto('/dev/channels');
  const ussd = ussdSection(page);
  const screen = ussd.locator('.font-mono');
  await expect(page.getByRole('heading', { name: 'USSD phone' })).toBeVisible();

  await test.step('dial *123# and see the main menu', async () => {
    await ussd.getByRole('button', { name: 'Call' }).click();
    await expect(screen).toContainText('1 Place bet');
    await expect(screen).toContainText('2 Balance');
  });

  await test.step('balance', async () => {
    await ussdReply(page, '2');
    await expect(screen).toContainText('Balance ETB 1,000.00');
  });

  await test.step('place a bet: Game ID, pick, stake, confirm', async () => {
    // The balance screen ended the session: dial again.
    await ussd.getByRole('button', { name: 'Call' }).click();
    await expect(screen).toContainText('1 Place bet');
    await ussdReply(page, '1');
    await expect(screen).toContainText('Enter Game ID');
    await ussdReply(page, event!.gameId);
    // The options of the main market with their current odds; option 1 is the first listed.
    await expect(screen).toContainText(/1 .*\d+\.\d\d/);
    await ussdReply(page, '1');
    await expect(screen).toContainText('Enter stake in ETB');
    await ussdReply(page, String(STAKE_BIRR));
    await expect(screen).toContainText('1 Confirm');
    await expect(screen).toContainText(`Stake ETB ${STAKE_BIRR}`);
    await ussdReply(page, '1');
    // A prematch price can drift (every 30 s) between the confirm screen and the '1': the
    // confirm screen then comes back at the new odds, and is confirmed again.
    for (let retry = 0; retry < 3; retry += 1) {
      if (!(await screen.innerText()).includes('Odds changed')) break;
      await expect(screen).toContainText('1 Confirm');
      await ussdReply(page, '1');
    }
    await expect(screen).toContainText(/Bet [A-Z0-9]{8} placed\./);
    await expect(ussd.getByText('Session ended. Dial again to start over.')).toBeVisible();
  });

  await test.step('exactly one bet, on channel ussd, and the stake left the wallet', async () => {
    const open = await myBets(page.request, 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.channel).toBe('ussd');
    expect(open[0]!.stake).toBe((BigInt(STAKE_BIRR) * 100n).toString());
    expect((await getWallet(page.request)).cash).toBe(
      (BigInt(TOP_UP) - BigInt(STAKE_BIRR) * 100n).toString(),
    );
    const shortId = open[0]!.shortId;
    await page.goto('/my-bets');
    await expect(page.locator('article').filter({ hasText: `Bet ${shortId}` })).toBeVisible();
  });
});

test('the back office shows the channel switches and the channel of each bet', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const staff = await browser.newContext({ ...devices['Pixel 5'], baseURL: ADMIN_URL });
  const staffPage = await staff.newPage();
  try {
    await loginInBrowser(staffPage, 'admin');

    await test.step('Channels: both switches are on in the e2e stack (read-only)', async () => {
      await staffPage.goto(`${ADMIN_URL}/channels`);
      await expect(staffPage.getByRole('heading', { name: 'Channels' })).toBeVisible();
      for (const variable of ['SMS_BETTING_ENABLED', 'USSD_ENABLED']) {
        const row = staffPage.getByRole('row').filter({ hasText: variable });
        await expect(row).toContainText('enabled');
      }
    });

    await test.step('Bets: the table has a Channel column with SMS and USSD bets', async () => {
      await staffPage.goto(`${ADMIN_URL}/bets`);
      // Plain locators: the admin tables are laid out for phones and lose their table roles.
      await expect(staffPage.locator('th', { hasText: /^Channel$/i })).toBeVisible({
        timeout: 15_000,
      });
      // The two earlier tests placed one bet by SMS and one by USSD.
      await expect(staffPage.locator('td', { hasText: /^SMS$/ }).first()).toBeVisible();
      await expect(staffPage.locator('td', { hasText: /^USSD$/ }).first()).toBeVisible();
    });
  } finally {
    await staff.close();
  }
});
