# Plan: 10,000 people at a time, and deposits and withdrawals without manual work

_Written 15 Nov 2026. Status key: `[ ]` not started. Nothing in this plan is built yet._

Two goals:

1. The platform serves **10,000 people at the same time** with fast pages and no lost or doubled
   money.
2. **Deposits and withdrawals run without staff typing transfers by hand**, without depending on
   an aggregator gateway such as Chapa.

What is measured, what is an estimate and what still has to be confirmed with a provider is marked
as such. Provider facts were checked on the web on 15 Nov 2026 (sources at the end); none of the
providers publishes its merchant API openly, so every provider row needs a meeting before it is
built.

## 1. Where the system is today

| Area            | Today (from the code and `docs/load-testing.md`)                                               |
| --------------- | ---------------------------------------------------------------------------------------------- |
| Bet placement   | **Measured:** about 95 bets/s on one API process (4 shared CPUs), p95 0.5 s at 50 connections  |
| What limits it  | One Node process is CPU-bound; about 23 database queries per bet                               |
| API             | One process, database pool of 10 connections; stateless, so it can be copied                   |
| Lists and pages | Every page render asks the API again (no shared cache); lists are the same for everyone        |
| Live odds       | Server-Sent Events from the API process, fed by Redis pub/sub                                  |
| Deposits        | Provider adapters: telebirr checkout (deposits only), Chapa, mock; CBE Birr and M-PESA empty   |
| Withdrawals     | Auto-approved under a set amount, else a finance review queue; a worker sends the payout       |
| Payout safety   | A hold returns to the player only on proof the provider did not pay; unclear cases are flagged |
| Books           | Double-entry ledger, idempotency keys, daily reconciliation, provider statement matching       |

The money side is already built for automation: idempotent payouts, query-before-resend, flags for
unclear results, reconciliation. What is missing is (a) capacity beyond one process and (b) rails
that move money without a person.

## 2. What "10,000 at a time" means in numbers

The targets below are **assumptions** until replaced with numbers from real traffic. They are set
high on purpose (a big match evening).

| Load                   | Assumption for 10,000 people online                   | Target                                |
| ---------------------- | ----------------------------------------------------- | ------------------------------------- |
| Page and list requests | One every 15 s per person: about 700/s                | p95 under 400 ms                      |
| Open live streams      | 6,000 at once (people on live and event pages)        | Odds change reaches the phone < 2 s   |
| Bets                   | 60/s normal, **250/s** in the minutes before kick-off | p95 under 500 ms, 0 errors on money   |
| Deposits               | 15/s peak (before kick-off)                           | Credited within 30 s of paying        |
| Withdrawals            | 5/s peak (after final whistles)                       | Paid within 5 min when auto-approved  |
| Errors                 |                                                       | Under 0.5% of requests                |
| Money                  |                                                       | Reconciliation clean after every test |

## 3. Capacity plan

Each step ends with the load test; a step is done when the test passes, not when the code is
written.

### Step 1: a load test that looks like 10,000 people

- [ ] Extend `scripts/load` (today: bets and one list) with the full mix of section 2: page
      requests through the web app, 6,000 open live streams, bets with the kick-off spike, deposits
      and withdrawals against the mock provider
- [ ] A staging environment with the same shape as production (section 3, step 7), never the
      production database
- [ ] Record the first run as the baseline; every later step is compared with it

### Step 2: several API processes

The API keeps no state of its own (sessions, rate limits and live fan-out are in Postgres and
Redis), so more processes need no redesign.

- [ ] Run the API as N processes behind the proxy (start with 6 on two servers); health-checked,
      restarted one at a time on deploy
- [ ] Put **PgBouncer** between the API and Postgres (transaction pooling), so 6 to 12 processes do
      not open hundreds of database connections; check that the driver's prepared statements work
      with it, or switch them off
- [ ] Give the live stream its own process type (same code, only the stream route), so thousands
      of open connections never slow bet placement
- [ ] Raise open-file limits and proxy timeouts for long-lived streams

Expected (estimate, to be measured): six processes give about 400 to 500 bets/s before the shared
house account lock (step 4) becomes the limit.

### Step 3: stop asking the database the same question 700 times a second

Lists are identical for every visitor and already allow 5 seconds of staleness
(`cache-control: max-age=5`).

- [ ] Cache list and navigation answers (`/sports`, competitions, `/events` pages) in Redis for 2 s,
      one refresh per key at a time, so a spike costs one query set instead of hundreds
