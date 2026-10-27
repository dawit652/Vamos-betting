# SMS and USSD betting (Phase 11)

Betting by text message and USSD menus, Betika style. **Both channels are off by default and stay
off until the regulator (ELS) approves them.** While a channel is off its inbound route answers
404 and nothing else changes.

## Switches

| Variable              | Default    | Meaning                                                                         |
| --------------------- | ---------- | ------------------------------------------------------------------------------- |
| `SMS_BETTING_ENABLED` | `false`    | `POST /channels/sms/inbound` handles texts (legacy name `FEATURE_SMS_BETTING`). |
| `USSD_ENABLED`        | `false`    | `POST /channels/ussd` handles callbacks (legacy name `FEATURE_USSD`).           |
| `SMS_AGGREGATOR`      | `mock`     | Only the demo mock exists until an aggregator is contracted.                    |
| `SMS_WEBHOOK_SECRET`  | dev secret | HMAC-SHA256 key over the raw body; production refuses the dev secret.           |
| `SMS_SHORT_CODE`      | `8123`     | Shown in help texts and the dev simulator.                                      |
| `USSD_AGGREGATOR`     | `mock`     | As above.                                                                       |
| `USSD_SHARED_SECRET`  | dev secret | Sent by the aggregator in a header; production refuses the dev secret.          |
| `USSD_SERVICE_CODE`   | `*123#`    | The code players dial.                                                          |

The switches live in the environment, not in the settings table: turning a channel on is a
deployment. In licensed mode the guard also refuses to start while a channel is on with its demo
`mock` aggregator (`SMS_AGGREGATOR` / `USSD_AGGREGATOR`): a channel needs a contracted aggregator
before it can take real-money bets.

## Text commands

Case-insensitive; spaces around tokens are ignored; `*` works like `#` (parser:
`parseTextCommand` in `packages/core/src/textcommand.ts`).

- **Bet:** `GAMEID#PICK#STAKE` (single) or `GAMEID#PICK#GAMEID#PICK…#STAKE` (multi, at most the
  bet rules' `maxLegs`). Picks: `1`, `X`, `2` (football 1X2; `1`/`2` on two-way sports), `OV25` /
  `UN25` (over/under 2.5 goals), `GG` / `NG` (both teams to score). The stake is whole birr
  (`50`, `050` and `50.00` are ETB 50; `50.5`, `5,000` and `1e3` are refused), read as bigint
  santim with no floating point. Whole birr of more than nine digits is refused with the maximum
  stake (SMS and USSD), not as unreadable. Replies show Game IDs zero-padded (`0123`), as USSD and
  coupons do.
- `BAL` (balance), `BETS` (last 3 bets), `JP` (open jackpot rounds: games and cost per
  combination; entering by SMS is out of scope), `HELP`, `STOP` / `START` (marketing SMS
  opt-out, stored in `users.sms_marketing_opt_out_at`).
- Anything else gets the syntax. Replies are in the player's language (Amharic for `am` and `ti`,
  English otherwise), at most 3 SMS parts; English replies fit one GSM-7 message.

## Placing a bet by SMS (`handleInboundSms`, `packages/db/src/channels/sms.ts`)

One transaction, retried on deadlock:

1. A per-number advisory lock (shared with USSD).
2. **Idempotency:** the aggregator's message id (`inbound_messages`, unique per aggregator). A
   redelivery never handles the text again. Its stored reply is queued again only when the last
   send was queued and handed to the job queue by the outbox at least 60 s ago, at most 3 sends
   in all, so neither a quick retry nor a send still waiting in the outbox (queue down, backoff)
   texts the player twice. A reused id with another text or sender is ignored and acknowledged as `not_available`
   with no reply (never the stored outcome).
3. **Rate limits per number:** 10 a minute and 60 an hour, counting the number's texts and the
   USSD sessions it started (one budget per number for both channels). Over a limit the text is
   not read, and "too many messages" is sent once per window.
4. **Who may bet:** the sender must be an active player with a verified phone. Every other
   number gets the same bilingual reply, whatever the reason, so a reply never tells whether a
   number is registered. `STOP` / `START` still work for any account. A sender that is not an
   Ethiopian mobile number gets no reply.
