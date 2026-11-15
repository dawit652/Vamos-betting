# Scale and payments: progress

Last updated: 15 Nov 2026, 20:20 UTC (session `01BG4x`, first account, resumed on Sonnet 5.5).

The plan is [scale-and-payments-plan.md](scale-and-payments-plan.md); the to-do list with "done when"
for each task is [scale-and-payments-handover.md](scale-and-payments-handover.md). Update this file in
the same commit as every finished task: the task's row, the numbers it measured, and the "Last
updated" line above.

## 1. Tasks

Status: `open`, `in progress` (with the commit it stands on), `done` (with the commit), `waits` (for
a decision of section 3), `not planned`.

**Two accounts work on this branch.** A row marked `in progress` is taken: skip it and take the next
`open` row. A claim names the session (the first characters of its id) and the time in UTC; a claim
with no commit after 6 hours is free again. Pull before every push, never force-push, and let only
one session create migrations at a time (the next number is 0053).

| #   | Task                                                                                                                     | Status      | Commit, notes                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------- |
| A1a | Deposit burst in the load test                                                                                           | in progress | Session `01BhRB` (second account), from about 15:40 UTC; nothing pushed as of 20:06 UTC |
| A1b | Pages and live streams in the load test                                                                                  | open        |                                                                                         |
| A2  | Catalogue cache in the API (2 s)                                                                                         | in progress | Session `01BhRB`, from about 15:40 UTC; nothing pushed as of 20:06 UTC                  |
| A3  | Web server reuses catalogue answers (2 s)                                                                                | open        |                                                                                         |
| A4  | Several API processes and PgBouncer                                                                                      | open        |                                                                                         |
| A5  | Live streams on their own processes                                                                                      | open        |                                                                                         |
| A6  | A leaner bet (query cuts)                                                                                                | done        | 23 to 20 statements per bet; golden and budget tests; target 15 needs A6b               |
| A6b | Fewer queries in `rg/` and `ledger/` (merge the users reads, exclusion and limits, ledger account lookups): about 5 more | open        | Opus, high: touches responsible-gambling checks and ledger posting                      |
| A7  | Measure the `house_stakes` ceiling; shard only if needed                                                                 | open        | After A4                                                                                |
| A8  | Database: tuning, replica, partitions, restore drill                                                                     | open        | After A1's baseline                                                                     |
| A9  | Worker queues apart; cold standby design                                                                                 | open        |                                                                                         |
| A10 | Metrics endpoint                                                                                                         | open        |                                                                                         |
| A11 | More than one server                                                                                                     | waits       | D7                                                                                      |
| B1  | Real SMS and receipt fixtures                                                                                            | waits       | The owner's test payments                                                               |
| B2a | Amount space per collection account: core                                                                                | open        |                                                                                         |
| B2b | Amount space per collection account: database, gateway                                                                   | open        | After B2a                                                                               |
| B2c | Amount space per collection account: screens                                                                             | open        | After B2b                                                                               |
| B3  | Match by the payer's phone first                                                                                         | waits       | B1                                                                                      |
| B4  | Offsets 1 to 99                                                                                                          | in progress | Session `01BhRB`, from about 15:40 UTC; nothing pushed as of 20:06 UTC                  |
| B4b | Shorter hold on amounts of cancelled deposits                                                                            | waits       | D5                                                                                      |
| B5  | Second handset and forwarder heartbeat alarm                                                                             | open        | Needs a spare phone on site                                                             |
| B6  | `received_sms` in reconciliation and retention; re-parse                                                                 | open        |                                                                                         |
| B7  | telebirr merchant checkout as a second door                                                                              | waits       | D1; telebirr is state-run: confirm with the owner first (15 Nov)                        |
| B8  | EthioPay-IPS deposits through a bank                                                                                     | not planned | Owner, 15 Nov: outside government platforms                                             |
| B9  | Statement feed for CBE                                                                                                   | waits       | D2                                                                                      |
| C1  | Faster hands: batch claim, pick list, idle-claim alarm                                                                   | done        | batch claim, pick list, idle alarm; Opus review: no four-eyes bypass, starvation fixed  |
| C2  | Settle on double proof                                                                                                   | waits       | D4, D8                                                                                  |
| C3  | Payout batch files and result import                                                                                     | waits       | D1 or D2                                                                                |
| C4  | telebirr business payouts by API                                                                                         | waits       | D1; telebirr is state-run: confirm with the owner first (15 Nov)                        |
| C5  | Bank host-to-host transfers                                                                                              | waits       | D2                                                                                      |
| C6  | EthioPay-IPS payouts through a bank                                                                                      | not planned | Owner, 15 Nov: outside government platforms                                             |
| C7  | Chapa transfers                                                                                                          | not planned | Fallback only; the adapter exists                                                       |
| C8  | A robot on the handset                                                                                                   | not planned | Not recommended (plan, section 6)                                                       |
| C9  | Approval tiers                                                                                                           | waits       | D6, D8                                                                                  |
| C10 | Float forecast and alarm                                                                                                 | open        |                                                                                         |
| C11 | Routing between payout rails                                                                                             | waits       | After a second rail pays out                                                            |
| X1  | Top-match flag (port of `136f469`, `4df33b1`)                                                                            | not planned | Owner, 15 Nov: not now (see §3)                                                         |
| X2  | End-to-end tests of the redesign (port of `4df33b1`)                                                                     | open        |                                                                                         |
| X3  | Rename the inside from Vamos to Nahubet                                                                                  | open        | Stages 1 to 3 only (see §3)                                                             |
| X4  | Licensed texts for Help, Terms, Responsible gambling                                                                     | open        | Also in root `HANDOFF.md`                                                               |

