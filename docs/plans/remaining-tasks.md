# Remaining tasks (read this first; updated 17 Nov 2026)

Latest work: branch `claude/happy-keller-i7cvrh` (17 Nov; it continues
`claude/eager-cerf-ox9vkq`, which stops at the plan docs). A new session may be given another
branch name: start it from the latest of these. It holds the server's own branch
(`live/nahubet-new-2026-11-15`); check with
`git merge-base --is-ancestor origin/live/nahubet-new-2026-11-15 HEAD` before every push. Live
server runs `47c3126`; pushed and not yet deployed: everything up to the team logos.
Deploy is done by the owner (PowerShell command in the last session: `ssh -t root@<server>` +
`infra/scripts/deploy-full.sh`, licensed env file `/opt/nahubet-new/infra/.env.prod`, project
`vamos`). Never touch the live server yourself; never paste secrets.

## Next, in order

1. **Check the Telegram PIN reset after the owner deploys `c14e2c9`** (fix: a website "Send code"
   no longer kills the Telegram code, `apps/api/src/lib/otp.ts`). If the owner's number hit the
   10 wrong codes a day budget, it clears 24 h after the first wrong try.
2. **Team logos: check on live after the owner deploys** (built 17 Nov, `docs/plans/team-logos.md`
   "As built"). Logos appear only with `SCRAPER_SECRET_API_FOOTBALL` set on the server; the
   scraper logs `team logo download failed` or `team logos skipped` when something is wrong.
3. **Cashier dashboard**: phase 1 built 17 Nov (desk, shifts, cash deposits, receipts; cash is
   the payment provider `cash`). Next: cash withdrawal with a player-made code, then the other
   phases in `docs/plans/cashier-dashboard.md` ("Next phases"). Money path: Opus high. Owner
   decisions still open (shops, limits, printer, walk-in tickets); defaults are settings.
4. **X6b failed-login alarm** (open): many failed logins or many numbers tried in 15 minutes
   raise an alarm (`apps/api/src/lib/rate-limits.ts`, alarms are `error` log lines with `alarm`).
5. **X11 rule O1h, locked odds** (open, money path): `docs/plans/scale-and-payments-handover.md`
   "Locked odds"; `apps/scraper/src/pipeline/auto-open.ts`, `reprice.ts`.
6. **Next.js security upgrade** (16.4.2 → patched; CI's dependency audit fails until done): ask
   the owner yes/no first. The local `next build` stops once with a security message: run it again.

## Owner decisions still open

- PIN rule: keep refusing 1111-style, 1234-style and the phone's last 4 (31 of 10,000), or allow all.
- A real SMS gateway (`SMS_PROVIDER=http`) before real players; until then PIN resets go by Telegram.
- In @BotFather `/setcommands`: add `reset - Forgot PIN` and `share - Share with friends`.
- Native-speaker review of the Amharic: `packages/core/src/amharic-names.data.ts` and the UI texts.

## Facts that save time

- Local checks: `pnpm services:start` (Postgres/Redis stop when the container restarts), then
  `e2e/scripts/stack.sh build && e2e/scripts/stack.sh start`; e2e with
  `E2E_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test <spec> --trace off`.
- Home page weight 167.4 KB, budget 168 KB (`e2e/tests/budget.spec.ts`): new UI needs room first.
- Migrations: Drizzle runs one only if its journal `when` is later than the last applied one
  (handover, "migration" notes); next free number after 0057.
- Done on 16-17 Nov (no need to re-read): Telegram bot (alerts, menu, /status, Forgot PIN,
  share), Amharic names (`amharic-names.ts`), Top leagues fixed list, competition logos, featured
  row of big matches, team flags for national teams, merged country chips, tap feedback and the
  navigation bar, relaxed PIN rule, 21+ tick box removed, team logos (17 Nov).