- [ ] Let the web server reuse the same catalogue answer for 2 s instead of fetching it for every
      page render (pages still render per visitor: language and theme differ)
- [ ] Serve static files (JS, CSS, icons) from a CDN or the proxy's cache; they are already
      compressed once and named by content
- [ ] Prices on the page stay correct through the live stream; bet placement always reads the real
      price from the database, so a cached list can never give a stale price on a bet

### Step 4: the bet path

- [ ] Remove the known extra queries (`docs/load-testing.md`: the re-read of the bet, the two user
      reads); goal about 15 queries per bet instead of 23
- [ ] Measure the ceiling of the single `house_stakes` ledger row with 6 processes. If it is below
      300 bets/s, split it into a small number of shard accounts (for example 8, chosen by player
      id); reconciliation then sums the shards. This changes the ledger layout and needs its own
      review and property tests before it ships
- [ ] Keep one database transaction per bet; nothing here loosens the money rules

### Step 5: the database

- [ ] One primary sized for the write load (start: 16 CPUs, 64 GB, NVMe; an estimate to confirm in
      the test), tuned (`shared_buffers`, `max_wal_size`, autovacuum for the hot tables)
- [ ] A streaming replica: failover target, and the back office's heavy reads (reports, searches,
      daily summaries) move to it
- [ ] Partition the tables that only grow (`ledger_entries`, `outbox_events`, audit log, bet legs)
      by month, so indexes stay in memory and old months can be archived
- [ ] Point-in-time recovery tested by a real restore (the runbook exists)

### Step 6: the worker

- [ ] Separate queues with their own concurrency: settlement, payouts, SMS, regulator reports, feed;
      a settlement burst after 30 final whistles must not delay payouts
- [ ] Settle in batches per event; measure a 10,000-bet event end to end
- [ ] Two worker processes on different servers; jobs are already idempotent

### Step 7: starting hardware (estimates, corrected by the test)

| Role                                      | Count       | Size                 |
| ----------------------------------------- | ----------- | -------------------- |
| Proxy / load balancer                     | 2           | 2 CPUs, 4 GB         |
| App server (API + web + stream processes) | 3           | 8 CPUs, 16 GB        |
| Worker                                    | 2           | 4 CPUs, 8 GB         |
| Postgres primary + replica                | 2           | 16 CPUs, 64 GB, NVMe |
| Redis                                     | 1 + standby | 2 CPUs, 8 GB         |

Hosted in Ethiopia where the licence and the payment partners require it (also needed for some
payment options in section 5: local receipt pages can refuse foreign addresses).

### Step 8: staying up on a bad night

- [ ] Dashboards and alerts on the numbers of section 2 (latency, errors, queue age, stream count,
      replication lag, payout age)
- [ ] Load shedding in order: back-office reports first, then list freshness (cache 2 s to 10 s),
      never bet placement or payments
- [ ] A dry run before every big fixture weekend: the load test at 1.5 times the target

## 4. Payments: what "automatic" has to mean

Each money movement needs three things without a person:

1. **Start it** (the player asks; the system instructs the rail).
2. **Know the result for certain** (a signed callback or a status query, never a screenshot).
3. **Match it in the books** (the daily statement of the rail equals the ledger).

A person stays only for the exceptions: unclear results, risk flags, large amounts.

Rules that do not change: withdrawals go **only to the player's own registered, verified number or
account**; every movement is idempotent; all collection accounts are **merchant accounts in the
company's name** (personal wallets or accounts are not an option: they break provider terms, cannot
be reconciled and put the licence at risk).

## 5. Every option, compared

### Deposits

