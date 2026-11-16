# SMS deposit rail and manual payouts

The `sms` payment provider, ported from Melabingo. A player asks to deposit, say, ETB 100 and is told to
send **exactly** ETB 100.xx (1–99 extra santim, unique among open deposits for 2 h) to one of our collection
accounts. The collection handset (a company Android phone holding the collection SIM and the bank's SMS
number) forwards each confirmation SMS to `POST /payments/webhooks/sms`. We parse it, match it to the open
deposit by that exact amount and credit the player, in one database transaction with its ledger posting and
outbox events. Withdrawals on this rail are **manual payouts**: staff send the money by hand from a
collection account, under four eyes.

What makes a credit safe, and what you check when something looks wrong:

- **The amount is the reference.** The SMS is only evidence that money arrived. A player who pastes an SMS
  or a transaction number in "Paid, but your balance has not changed?" only gives us a lookup key: we credit
  what the handset forwarded, or what the institution's own receipt page confirms (telebirr), never the
  pasted text.
- **A debit never credits.** Money leaving a collection account at most _proposes_ that it paid a manual
  payout.
- **The handset is the trust anchor.** Anyone who controls it, or the gateway secret, can inject SMS. Two
  independent checks run on the live rail: the **receipt audit** (every credited telebirr SMS against Ethio
  Telecom's receipt page) and the **balance chain** (the balance each SMS reports must move by exactly what
  the messages say; the only check for CBE).
- **Policy differences from Melabingo:** a payment from another phone (`third_party_payer`) or of another
  amount (`amount_mismatch`, typically a rounded amount) is **flagged for staff**, not credited; payouts go
  only to the player's own phone wallet or a bank account in their own (KYC) name, confirmed with an SMS
  code and by the operator at settlement. No payouts to third parties.

Who: `sms.review` (admin, finance, compliance) works the SMS page; `payouts.settle_manual` (admin, finance)
claims and settles manual payouts; `withdrawals.approve` approves withdrawals as for every provider.
Back office: **SMS rail** (`/sms`: health panel, review queue, all messages) and **Manual payouts**
(`/manual-payouts`).

In demo mode the rail is **simulated** (`SMS_RAIL_MODE=simulated`, demo collection accounts, play money):
the deposit screen offers "Demo: play the bank" and the dev SMS simulator sends the SMS. The database
refuses simulator SMS in a licensed database. Licensed mode only **warns** at start (it does not refuse) about
SMS-rail settings that are not production-ready: the simulated rail, a missing gateway secret,
`RECEIPT_VERIFY=off`, `PAYOUT_REQUIRE_PROOF` unset (CLAUDE.md "Operating mode"). Check the start-up log.

## Alarms

Alarms are `error` log lines with an `alarm` field; wire the log-based alerts to these names.

