# Brief for the provider calls (D1 and D2)

For the owner, 15 Nov 2026. These calls unlock the withdrawal automation that needs no code
guesswork. They take the longest, so start them first. Your steer: **outside government platforms**
(progress file, section 3). So the call that matters is the bank (D2). The telecom call (D1) is only
for the case that you decide a telebirr integration is acceptable after all.

Be open about the business in both calls. Banks and telecoms check it, and an account closed without
notice costs more than a refusal now.

## Bring

- Company registration and licence documents, the account numbers now used to collect and pay.
- Volumes to plan for (the plan's assumptions, to be replaced by your real numbers): up to 10,000
  players online; deposits 2 a second before kick-off; **4,000 payouts a day, up to 600 in the hour
  after the evening's final whistles**; typical payout a few hundred birr.
- Who at the company can sign and who will operate (two people minimum: one prepares, another
  approves).

## Call 1: your bank (D2)

Ask for the corporate banking or relationship manager. Write the answers in the table at the end.

**Bulk payments (unlocks C3, the biggest saving: 500 transfers become one upload)**

1. Do business accounts have a bulk-transfer (payroll) upload in the web portal? Send us a sample file
   and the format (CSV, XLSX, fixed width), the columns, the encoding.
2. Limits: lines per file, amount per line, amount per file, per day. Fee per line. Cut-off times.
3. Is the money credited at once or at the bank's next batch? To accounts at other banks too? To
   mobile-wallet numbers (telebirr, M-PESA), or bank accounts only?
4. Approval by two people (one uploads, another approves) with separate logins, second factor and
   separate limits?
5. After processing: a result file or statement with **one line per payee**, success or failure with a
   reason and a bank reference? In what format, how soon, for how long kept?

**Statement feed (unlocks B9 and the daily match of the books)**

6. Can we get the account statement every day, or more often, as a file by email or SFTP, or through
   an API? Each credit and debit with date, amount, counterparty name and number, reference, running
   balance? How soon after the transaction?

**Host-to-host or API (unlocks C5, payments with no human upload)**

7. Does the bank offer an API or a host-to-host channel (SFTP with signed files) for payments and
   statements? What does onboarding need (documents, test environment, fees, weeks)?
8. Does the bank accept the company's activity on this account? Ask for the answer in writing.

## Call 2, only if telebirr is acceptable to you: Ethio telecom (D1)

telebirr is run by the state telecom. The existing collection and the read-only receipt check do not
depend on this call.

1. A merchant account for this business type, with **disbursement** (business to customer, bulk).
2. The API document and a sandbox: how a payout is requested, the signed result, how to query a
   payout by our own reference (so a repeated request never pays twice), callback signing.
3. Limits per payout, per day, per account; fees; how the float is funded and shown; settlement times.
4. Can the existing collection account be upgraded, or is a new merchant account needed?

## What each answer unlocks

| Answer                                              | Unlocks | Waits until                              |
| --------------------------------------------------- | ------- | ---------------------------------------- |
| A bulk-upload file format and result file           | C3      | the sample file arrives                  |
| A daily statement feed                              | B9      | the format arrives                       |
| An API or host-to-host channel                      | C5      | the specification and a test environment |
| A telebirr disbursement API (only if you accept it) | C4, B7  | the contract and the sandbox             |

## Write the answers here (and tell the next session)

| Question | Bank (D2) | Ethio telecom (D1) |
| -------- | --------- | ------------------ |
| 1 to 3   |           |                    |
| 4 and 5  |           |                    |
| 6        |           |                    |
| 7 and 8  |           |                    |

Put the sample files in a private place, not in the repository (account numbers, names).
