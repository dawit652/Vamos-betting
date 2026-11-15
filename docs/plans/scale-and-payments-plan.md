# Plan: 10,000 people at a time, and money in and out without manual work

Written 15 Nov 2026 against the default branch (release v0.3.0 with the redesign). Nothing in this plan
is built yet. Progress is tracked in [scale-and-payments-progress.md](scale-and-payments-progress.md);
the to-do list for the next session is [scale-and-payments-handover.md](scale-and-payments-handover.md).

Two goals:

1. Nahubet serves **10,000 people at the same time** with fast pages and no lost or doubled money.
2. **Deposits and withdrawals need no staff typing**, without an aggregator gateway such as Chapa.

What is measured, what is an estimate and what must be confirmed with a provider is marked as such.
Provider facts were checked on the web on 15 Nov 2026 (sources at the end). No Ethiopian provider
publishes its merchant API, so every provider option needs a meeting before it is built.

## 1. Where the system is today

| Area            | Today                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposits        | **Automatic, on the SMS rail** (`docs/runbooks/sms-rail.md`): the player sends an exact amount (requested + 1 to 50 santim), the collection handset forwards the bank's SMS, the system matches the amount and credits |
| Deposit checks  | telebirr receipt page (audit of every credit, and the "I paid" path when the handset is offline), balance chain per institution, a review queue for anything unclear                                                   |
| Withdrawals     | **Manual, four eyes:** approved by a person or automatically under `autoApproveBelow`, then an operator claims the payout, sends the money by hand from a collection account and settles it with the outgoing SMS      |
| Other providers | Chapa (deposits and automatic payouts) and telebirr checkout (deposits only) have adapters in `packages/payments`; the owner does not want a gateway, so they are fallbacks                                            |
| Bet placement   | **Measured** (`docs/load-testing.md`): about 95 bets/s on one API process on 4 shared CPUs, p95 0.5 s at 50 connections; CPU-bound, about 23 queries per bet                                                           |
| Topology        | One server, one Docker compose project: one `api`, one `web`, one `worker` (must stay one), `scraper`, Postgres (`max_connections` 200, API pool 10), Redis, Caddy                                                     |
| Lists and pages | Every page render asks the API again and every API list request asks the database again; lists are the same for every visitor                                                                                          |
| Live odds       | Server-Sent Events from the same API process, fed by Redis pub/sub                                                                                                                                                     |
| Monitoring      | Alarms are `error` log lines with an `alarm` field; there is no metrics endpoint                                                                                                                                       |
| Books           | Double-entry ledger, idempotency keys, daily reconciliation; `received_sms` is not yet part of the reconciliation                                                                                                      |

## 2. What "10,000 at a time" means in numbers

**Assumptions** for a big match evening, to be replaced with real traffic numbers once the load test
of step A1 has run and the live numbers have been read from the server.

| Load                   | Assumption for 10,000 people online                                                    | Target                                         |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Page and list requests | One every 15 s per person: about 700/s                                                 | p95 under 400 ms                               |
| Open live streams      | 6,000 at once                                                                          | A price change reaches the phone in under 2 s  |
| Bets                   | 60/s normal, **250/s** in the minutes before kick-off                                  | p95 under 500 ms, no error on money            |
| Deposits               | 0.5/s normal, **2/s** before kick-off; about a third of them for the same round amount | Credited within 30 s of the bank's SMS         |
| Withdrawals            | 4,000 a day, 600 in the hour after the evening's final whistles                        | Paid within 5 minutes when no person is needed |
| Errors                 |                                                                                        | Under 0.5% of requests                         |
| Money                  |                                                                                        | Reconciliation clean after every test          |

## 3. What breaks first at that size

In the order it would be felt:

1. **Deposits run out of amounts.** An open deposit holds one of **50** amounts above its round amount
   (100.01 to 100.50), for all institutions together, until it is paid, and for **2 more hours** after
   it expires unpaid (`SMS_AMOUNT_QUARANTINE_MS`). At 2 deposits a second with a third of them for
   "100 birr" and a minute or two to pay, 40 to 80 are open at once: more than 50, before counting
   abandoned ones. Players then see "choose a slightly different amount".
2. **Withdrawals need a room full of operators.** One operator sends about 40 to 60 payouts an hour by
   hand (estimate). 4,000 a day is about 80 operator-hours every day, and 600 in one hour needs ten
   operators at once.