| `alarm`                    | Meaning                                                                                                                                                                                                       | Do                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sms_receipt_rejected`     | A **credited** telebirr SMS is contradicted by the receipt page (not found, other receiver…)                                                                                                                  | [Receipt alarm](#receipt-alarm-a-possibly-forged-sms). SEV1 until explained                |
| `sms_balance_drift`        | The balance an SMS reports moved by a different amount than the messages say                                                                                                                                  | [Balance drift](#balance-drift)                                                            |
| `payout_float_low`         | A collection account's last known balance (from its SMS) is below the withdrawals the open bets are expected to cause (`FLOAT_FORECAST_*`)                                                                    | Top up that account before the matches end; the health panel shows the forecast            |
| `sms_gateway_silent`       | No SMS from the handset for 30 minutes after 06:00 EAT                                                                                                                                                        | [Handset offline](#handset-offline)                                                        |
| `sms_account_silent`       | One collection account (`account` in the line) has players waiting on deposits older than 30 minutes and its handset forwarded nothing on it for 30 minutes (live rail, after 06:00 EAT; once per 30 minutes) | [Handset offline](#handset-offline), for the handset of that account                       |
| `sms_review_backlog`       | More than 10 SMS wait for a person, or the oldest has waited over 15 minutes                                                                                                                                  | Work the [review queue](#the-review-queue)                                                 |
| `manual_payout_waiting`    | An approved manual payout has waited more than 2 hours                                                                                                                                                        | [Manual payouts](#manual-payouts)                                                          |
| `manual_payout_claim_idle` | A claimed manual payout (`processing`) has had no settle, release or fail for over 30 minutes; one line per payout per 30 minutes                                                                             | [Manual payouts](#manual-payouts): the operator who holds it settles, releases or fails it |

With `OWNER_ALERT_PHONES` set each alarm above also texts the owner once (at most one per alarm and
`OWNER_ALERT_MIN_INTERVAL_MINUTES`, default 30) with what the rail already did, e.g. "It stays credited and is
held for staff"; the alert is the heads-up, this runbook is what to do ([`docs/scraper.md` 6.3a](../scraper.md)).

When the receipt page is slow or down a check is `indeterminate` and retried a few times before it is
recorded as final; after repeated failures the breaker opens for a while and the health panel shows
"Receipt page: open". Deposits keep being credited from the SMS; the audit catches up when the page is back.

## The review queue

SMS rail → Review queue. Receipt alarms are listed first, then the oldest first. Each row shows the
institution, direction, amount, reference and payer, the status and the raw message.

| Status                | Meaning                                                                          | Do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flagged`             | Matched a deposit but was flagged: `third_party_payer` or `amount_mismatch`      | Call the player. If they confirm who paid (and it is not a payment on someone else's behalf), **Credit to player** (prefilled) with a note. Otherwise **Close**.                                                                                                                                                                                                                                                                                                                                                                               |
| `unmatched`           | A credit that fits no open deposit: late, a typo in the amount, an unknown payer | Find the player (by payer phone or name in Players). If you are sure, **Credit to player** with their id and a note; if not, leave it and ask.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ambiguous`           | Fits two open deposits                                                           | Ask both players; credit the one who paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unparsed`            | No parser could read it: a new message shape, or a non-payment SMS               | Read it. Not a payment: **Close**. A payment: leave it open and escalate to engineering with the text (capture it as a fixture, below). Staff never type an amount, so it cannot be credited from here. Once engineering has deployed the fixed parser, press **Read again**: the stored text is parsed again and the message is handled as when it arrived (a credit pays only a deposit that existed when the money moved, and one whose hold has run out goes to the queue as `unmatched`). Until then tell the player it is being handled. |
| `ignored_debit`       | Money left a collection account and fits no claimed manual payout                | Someone sent money that is not a recorded payout, sent it before claiming, or sent it to another number: find out who. Close only with an explanation.                                                                                                                                                                                                                                                                                                                                                                                         |
| `settlement_proposed` | An outgoing transfer that looks like it paid a claimed manual payout             | Nothing here: the operator settling that payout links it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Rules: a note is required for every action and is audited. **Credit** posts exactly the amount in the SMS
(never what the player says they sent), once: the message is then `credited_by_staff`. Never credit a
flagged deposit from the generic Withdrawals → Flagged deposits tab; the API refuses it (`sms_deposit_flag`)
so the SMS and the deposit cannot get out of step. A credited player still has to bet the deposit before
withdrawing, as for every provider.

## Receipt alarm: a possibly forged SMS

A credited SMS whose receipt page says otherwise. The credit is **not** reversed automatically.

1. Open the row (top of the queue): note the reference, the amount, the reason (`not_a_receipt`: no such
   transaction; `reference_mismatch`; `receiver_not_ours`: paid to another account; `amount_absent`;
   `not_completed`) and the stored receipt excerpt.
2. Look the reference up yourself in the telebirr merchant portal (or the receipt link) for the collection
   account. Check the balance-chain result on the health panel too.
3. **The money arrived** (the receipt page was wrong or changed shape): **Acknowledge alarm** with what you
   found. If the page changed shape, capture it as a fixture (below): every credit will alarm until fixed.
4. **The money did not arrive:** treat it as fraud. SEV1 ([incident basics](incident-basics.md)). Do not
   approve or pay any withdrawal of that player (reject the open ones with the incident number; a manual
   payout cannot leave without an operator), check the handset (who had it, is the forwarder still the one
   we installed) and rotate `SMS_GATEWAY_SECRET` (below). The back office has no balance adjustment yet:
   the correction is an engineering task through the ledger services, never SQL. Acknowledge the alarm with
   the incident number.

## Balance drift

`credited_more_than_arrived` (the account grew less than we credited) is the forged-SMS signature: handle it
like a receipt alarm, starting from the SMS credited in the drift window. `arrived_more_than_seen` means SMS
went missing (handset offline, the forwarder filtered a sender): find the missing messages on the handset
and forward them again, or let the players use the "I paid" check. Drift is computed over the last 24 h, per
institution, hourly, and shown on the health panel. A refund or bank fee that sends no SMS also shows as
drift: write it down so the next person recognises it.

## Handset offline

`sms_gateway_silent` or `sms_account_silent`, or players say their deposits do not arrive.

1. Check the phone: power, wifi/data, the forwarder app running and not battery-optimised, the SIM present.
2. Meanwhile deposits keep working: a telebirr player can paste the confirmation SMS or its transaction
   number and is credited once the receipt page confirms it (source `receipt`). CBE payments wait in the
   queue until the handset is back.
3. If the phone is lost or stolen: rotate `SMS_GATEWAY_SECRET` at once, set up the spare, and ask the telco
   to block the SIM and move the number.
4. Once back, forward the messages it missed (the forwarder's resend). Duplicates are recognised (same
   sender and text, or same reference) and change nothing. A late message only pays a deposit that existed
   when the money moved (the institution's time in the SMS, or the handset's receive time), so a backlog
   cannot credit a newer deposit that was handed the same amount; messages whose deposit expired more than
   2 hours ago land in the review queue as `unmatched`.

### The handset

- A company-owned Android phone on mains power and wifi, in a locked room, screen lock on, used for nothing
  else. A second phone already set up with the forwarder, without the SIM, as the spare.
- The forwarder posts JSON `{ "sender": "...", "text": "...", "receivedAt": <epoch ms> }` to
  `https://<api host>/payments/webhooks/sms` with the header `x-gateway-secret: <SMS_GATEWAY_SECRET>`
  (a `secret` field in the body is accepted for forwarders that cannot set headers).
- **One account per handset.** Each collection account has its own space of exact amounts (99 open
  deposits of one amount per account), and the server gives a new deposit the account with the most free
  amounts. A message only pays a deposit of the account it arrived on, so the forwarder on each handset
  must add `"account": "<id>"` to its JSON: the `id` of that account in `SMS_COLLECTION_ACCOUNTS`
  (default `<institution>:<account>`, e.g. `telebirr:0911000001`). With one account configured the field
  may be left out. With several and no `account`, the message is kept in the review queue as unmatched
  (never matched on a guess); an `account` the server does not know is refused with 400
  `unknown_collection_account`. Set the field on every forwarder **before** adding a second account.
  Do not change an account's `id`, or take an account out of the list, while deposits to it are open: their
  payments would wait in the review queue (staff can credit them by hand).
- Allowed senders only: the collection institutions' SMS numbers (`127` / `telebirr`, `CBE`). Do not forward
  personal messages.
- If the forwarder has fixed egress addresses, list them in `SMS_GATEWAY_ALLOWLIST`; requests from other
  addresses get 403.
- Every day before 10:00: the balance in the telebirr app and the CBE statement equal the latest balance on
  the health panel, and the balance check is ok.

## Manual payouts

A withdrawal on the `sms` provider goes `requested` → `approved` (by a person with `withdrawals.approve`, as
for every provider, or automatically below the threshold) → **claimed** by an operator (`processing`) →
`paid`, or back to `approved` (**Release**: nothing was sent) or `failed` (the hold returns to the player).
The person who approved it can never claim or settle it, and only the operator who claimed it can settle,
release or fail it, so two operators never both send it. The worker never touches manual payouts.

1. Manual payouts → **Claim next 10** takes the oldest approved payouts nobody holds
   (`POST /admin/manual-payouts/claim-batch`, `{limit?: 1..20, ids?: up to 20 uuids}`; permission
   `payouts.settle_manual`). Each payout is claimed on its own through the single claim, with the same rules
   and audit line, so a refused one never blocks the others and the four-eyes rule holds per payout. Without
   ids the batch skips the payouts you approved yourself (you could never claim them) and goes on past any
   it has to refuse until it has claimed the number asked for, looking at up to five times as many; the
   answer lists each refusal with the single claim's code (`aml_review_pending` while compliance holds the
   player, `manual_payout_wrong_status` when another operator was quicker; asked for by id, your own
   approval gives `manual_payout_approver_cannot_pay`). Two operators claiming at once never get the same
   payout, and each gets work. **Claim** on a row still claims just that one.