5. **Placement:** Game IDs and picks are resolved to selections under the player's lock with the
   selections locked `FOR SHARE`, then `placeChannelBet` calls `placeBet` (channel `sms`) in a
   savepoint. The checks are the web's: account status, exclusions, stake and loss limits,
   bettability, bet rules, max payout, the `bet_stake` posting, and the live acceptance delay
   (a bet with a live leg is `pending_acceptance` exactly as on the web).
   **Odds policy:** the player cannot see odds, so the bet takes the price at receipt: policy
   `none` against the current price, read under the `FOR SHARE` lock so it cannot move before the
   bet commits. A live bet whose price moves during the acceptance delay is rejected and refunded,
   like a web bet with policy `none`.
6. The `inbound_messages` row (text, outcome, bet, reply) and the reply's `channel.sms_reply`
   outbox event (payload `ChannelSmsReplyPayload`: `to`, `body`, `template: 'channel_reply'`,
   `userId`, `send`). The worker sends it through the SMS provider; sending never blocks the
   transaction, and nothing is sent unless it commits.

Inbound messages are evidence: a trigger refuses deletes, truncation and changes other than the
reply count and time.

## USSD (`handleUssdCallback`, `packages/db/src/channels/ussd.ts`)

The menu is a pure state machine (`packages/core/src/ussd.ts`): 1 Place bet (Game ID → pick from
the listed options with current odds → stake → confirm with the possible win), 2 Balance, 3 My
bets, 4 Jackpot, 5 Help, 0 Exit; `00` returns to the main menu and invalid input re-prompts.
Responses are `CON …` / `END …`, at most 182 characters, in English or Amharic.

- The state reached after each callback is stored in `ussd_sessions`, so the next input applies
  to exactly what the player saw. A callback whose text equals the last one is a redelivery and
  gets the stored response. A late retry of an earlier callback (its text is a prefix of the last
  one) also gets the stored response and changes nothing, so it can neither end the live session
  nor replace a stored bet receipt.
- A confirmed bet is placed with `placeChannelBet` (channel `ussd`) at the odds the confirm screen
  showed (policy `none`). If the price moved, the confirm screen is shown again at the new odds.
  The idempotency key is the session id plus the callback number.
- Sessions expire 3 minutes after the last callback, and end after 30 callbacks. A session we
  did not start (first callback with input) is never acted on. New sessions are limited to 10
  per number per 5 minutes, counting the number's inbound texts too (the budget is shared with
  SMS), and the player is checked again on every callback.
- **Retention:** the worker's `ussd-session-prune` task (hourly, at most 10 batches of 1,000 per
  run) deletes sessions that expired more than 7 days ago and placed no bet. Sessions with a bet
  are kept with it. Inbound texts (`inbound_messages`) are evidence and are never pruned; any
  archiving of them is a decision for the retention policy agreed with the regulator (Phase 12).

## API routes (`apps/api/src/modules/channels`)

- `POST /channels/sms/inbound` (only while `SMS_BETTING_ENABLED`; otherwise not registered, so 404).
  The raw body is JSON `SmsInboundWebhook` signed in `x-sms-signature: t=<unix s>,v1=<hex
HMAC-SHA256 of "<t>.<raw body>">` under `SMS_WEBHOOK_SECRET`, refused (401 `missing_signature`,
  `bad_signature`, `stale_timestamp`) when wrong or more than 5 minutes off the clock. Answer:
  `SmsInboundAck`. Also rate limited per aggregator address (600 a minute).
- `POST /channels/ussd` (only while `USSD_ENABLED`): JSON or form-encoded `UssdCallbackRequest`
  with the shared secret in `x-ussd-secret` (401 `bad_secret`); answered `text/plain` `CON …` /
  `END …`. 1200 a minute per aggregator address.
- Dev simulator (demo mode and `NODE_ENV` not production only; session required): `GET
/dev/channels` (`ChannelFlagsResponse`), `POST /dev/channels/sms` (`DevSmsSendRequest`: signs and
  feeds the text through the inbound path as the player's phone, with the message id namespaced
  per player so ids never collide across players; the reply also lands in `GET
/dev/sms` once the worker sends it) and `POST /dev/channels/ussd` (`DevUssdRequest`). Each POST
  answers 404 while its channel is off.
- Back office: `GET /admin/channels` (`settings.view`), read-only `ChannelFlagsResponse`.

## Worker

- `channel.sms_reply` goes to the `sms` queue (`ChannelReplySmsJobData`) and `body` is sent to `to`
  as it is (template `channel_reply`). Each re-send is its own outbox row, so its own job.
- `bet.accepted` / `bet.rejected` also go to the `sms` queue (`LiveBetSmsJobData`); the consumer
  texts `liveBetOutcomeBody` (template `channel_live_bet`, player's language) only when the bet's
  channel is `sms` or `ussd`.
- `ussd-session-prune` (hourly): see Retention above.
