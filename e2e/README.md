# @vamos/e2e: Playwright end-to-end tests

Mobile Chromium (Pixel 5 profile), `@playwright/test` 1.56.1. In the cloud dev container the
matching Chromium is preinstalled at `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`; elsewhere run
`npx playwright install --with-deps chromium` in `e2e/` once.

The suite never starts servers itself: a global setup checks that the API (demo mode, dev SMS
inbox on) and the web app answer, and fails with the start-up commands otherwise.

## Run it locally

```bash
pnpm services:start                 # Postgres + Redis (or docker compose)
pnpm db:migrate && pnpm db:seed
e2e/scripts/stack.sh build          # API + worker (tsup), web (next build)
e2e/scripts/stack.sh start          # API :4000, worker (fast simulator), web via server.mjs :3000
pnpm e2e                            # all specs (about 5–9 min, mostly waiting for kick-off)
e2e/scripts/stack.sh stop
```

`stack.sh start` runs the worker with `SIM_SPEED=60`, `FEED_ROLLING_EVERY_MINUTES=1` and
`FEED_ROLLING_HORIZON_MINUTES=10`: a rolling fixture kicks off every minute and a match is over in
a few seconds. Logs are in `e2e/.stack/`. Set `E2E_WEB_URL` / `E2E_API_URL` to test elsewhere.

Single specs: `pnpm --filter @vamos/e2e e2e:flow` (bet flow), `pnpm --filter @vamos/e2e budget`
(page weight).

## Specs

| Spec                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts`         | Amharic by default, DEMO notice in both launch languages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bet-flow.spec.ts`      | Register → OTP from `GET /dev/sms` → verify → ETB 1,000 top-up → one pick from each of the 3 soonest fixtures (≥ 60 s ahead) → place a ETB 50 multi → My Bets (open) → simulator plays, worker settles → balance and My Bets (settled)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `live-cashout.spec.ts`  | Register → verify → ETB 1,000 top-up → one 2-leg accumulator per outcome of a match kicking off soon (same pick on a later match), placed through the API → the simulator plays the first match, the worker settles the losers → My Bets offers Cash out on the survivor (first leg won) → confirm sheet, which survives the tab going out of view and back (silent resync) → status Cashed out, net paid at least the amount confirmed, balance up by it (checked through the API too); a second tab of the player, which sent no request, drops the bet, toasts the cash-out and moves its balance from the `/me/stream` push alone; a second offer says `bet_not_open`. The remaining leg is prematch, so the cash-out is instant (no live delay). A live window lasts about 2 s at SIM_SPEED=60, too short to click through, so the bet is cashed out right after its first match |
| `payments-flow.spec.ts` | Register → verify → KYC (mock Fayda) → a declined, then an approved deposit on the simulated phone (`/dev/phone`, wrong PIN first) → withdrawal refused until the deposit is bet → back every outcome of one match with equal singles (exactly one wins, so the winnings cover a withdrawal) → worker settles → withdraw ETB 5,000 (not below the auto-approve threshold, so it waits for review) → approve with the dev back-office stand-in → worker pays → tracker shows Paid, balance reduced, payment SMS in the dev inbox                                                                                                                                                                                                                                                                                                                                                       |
| `budget.spec.ts`        | Bytes transferred by a cold first load of `/` (production build only; skipped against `next dev`). Fails above the budget; see the comment in the spec for the measured weight (about 150 KB with the brotli server)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Helpers (`support/`)

- `stack.ts`: `assertStackUp()` (used by `global-setup.ts`)
- `otp.ts`: `devInbox(request, phone)`, `readOtp(request, phone, {template, since})`
- `phone.ts`: `randomPhone()` (`+2519…`), `ADULT_DATE_OF_BIRTH`
- `api.ts`: `getWallet`, `myBets`, `getBet`, `upcomingEvents`, `soonestEvents(request, n, {minLeadMs, maxLeadMs})`. Pass `page.request` to act as the signed-in player
- `money.ts`: `birr(santim)` formats like the app (`@vamos/core` `formatBirr`); `typedBirr(santim)` is what a player types (`5000.00`)
- `payments.ts`: `paymentOptions`, `myDeposits`, `myWithdrawals`, `reviewQueue`, `devApproveWithdrawal` (pass a cookie-less `request` fixture: it is the staff side)
- `ui.ts`: `registerAndVerify`, `balanceChip`, `pick`
- `env.ts`: `WEB_URL`, `API_URL`

Settlement is never faked: the bet settles because the simulator finishes the matches and the
worker's outbox and settlement queue run, exactly as in the demo.