| #   | Option                                        | How it works                                                                                                                                                                                                                                                           | Automatic?                     | Needs                                                                                                                                 | Verdict                                                                                                                               |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **telebirr direct (merchant)**                | Player approves a prompt or checkout in telebirr; Ethio telecom calls back, signed                                                                                                                                                                                     | Fully                          | telebirr merchant contract and keys (access through the Ethio telecom developer portal and an account manager)                        | **Do first.** The deposit adapter already exists in `packages/payments`                                                               |
| D2  | **M-PESA Ethiopia direct**                    | Same idea on Safaricom's wallet                                                                                                                                                                                                                                        | Fully, if they give API access | Contract with Safaricom Ethiopia. Its API is not the Kenyan Daraja one and is not public: **to confirm**                              | Second wallet                                                                                                                         |
| D3  | **CBE Birr / bank direct**                    | Prompt or checkout from the bank's wallet or account                                                                                                                                                                                                                   | Fully                          | Agreement with the bank (CBE first, then the banks most players use)                                                                  | Third, by player demand                                                                                                               |
| D4  | **EthioPay-IPS through a bank**               | The national instant payment system (live since Feb 2026): a payment request or QR that any bank or wallet app can pay                                                                                                                                                 | Fully                          | An acquiring bank that offers request-to-pay / QR to merchants. Merchant API is not public: **to confirm** with the bank or EthSwitch | **Best long-term single rail:** one integration, every bank and wallet                                                                |
| D5  | **Transfer + receipt number** (no contract)   | Player sends money to the company's merchant account from any app, then types the transaction number. The system fetches the official receipt (telebirr and CBE publish receipt pages), checks receiver, amount, date and that the number was never used, then credits | Yes, in seconds                | Nothing new. Servers in Ethiopia (the receipt pages can refuse foreign addresses)                                                     | **Quick win**, as a bridge and a fallback. The receipt pages are not a contracted API and can change, so it must not be the only rail |
| D6  | **Transfer + statement matching**             | The bank or wallet sends the company's incoming-transfer feed (API, file or email); the system matches each line to a pending deposit by a reference or by the sender's verified number                                                                                | Yes, within the feed's delay   | A statement feed from the bank                                                                                                        | Good backstop for D5: catches deposits whose receipt number was never typed                                                           |
| D7  | **Exact-amount matching**                     | The system asks for a unique amount (for example 500.37 ETB) so the incoming line identifies the player without a reference                                                                                                                                            | Yes                            | D6's feed                                                                                                                             | A trick for rails with no reference field. Confuses players; only where nothing else works                                            |
| D8  | **SMS forwarder**                             | A phone with the merchant SIM forwards "you received…" messages to the server                                                                                                                                                                                          | Yes                            | A device per account                                                                                                                  | **Not recommended alone:** SMS can be faked or delayed. Only as a trigger that then runs the D5 receipt check                         |
| D9  | **Other aggregators** (ArifPay, SantimPay, …) | One contract, many banks and wallets                                                                                                                                                                                                                                   | Fully                          | Their contract and fees                                                                                                               | Kept as a fallback. ArifPay is a licensed switch operator and advertises bulk payments                                                |
| D10 | **Vouchers / agents**                         | Cash to an agent, a code to the player                                                                                                                                                                                                                                 | Yes for the player             | An agent network                                                                                                                      | Outside today's policy (no cash channels); not planned                                                                                |

### Withdrawals

| #   | Option                                                 | How it works                                                                                                                                                                                                                          | Automatic?                                              | Needs                                                                                                                                                       | Verdict                                                                                                   |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| W1  | **telebirr business payout (B2C / bulk disbursement)** | The system instructs Ethio telecom to pay the player's own number; signed result                                                                                                                                                      | Fully                                                   | The disbursement product on the merchant contract (telebirr lists bulk disbursement as a product; the API is not public: **to confirm**) and a funded float | **The target** for most players. The adapter must be written (today telebirr is deposit-only in the code) |
| W2  | **Bank host-to-host transfers**                        | The bank accepts signed payment instructions over an API or secure file channel                                                                                                                                                       | Fully                                                   | Corporate agreement with the bank                                                                                                                           | For bank-account withdrawals and large amounts                                                            |
| W3  | **EthioPay-IPS bulk payments through a bank**          | Instant credit to any bank or wallet through the national switch                                                                                                                                                                      | Fully                                                   | The bank's bulk or API product on the instant system: **to confirm**                                                                                        | **Best long-term:** one rail pays everyone                                                                |
| W4  | **Payout batch file** (no contract)                    | Every 10 minutes the system builds one file of approved payouts in the bank's or wallet's bulk-upload format. Finance uploads it and approves once (two people); the result file is imported and each payout is marked paid or failed | One upload per batch instead of one transfer per player | Only the bulk-upload feature of the existing business account                                                                                               | **Quick win:** turns 500 manual transfers into 1 upload, with no typing errors                            |
| W5  | **Other aggregators' payout APIs**                     | As D9                                                                                                                                                                                                                                 | Fully                                                   | Contract, fees                                                                                                                                              | Fallback                                                                                                  |
| W6  | **Robots that drive a banking app or USSD menu**       | Software taps through the app like a person                                                                                                                                                                                           | Looks automatic                                         | Stored PINs, devices                                                                                                                                        | **Rejected:** breaks provider terms, breaks with every app update, and keeps payment PINs on a server     |

## 6. Recommended path