## 2. Measured

Nothing yet. A1a and A1b put the first numbers here: deposits refused for lack of an amount, credit
latency, list and bet latency at each scale, the machine they ran on.

Known from before (`docs/load-testing.md`, 19 Oct 2026): about 95 bets/s on one API process on 4
shared CPUs, p95 504 ms at 50 connections; the limit is the process's CPU, then the single
`house_stakes` ledger row.

## 3. Owner decisions

| #   | Decision or call                                                         | State | Answer                                                    |
| --- | ------------------------------------------------------------------------ | ----- | --------------------------------------------------------- |
| D1  | Ethio telecom: merchant with disbursement and bulk payment; API document | open  | brief: [provider-calls-brief.md](provider-calls-brief.md) |
| D2  | Main bank: bulk format, statement feed, host-to-host, EthioPay-IPS       | open  | brief: [provider-calls-brief.md](provider-calls-brief.md) |
| D3  | Collection accounts per institution                                      | open  |                                                           |
| D4  | Settle on double proof for telebirr (C2)                                 | open  |                                                           |
| D5  | Hold on amounts of cancelled deposits (B4b)                              | open  |                                                           |
| D6  | Approval tiers (C9)                                                      | open  |                                                           |
| D7  | Server sizes and a second server (A11)                                   | open  |                                                           |
| D8  | Counsel and regulator: tiers and C2                                      | open  |                                                           |

Already decided by the owner (15 Nov 2026):

- No aggregator gateway such as Chapa; deposits stay on the SMS rail, withdrawals are to be automated.
- Languages: Amharic and English only.
- The inside of the code is to be renamed from Vamos to Nahubet (task X3), **except the server's own
  names**: the compose project, the volumes and the database keep their names. The owner does not
  want Docker to start on new, empty volumes (15 Nov, second session), so stage 4 of X3 is dropped.
- Pull requests: the branch goes into the default branch by pull request, merged once CI is green
  (15 Nov, second session: "use your recommendation").
- Top-match flag (X1): not now. The home poster keeps showing the first highlight; the featured
  leagues cover the need. Reopen if a trader asks for it.
- The two calls with the longest lead time (D1 Ethio telecom, D2 the bank) are the owner's to make;
  both are still open. The owner also said (first session, 15 Nov): "It's better outside government
  platforms." Read as: do not build on a government-run payment platform. EthioPay-IPS and the
  national gateway are dropped (B8, C6); telebirr's merchant and payout APIs wait for the owner's
  confirmation (B7, C4); D2 asks the bank only about bulk files, a statement feed and host-to-host
  transfers. If the owner meant more (for example, moving the collection accounts too), the plan
  changes: ask.

## 4. Sessions

| Date        | Branch                     | What                                                                                                                                                                                                         |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 15 Nov 2026 | `claude/eager-cerf-ox9vkq` | Branch merged onto the default branch (`b7dc17c`) with the default branch's files; back-office theme and `E2E_CHROMIUM_PATH` carried over; plan, handover and this file written. No task of the plan started |
| 15 Nov 2026 | `claude/eager-cerf-ox9vkq` | Session `01BhRB` (second account, Fable then Sonnet): owner's answers recorded, pull request 5 opened, agents started on A1a and A2 and B4 by its own report; nothing pushed after 15:39 UTC                 |
| 15 Nov 2026 | `claude/eager-cerf-ox9vkq` | Session `01BG4x` (first account, Sonnet 5.5) resumed at 20:06 UTC: took C1 and A6, recorded the "outside government platforms" steer in the plan and here                                                    |
