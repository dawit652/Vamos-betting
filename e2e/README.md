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
pnpm e2e                            # all specs (about 2–5 min, mostly waiting for kick-off)
e2e/scripts/stack.sh stop
```

`stack.sh start` runs the worker with `SIM_SPEED=60`, `FEED_ROLLING_EVERY_MINUTES=1` and
`FEED_ROLLING_HORIZON_MINUTES=10`: a rolling fixture kicks off every minute and a match is over in
a few seconds. Logs are in `e2e/.stack/`. Set `E2E_WEB_URL` / `E2E_API_URL` to test elsewhere.

Single specs: `pnpm --filter @vamos/e2e e2e:flow` (bet flow), `pnpm --filter @vamos/e2e budget`
(page weight).

## Specs

| Spec               | What                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts`    | Amharic by default, DEMO notice in both launch languages                                                                                                                                                                               |
| `bet-flow.spec.ts` | Register → OTP from `GET /dev/sms` → verify → ETB 1,000 top-up → one pick from each of the 3 soonest fixtures (≥ 60 s ahead) → place a ETB 50 multi → My Bets (open) → simulator plays, worker settles → balance and My Bets (settled) |
| `budget.spec.ts`   | Bytes transferred by a cold first load of `/` (production build only; skipped against `next dev`). Fails above the budget; see the comment in the spec for the measured weight (about 150 KB with the brotli server)                   |

## Helpers (`support/`)

- `stack.ts`: `assertStackUp()` (used by `global-setup.ts`)
- `otp.ts`: `devInbox(request, phone)`, `readOtp(request, phone, {template, since})`
- `phone.ts`: `randomPhone()` (`+2519…`), `ADULT_DATE_OF_BIRTH`
- `api.ts`: `getWallet`, `myBets`, `getBet`, `upcomingEvents`, `soonestEvents(request, n, {minLeadMs, maxLeadMs})`. Pass `page.request` to act as the signed-in player
- `money.ts`: `birr(santim)` formats like the app (`@vamos/core` `formatBirr`)
- `env.ts`: `WEB_URL`, `API_URL`

Settlement is never faked: the bet settles because the simulator finishes the matches and the
worker's outbox and settlement queue run, exactly as in the demo.