3. **One handset carries every deposit.** If it is offline, slow or its SMS are delayed by the network,
   telebirr deposits fall back to the "I paid" check and CBE deposits wait.
4. **One API process.** 95 bets/s measured against 250/s wanted, and the same process also holds every
   live stream.
5. **Nothing is cached.** 700 page requests a second each cost a full server render and three database
   queries per list.
6. **One server for everything.** Postgres, the API, the web server, the worker and the scraper share
   the same CPUs.

## 4. Part A: capacity

Every step ends with the load test of A1. A step is done when the test passes, not when the code is
written. Bet placement and payments are never cached or loosened in any step.

| Step | What                                                                                                                                                                                                                                                                         | Result expected (estimate until measured)               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A1   | **A load test shaped like 10,000 people:** extend `scripts/load` with page and list requests, 6,000 open live streams, the bet spike, and the SMS deposit burst the payments plan left open (500 deposits of one round amount plus a storm of forwarded SMS). Demo mode only | A baseline for every later step                         |
| A2   | **Short cache for the catalogue in the API:** `/sports`, competitions and `/events` pages kept for 2 s per distinct query, one refresh at a time per key. Bet placement always reads the real price                                                                          | List latency stays flat as visitors grow                |
| A3   | **The web server reuses a catalogue answer for 2 s** instead of fetching it for every render (public catalogue data only; pages still render per visitor)                                                                                                                    | Fewer API calls per page                                |
| A4   | **Several API processes behind the proxy, with PgBouncer** (transaction pooling) in front of Postgres. The code only uses transaction-level advisory locks and no `LISTEN`, so pooling is safe; the worker and the migrate job keep a direct connection                      | About 400 bets/s with 6 processes                       |
| A5   | **Live streams on their own processes** (same code, only the stream routes), with raised open-file limits and proxy timeouts                                                                                                                                                 | Thousands of streams never slow a bet                   |
| A6   | **A leaner bet:** remove the extra queries listed in `docs/load-testing.md` (the re-read of the bet, the two user reads). One database transaction per bet stays                                                                                                             | About 15 queries per bet instead of 23                  |
| A7   | **Measure the one `house_stakes` row** with 6 processes. Only if it limits below 300 bets/s: split it into a few shard accounts by player id, with its own design review and property tests (it changes the ledger layout and reconciliation)                                | The ceiling is known, and raised if needed              |
| A8   | **Database:** tuning for the write load, a streaming replica (failover, and the back office's heavy reads), monthly partitions for the tables that only grow (`ledger_entries`, `outbox_events`, audit log, `received_sms`), a restore drill                                 | Indexes stay in memory; a lost server is not lost money |
| A9   | **Worker:** one active instance stays the rule (`docs/deployment.md`). Give settlement, payouts, SMS and reports separate queues and concurrency so a settlement burst never delays payouts; design a cold standby                                                           | Payouts keep their pace after 30 final whistles         |
| A10  | **Numbers on a screen:** a metrics endpoint for the targets of section 2 (latency, errors, queue age, open streams, open deposits per round amount, payout age) next to the log alarms                                                                                       | The limits are seen before players feel them            |
| A11  | **More than one server:** proxy, 3 app servers (API, web, stream processes), the worker, Postgres primary and replica, Redis. Sizes come from the test; a first guess is 8 CPUs per app server and 16 CPUs / 64 GB for Postgres                                              | Room for the target with one server lost                |

## 5. Part B: deposits (already automatic; make them hold at 10,000)

| Step | What                                                                                                                                                                                                                                                                                                            | Needs                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B1   | **Real fixtures:** one real SMS and one real receipt page per collection institution (payer details replaced). Today's are reconstructed. They also answer whether telebirr's SMS carries the payer's full number                                                                                               | The owner (test payments)                              |
| B2   | **An amount space per collection account:** the deposit remembers the account the player was shown, the amount is unique per account, and an SMS only matches deposits of the account it arrived on. Two accounts double the space, four quadruple it; the screen offers the account with the most free amounts | A migration; more collection accounts multiply it      |
| B3   | **Match by the payer's phone first** where the SMS carries the full number: a payment from the player's own registered number then needs the amount to be unique only among that player's deposits, so wallet deposits no longer share the 50 amounts                                                           | B1 confirming the number is complete                   |
| B4   | **Offsets 1 to 99 santim** instead of 1 to 50, and a shorter hold on amounts of deposits the player cancelled before paying. The rule that a late SMS only pays a deposit that existed when the money moved (`smsPaidBy`) stays                                                                                 | Owner decision on the hold; property tests             |
| B5   | **A second handset per account, already set up,** and an alarm on the forwarder's heartbeat. Duplicates are already recognised                                                                                                                                                                                  | A spare phone                                          |
| B6   | **`received_sms` in the daily reconciliation** and in the retention job; a re-parse action for unparsed messages (open gaps of the payments port)                                                                                                                                                               | Nothing                                                |
| B7   | **telebirr merchant checkout as a second door:** the adapter exists; a signed callback credits with no SMS and no cents                                                                                                                                                                                         | A telebirr merchant contract and keys                  |
| B8   | **The national instant payment system (EthioPay-IPS, live since Feb 2026) through a bank:** a payment request or QR any bank or wallet app can pay                                                                                                                                                              | An acquiring bank offering it to merchants: to confirm |
| B9   | **A statement feed for CBE** (file, email or API from the bank) as an independent check beside the balance chain                                                                                                                                                                                                | The bank                                               |

Considered and not planned: unique whole-birr amounts (players round them), vouchers and agents
(cash channels are excluded by policy), other aggregators (kept as a fallback only).

## 6. Part C: withdrawals (the manual part)

A payout is automatic when three things happen without a person: the money is **sent**, the result
is **known for certain**, and the books **match**. The rules that stay: money goes only to the
player's own phone wallet or a bank account in their KYC name; the person who approves never pays;
a hold returns to the player only on proof that nothing was sent.

| #   | Option                                                                                                                                                                                                                                                                                      | People still needed                           | Needs                                                                                                        | Verdict                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | **Faster hands:** claim a batch instead of one payout, a pick list sorted by institution with copy buttons for number and amount, the queue on the operator's phone                                                                                                                         | Operators, at two to three times today's pace | Nothing                                                                                                      | **Do first** (days)                                                                                                                                                                                                                                                      |
| C2  | **Settle on double proof:** when the outgoing SMS names the claimed payout's amount and destination **and** telebirr's own receipt page confirms payer, receiver and amount, the payout is settled without a click. One proof alone still only proposes                                     | Operators send; nobody settles                | Owner decision and a security review (it changes a four-eyes step); telebirr only                            | **Do second**, behind a switch that is off by default                                                                                                                                                                                                                    |
| C3  | **Batch files:** every few minutes the system writes one file of approved payouts in the bulk-payment format of the telebirr business portal or the bank's corporate banking; one operator uploads it, a second approves it there, and the result file or the outgoing SMS settle each line | One upload per batch                          | The bulk-payment feature on the company's accounts and its file format: to confirm                           | **The quick win** if the accounts have it: 500 transfers become one upload                                                                                                                                                                                               |
| C4  | **telebirr business payouts by API** (disbursement): the worker sends, telebirr answers signed. The code path exists for automatic providers (attempt, query before resend, flags for unclear results)                                                                                      | Exceptions only                               | The disbursement product on a telebirr merchant contract (its API is not public: to confirm), a funded float | **The target** for wallet payouts                                                                                                                                                                                                                                        |
| C5  | **Bank host-to-host** transfers for bank-account payouts and large amounts                                                                                                                                                                                                                  | Exceptions only                               | A corporate agreement with the bank                                                                          | With C4                                                                                                                                                                                                                                                                  |
| C6  | **EthioPay-IPS bulk or instant payments through a bank:** one rail pays every bank and wallet                                                                                                                                                                                               | Exceptions only                               | The bank's product on the instant system: to confirm                                                         | **Best long-term**                                                                                                                                                                                                                                                       |
| C7  | **Chapa transfers:** the adapter with automatic payouts is already in the code                                                                                                                                                                                                              | Exceptions only                               | A Chapa contract and its fees                                                                                | Fallback; the fastest to switch on if the owner changes their mind                                                                                                                                                                                                       |
| C8  | **A robot on the handset** (a modem or phone that dials the `*127#` menu by itself)                                                                                                                                                                                                         | None                                          | The wallet PIN stored on a machine                                                                           | **Not recommended:** it likely breaks the wallet's terms, breaks with every menu change, and whoever reaches that machine can empty the float. If ever tried: a separate wallet with a small float, per-payout and hourly caps, and C2's double proof for every transfer |

Around every option:

- **Approval tiers.** Today one number decides (`autoApproveBelow`), with the wagering rule, the daily
  cap, exclusions and AML holds. Add: identity verified, account age, a destination that was paid
  before, and per-tier amounts, so only real exceptions reach a person.
- **Float forecast.** The system knows what every open bet would pay and when its matches end. Forecast
  the withdrawals of the next hours from that, and alarm before the payout account runs short.
- **Routing.** Once more than one rail pays out, pick per player: their wallet's rail first, the
  instant system otherwise, the manual queue when a rail is down.

## 7. Recommended order

1. **Now, no contract needed:** A1 (so everything after is measured), B2 and B4 (deposits stop running
   out), C1 (faster hands), A2 and A3 (cache), B6. Ask the owner for B1's real fixtures and start the
   provider conversations of section 8 on day one: they take the longest.
2. **Next:** A4 to A6 (several API processes, streams apart, leaner bet), C2 after its review, C3 as
   soon as a bulk format is known, B3 once B1 allows it, A10.
3. **When contracts arrive:** C4 and B7 (telebirr), C5, then B8 and C6 (the instant system), routing.
4. **When the test says so:** A7, A8, A9, A11.

## 8. Owner decisions and calls

| #   | Decision or call                                                                                                                        | Recommended                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| D1  | Ethio telecom account manager: merchant account for a betting operator with **disbursement** and bulk payment; sandbox and API document | Call first                                                               |
| D2  | Main bank: bulk-upload format and result file, statement feed, host-to-host, and its EthioPay-IPS merchant products                     | Call first                                                               |
| D3  | How many collection accounts per institution (each one multiplies the deposit amounts, B2)                                              | Two per institution to start                                             |
| D4  | Settle on double proof (C2): allow it for telebirr                                                                                      | Yes, after the security review, with a per-payout cap                    |
| D5  | Hold on amounts of cancelled deposits (B4): 2 hours today                                                                               | 30 minutes for deposits the player cancelled; unchanged for expired ones |
| D6  | Approval tiers (amounts per tier, account age)                                                                                          | Start strict; loosen with a month of data                                |
| D7  | Server sizes and a second server (A11)                                                                                                  | Decide after A1's baseline                                               |
| D8  | Counsel and the regulator: confirm the tiers and C2 fit the licence and the anti-money-laundering rules                                 | Before C2 goes live                                                      |

## 9. Risks

- **Provider access is the long pole.** Every "to confirm" above can move a date; the first group in
  section 7 exists so progress does not wait for it.
- **The handset stays the trust anchor** of the SMS rail. More accounts and handsets (B2, B5) mean more
  devices to guard; the receipt audit and the balance chain stay on for each.
- **Removing a click removes a check.** C2 and the approval tiers move review from every payout to the
  exceptions; they start strict, behind switches, with caps.
- **Float.** Automatic payouts stop when the payout account is empty; the forecast and alarm belong to
  the first automatic rail, not to a later phase.
- **The numbers of section 2 are assumptions** until the load test and the live figures replace them.

## Sources (checked 15 Nov 2026)

- EthioPay-IPS launch and features: <https://paymentexpert.com/2026/02/16/ethiopia-instant-payments-launch/>,
  <https://financialit.net/node/69469>,
  <https://techtrendske.co.ke/2026/06/04/ethiopias-ethiopay-ips-hits-1-million-daily-transactions/>
- National payment gateway and QR plans (National Bank of Ethiopia, 2024):
  <https://nbe.gov.et/wp-content/uploads/2024/04/8.Building-the-Foundation-for-Unified-Transactions-with-a-Focus-on-Enabling-Merchant-Payment-Solutions-–-National-Payment-Gateway-and-QR-codes.ppt_-EDPC.pdf>
- telebirr merchant access and products (bulk disbursement is listed as a product; no public API):
  <https://zirzir-docs.pages.dev/providers/telebirr>, <https://telebirr.ethiotelecom.et/?p=12006>
- M-PESA Ethiopia (no public merchant API found):
  <https://www.theeastafrican.co.ke/tea/business/safaricom-launches-m-pesa-in-ethiopia-amid-civil-unrest-4338330>
- ArifPay as a licensed switch operator with bulk payments:
  <https://techafricanews.com/2025/09/29/arifpay-becomes-ethiopias-first-licensed-private-switch-operator/>