2. **Your pick list** (top of the page, one column on a phone) shows what you hold, grouped by institution,
   oldest first: the destination (number, or account and holder name for a bank) and the exact amount, with
   **Copy number** and **Copy 1234.50** (the amount in plain birr: a dot, two decimals, no thousands
   separators) so nothing is retyped. Send the money from the collection account shown, to the destination
   shown: the player's own telebirr number, or a bank account with the holder name shown. For a bank, check that the name the bank shows for
   the account is the player's name before sending.
3. When the debit SMS comes in it is proposed for the payout (`settlement_proposed`): only a payout that is
   claimed, and only by a transfer made after the claim, so always **claim first, then send**. **Settle**
   with that SMS (or the transfer reference if the SMS did not come); tick "holder name confirmed" for a
   bank. A typed reference that matches a debit SMS we hold is checked against it: same amount, for a wallet
   the player's number, and a transfer made after your claim (5 minutes of clock skew allowed). With
   `PAYOUT_REQUIRE_PROOF=true` the debit SMS is required. The code does **not** enforce that setting in
   licensed mode: without it licensed mode only logs a start-up warning (or the `PAYOUT_PROOF_WAIVED`
   warning), and a reference that matches no SMS we hold settles without proof. Set
   `PAYOUT_REQUIRE_PROOF=true` in production.