**Phase A, weeks 1 to 3: no new contract needed**

- [ ] D5: deposit by receipt number for telebirr and CBE (new deposit kind "transfer", a table of
      used transaction numbers with a unique index, checks for receiver, amount, age, reuse; limits
      and velocity rules; back-office view of refused claims)
- [ ] W4: payout batches (batch table, file builders per bank or wallet format, two-person approval
      in the back office, result import, the existing flag rules for lines without a clear result)
- [ ] Smarter auto-approval (section 7), so only real exceptions reach finance
- [ ] Start the paperwork for phases B and C on day one: it has the longest lead time

**Phase B, weeks 3 to 8: direct wallets**

- [ ] D1 live with the existing telebirr adapter (sandbox, then production keys)
- [ ] W1: telebirr payout adapter, with a float monitor and an alert when the float cannot cover the
      approved queue
- [ ] D2 and D3 adapters once the contracts are signed (the empty adapters are in place)

**Phase C, months 2 to 4: the national instant system**

- [ ] D4 and W3 through the acquiring bank; then a small router picks the rail per player (their
      wallet first, the instant system otherwise) and fails over when a rail is down
- [ ] D5 and W4 stay as the fallback when a provider is down

**Result:** from phase A, staff stop typing transfers; from phase B, most money moves with no staff
step at all; phase C removes the dependence on any single wallet.

## 7. Auto-approval rules for withdrawals

A withdrawal is paid without review only when **all** of these hold; anything else goes to the
existing review queue with the reason shown.

- Identity verified, and the payout goes to the player's own registered number or an account in the
  same verified name
- Amount under the tier limit (start low, raise with experience); daily and weekly totals per player
  under their caps
- Deposits have been played through at least once (no deposit-and-withdraw cycling)
- No open AML flag, exclusion, disputed deposit or pending result correction
- The destination has been used before, or the account is older than a set age
- The rail's float covers it

## 8. What to decide and who to call first

1. Ethio telecom account manager: telebirr merchant for a betting operator, with **disbursement**;
   ask for the sandbox and the payout API document
2. Your main bank: (a) bulk-upload file format and result file, (b) statement feed, (c) host-to-host
   or instant-system (EthioPay-IPS) merchant products: request-to-pay, QR, bulk payments
3. Safaricom Ethiopia: merchant API for M-PESA
4. Counsel and the regulator: confirm D5 (receipt-verified transfers) and the auto-approval tiers
   fit the licence and the anti-money-laundering rules; confirm providers accept betting merchants

## 9. Risks

- **Provider access is the long pole.** No provider publishes its API; every "to confirm" above
  can move a date. Phase A exists so progress does not wait for them
- **Receipt pages (D5) are not a contract.** They can change or go offline; hence statement matching
  (D6) behind them and direct rails as the goal
- **Float.** Automatic payouts stop when the payout account is empty; the monitor and alert are
  part of W1, not an extra
- **Fraud moves to wherever review is removed.** The rules of section 7 start strict and are
  loosened with data
- **Capacity numbers are assumptions** until the 10,000-person test runs on production-shaped
  hardware

## Sources (checked 15 Nov 2026)

- EthioPay-IPS launch and features: <https://paymentexpert.com/2026/02/16/ethiopia-instant-payments-launch/>,
  <https://financialit.net/node/69469>,
  <https://techtrendske.co.ke/2026/06/04/ethiopias-ethiopay-ips-hits-1-million-daily-transactions/>
- National payment gateway and QR plans (National Bank of Ethiopia, 2024):
  <https://nbe.gov.et/wp-content/uploads/2024/04/8.Building-the-Foundation-for-Unified-Transactions-with-a-Focus-on-Enabling-Merchant-Payment-Solutions-–-National-Payment-Gateway-and-QR-codes.ppt_-EDPC.pdf>
- telebirr merchant access and products: <https://zirzir-docs.pages.dev/providers/telebirr>,
  <https://telebirr.ethiotelecom.et/?p=12006>
- M-PESA Ethiopia: <https://www.theeastafrican.co.ke/tea/business/safaricom-launches-m-pesa-in-ethiopia-amid-civil-unrest-4338330>
- ArifPay as licensed switch operator with bulk payments:
  <https://techafricanews.com/2025/09/29/arifpay-becomes-ethiopias-first-licensed-private-switch-operator/>
- Receipt verification of telebirr and CBE transfers (third-party tools that read the official
  receipt pages): <https://www.github.com/Vixen878/verifier-api>, <https://verify.et/docs/get-started>
