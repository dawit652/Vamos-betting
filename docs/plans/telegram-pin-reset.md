# PIN reset (and phone proof) over Telegram

Owner's request of 16 Nov 2026: "if an SMS gateway is not available, use a Telegram message as an
option". Today a forgotten PIN cannot be reset on the live server: the reset needs an SMS code,
`SMS_PROVIDER=mock` sends nothing, and the code is never shown on screen (by design).

Status: **built on 17 Nov 2026, simpler than designed below** (no link token, no migration): the
website links to the bot with `?start=reset`; the bot asks for the person's own contact
(`contact.user_id === from.id`), then asks the API for the code over a signed internal call
(`POST /internal/telegram/password-reset`, HMAC with `SESSION_SECRET` over timestamp, phone and chat,
at most 60 seconds old, which is also the code's resend cooldown, so a replay gets nothing). The
API creates the usual `password_reset` challenge (same limits, the chat as requester) and returns
the code to the worker, which sends it in that chat. Only the owner of a number learns whether it
has an account. Operations: `docs/runbooks/telegram-bot.md`, "Forgot PIN over Telegram".

## Why Telegram can prove a phone number

A Telegram account is created by proving a phone number with an SMS (Telegram's own gateway). A bot
can ask the person in its chat to share their contact with one tap (a `request_contact` keyboard
button). Telegram then sends the bot a `contact` message holding the phone number of **that
Telegram account**. When `message.contact.user_id === message.from.id`, the person shared their own
number, which Telegram has verified; a contact typed by hand or forwarded from someone else has
another (or no) `user_id` and is refused. This proves control of the number as well as an SMS code
does (the same SIM-swap risk, no more).

## The flow (player)

1. Forgot PIN page: "Get the code on Telegram" next to "Get the code by SMS" (shown only while
   `TELEGRAM_BOT_TOKEN` is set; the SMS option only while a real gateway is configured).
2. The API creates a reset challenge as today (`otp_challenges`, purpose `password_reset`, the same
   limits per number and address) **plus a one-time link token** (32 random bytes, stored hashed,
   10 minutes, bound to the challenge), and answers with `https://t.me/<bot>?start=<token>`.
3. The player opens the link; Telegram starts the bot with `/start <token>`. The bot (worker, long
   polling, already running for X9) looks the token up, and if it is valid asks: "Share your phone
   number to receive your Nahubet code" with a `request_contact` button. Nothing about the account is
   shown before the contact is shared.
4. The player taps the button. The bot checks `contact.user_id === from.id`, normalises the number
   (`normalizeEthiopianMsisdn`) and compares it with the challenge's phone. Equal: the bot sends the
   6-digit code in that chat ("Your Nahubet code is …, valid 5 minutes, never share it"), and the
   token is consumed. Different, or someone else's contact: "This Telegram account does not have the
   number you asked a code for" and nothing else (no hint whether the number has an account).
5. The player types the code on the reset page as today (`/auth/password-reset/confirm`): the code
   check, attempts and expiry are unchanged.

The same steps can prove the phone at registration while `REGISTRATION_SMS_VERIFICATION=off` (purpose
`register`), so new accounts are tied to a real number before real money.

## Data (one migration)

- `telegram_link_tokens`: `id`, `token_hash` (unique), `challenge_id` (FK otp_challenges, cascade),
  `phone`, `purpose`, `expires_at`, `consumed_at`, `created_at`; index on `expires_at` for the
  sweep. Grants for `vamos_app` (select, insert, update; no delete: a sweep job marks them used).
- No Telegram id is stored for the reset (nothing to leak); the audit log gets
  `auth.password_reset.telegram_code_sent` with the challenge id.

## Code

- `packages/contracts`: the reset request takes `channel: 'sms' | 'telegram'`; the response may carry
  `telegramUrl`.
- `apps/api`: `requestPasswordReset` creates the token when `channel = telegram` (refused with 400
  `channel_unavailable` when no bot token is set); the code itself is never in an API response.
- `apps/worker` (the X9 bot): handle `/start <token>` and `contact` updates; private chats only; the
  existing 20 answers a minute per chat; never log the code or the token (the PIN rule of this
  repository applies to codes too).
- `apps/web`: the forgot form's second button and the "open Telegram" step; i18n in am and en.
- Tests: token single use and expiry; another person's contact refused; a different number refused
  with no account hint; the code arrives only in the chat that shared the matching contact; limits
  unchanged; the code never in logs (a test that greps the captured log lines).

## What the owner must do

Create the bot with @BotFather, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_PUBLIC_URL` in
`/opt/nahubet-new/infra/.env.prod` (docs/runbooks/telegram-bot.md). Players need the Telegram app on
a phone whose Telegram account uses their Nahubet number.