4. If you cannot send it (the bank refuses, the name does not match): **Release** with a note before you have
   sent anything, or **Fail** with the reason if the money definitely did not leave and will not. Never fail a
   payout you are unsure about: find the transfer first.

A payout you claimed and then leave for 30 minutes raises `manual_payout_claim_idle` (log, and the owner text):
settle, release or fail it so it does not sit with you while others wait.

Refusals you may see when you settle:

| Code                              | Meaning                                                                                                                                                                                                  | Do                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settlement_reference_used`       | That reference already settled another payout                                                                                                                                                            | Check the reference in the collection account's history.                                                                                                                                                                              |
| `settlement_reference_mismatch`   | We hold an SMS with that reference for another amount, another payout, or that is not a debit                                                                                                            | Check the reference you typed.                                                                                                                                                                                                        |
| `settlement_destination_mismatch` | Wallet payout: the SMS for that reference shows the money going to another number. Bank payout: the SMS shows the money going to a mobile number (a wallet transfer), which never proves a bank transfer | Check the reference and the number you paid. If you sent it to the wrong number, do **not** settle, release or fail: tell a supervisor at once (the player is unpaid and the money has left).                                         |
| `settlement_proof_mismatch`       | The SMS is not the proposed proof; or, for a wallet payout, the SMS names no number and was not proposed for this payout                                                                                 | Use the SMS proposed on the row if there is one. Otherwise a supervisor checks the transfer in the collection account's history (number, amount, time) before anything else is done.                                                  |
| `settlement_proof_too_old`        | The SMS is of a transfer made before you claimed this payout (claim time minus 5 minutes)                                                                                                                | Use the reference of the transfer you sent after claiming. If you really sent this one before claiming, or the payout was released and claimed again after a transfer, a supervisor checks the history: never send a second transfer. |
| `settlement_proof_required`       | `PAYOUT_REQUIRE_PROOF=true` and no debit SMS for that reference yet                                                                                                                                      | Wait for the SMS; check the handset if it does not come.                                                                                                                                                                              |
| `holder_name_not_confirmed`       | Bank payout without the holder-name confirmation                                                                                                                                                         | Tick it once the bank showed the player's own name.                                                                                                                                                                                   |

## Capturing real fixtures

Parsers and the receipt reader are tested against fixtures in `packages/core/src/smsparse.fixtures.ts` and
`packages/payments/src/receipts/fixtures.ts`. Before go-live, and whenever a message or the receipt page
changes shape:

1. From the queue (raw text) or the handset, copy the SMS. Replace the payer's name and phone with made-up
   ones, keep everything else byte for byte (spacing, punctuation, the balance phrase).
2. Add it to the fixtures with the expected parse, and a test; fix the parser until the suite passes.
3. For a receipt page, save the HTML of a staff test payment (no player data) as a fixture.

## Rotating `SMS_GATEWAY_SECRET`

On a schedule, on every staff change involving the handset, and at once on a suspected leak. There is one
active secret: set the new one in the forwarder and the environment within a few minutes of each other and
recreate `api`. SMS forwarded with the old secret in between get 401 and stay on the handset: forward them
again afterwards (duplicates are harmless). See [rotating secrets](rotating-secrets.md).

## The daily reconciliation and the SMS rail

The daily reconciliation has a check `sms_credits`: every message that credited a deposit must name a
succeeded SMS deposit of the same player and amount with its ledger transaction, and every succeeded SMS
deposit must be backed by a received message (or by the message that flagged it). A difference is a missing
credit (the message says it paid, the deposit is not credited) or a credit with no message behind it. Treat
either as an incident: do not correct the ledger by hand, escalate to engineering with the run's mismatch.
