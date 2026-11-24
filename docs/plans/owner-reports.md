# Owner reports: day, week, month and year

Written 22 November 2026. Status: **built, pushed, not deployed** (migration `0080_report_days`).
Before every push, build on top of the server's branch:
`git fetch origin live/nahubet-new-2026-11-15 && git merge-base --is-ancestor FETCH_HEAD HEAD`.

## The owner's request

> Daily, weekly, monthly and yearly reports never make a mistake.

## How a report is made

- **One source: the double-entry ledger.** Every money movement is a ledger posting whose entries
  sum to zero. A report groups the postings of its period by category, channel (online or shop),
  account kind and payment provider (`loadReportTotalsByDay`, SQL), and core's
  `summarizeReport` turns those rows into the figures. Nothing is counted twice or kept in a
  separate counter that could drift.
- **Ethiopian time.** A day runs from midnight to midnight in Addis Ababa (UTC+3, no daylight
  saving); a week from Monday to Sunday; then the calendar month and year (`reportWindow`).
- **A period is exactly the sum of its days.** Every figure is a sum of the same rows, so a week,
  a month or a year can never disagree with its days (core property tests over random postings;
  a database test checks that the year equals its twelve months).
- **Cash view.** A stake counts on the day it is accepted and its payout on the day it is settled;
  GGR = stakes − payouts (won bets before tax, cash-outs, refunds). A corrected result counts on
  the day the correction is posted, so earlier days keep what was posted then.

## The figures

- **Betting, online and shops:** bets, stakes (net of live bets refused and shop tickets
  cancelled), won payouts, cash-outs, refunds, payouts, GGR, winnings tax withheld.
- **Shops:** winning tickets paid at counters, winnings never collected, agent top-ups and
  take-backs.
- **Jackpot:** entries, refunds, prizes, result.
- **Payments:** deposits by provider; withdrawals asked for, paid by provider, given back.
- **Promotions:** bonuses. **Totals:** GGR, winnings tax.
- **Balances** at the start and the end of the period (players' money, open stakes, revenue, tax
  to pay, payments per provider, agents, shops, jackpot), and the raw ledger movements behind the
  figures (in the CSV).

## How a report checks itself

Every report, every time it is opened (`getOwnerReport`), runs five checks and shows them:

1. All postings of the period add up to zero.
2. Every single posting adds up to zero (the database already refuses an unbalanced one; this is a
   second guard).
3. Every closed day is unchanged since its close: after midnight (plus 10 minutes) the worker
   writes the day's movements, a SHA-256 fingerprint and its closing balances into
   `report_days` (`closeReportDay`; the app may only insert and read that table). A posting
   back-dated or edited into a closed day shows here.
4. Every closed day passed its own checks when it closed.
5. Opening balances + the period's movements = closing balances, the closing side read
   independently (the last day's close, or the accounts' stored balances while the period is
   still running, in the same database snapshot).

The worker (`report-close`, every 10 minutes) closes each day not closed yet, oldest first, and
re-checks the last 7 closed days. A failed check is an `error` log line with
`alarm: 'report_check_failed'` and an alert to the owner (Telegram and SMS, at most every 6 hours
per day).

## Where to find it

- Back office → **Reports** (admin, compliance, finance): Day, Week, Month, Year, Previous/Next,
  the checks, the figures, the balances, and **Download CSV**.
- API: `GET /admin/reports?period=day|week|month|year&date=YYYY-MM-DD` (`reports.view`).
- Code: `packages/core/src/reports.ts`, `packages/db/src/reporting/reports.ts`,
  `apps/worker/src/tasks/report-close.ts`, `apps/api/src/modules/admin/reports.ts`,
  `apps/admin/src/app/reports/page.tsx`.

## After the deploy

The first worker pass closes the days from the first posting ever, 31 days per pass (every 10
minutes), until yesterday; then one day each night. Nothing needs to be set.
