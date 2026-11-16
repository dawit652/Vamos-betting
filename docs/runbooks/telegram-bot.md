# Telegram bot

The worker runs a Telegram bot when `TELEGRAM_BOT_TOKEN` is set. It is **read-only**: it never places
a bet, moves money, reads an account or stores who wrote to it.

- **Owner alerts:** every owner alert (the SMS rail's alarms, the float forecast, failed sources, the
  credit budget...) goes to the chats in `TELEGRAM_OWNER_CHAT_IDS`, next to the SMS to
  `OWNER_ALERT_PHONES`. Either list alone is enough. The same alert is sent at most once per
  `OWNER_ALERT_MIN_INTERVAL_MINUTES`.
- **Players** (`TELEGRAM_PLAYER_MENU=on`, the default): `/today`, `/live`, `/top`, `/leagues` and the
  menu buttons list football matches with the main odds, the number of options, and a button that
  opens the match on the website, where the bet is placed. Messages follow the language of the
  player's Telegram app (Amharic or English) and end with "21+ only. Bet responsibly."; in demo mode
  they start with DEMO.
- **Anyone:** `/id` answers the chat's id (to fill in `TELEGRAM_OWNER_CHAT_IDS`).
- **Owner chats only:** `/status` shows the last SMS from the collection handset, the SMS waiting
  for staff and the open manual payouts.

How it runs: the worker asks Telegram for new messages (long polling), so nothing on the server
accepts connections from Telegram and Caddy is unchanged. It reads the matches from the API over the
compose network (`API_INTERNAL_URL`, `http://api:4000`), with the API's catalogue cache. Private
chats only; group chats are answered only when they are owner chats. Each chat gets at most 20
answers a minute.

## Set it up (once)

1. In Telegram, open **@BotFather**, send `/newbot`, choose a name (for example "Nahubet") and a
   username ending in `bot` (for example `NahubetSportsBot`). BotFather answers with a **token** like
   `123456789:AAH...`. Keep it secret: whoever has it controls the bot.
2. On the server, add it to the env file and leave the chat list empty for now:

   ```bash
   nano /opt/nahubet-new/infra/.env.prod
   ```

   ```bash
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   ```

3. Deploy (or, if this code is already deployed, recreate the worker so it reads the new setting):

   ```bash
   cd /opt/nahubet && COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=/opt/nahubet-new/infra/.env.prod COMPOSE_PROJECT_NAME=vamos docker compose up -d --no-deps --force-recreate worker
   ```

4. In Telegram, open your bot and send `/id`. It answers "This chat's id: 123456789".
5. Put that number in the env file and recreate the worker again (step 3):

   ```bash
   TELEGRAM_OWNER_CHAT_IDS=123456789
   ```

6. Send `/status` to the bot: an owner chat gets the status. The next owner alert arrives here too.

Optional, in @BotFather: `/setdescription` and `/setcommands` (paste
`today - Today's matches`, `live - Live now`, `top - Top matches`, `leagues - Top leagues`,
`id - This chat's id`), and `/setuserpic`.

To send alerts only, with no player menu: `TELEGRAM_PLAYER_MENU=off`.

## When something is wrong

| Sign                                                                            | Cause and what was done                                                                                           | Fix                                                                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Alarm `telegram_bot_unauthorized` (worker `error` line)                         | Telegram refused the token (revoked in BotFather, or mistyped). The worker retries every minute; alerts go by SMS | Put the right token in the env file and recreate the worker                                                                   |
| Worker log "another process polls this bot, or a webhook is set"                | Two workers (or another program) use the same token, or a webhook was set on it                                   | Run one worker with this token. To drop a webhook: open `https://api.telegram.org/bot<token>/deleteWebhook` once in a browser |
| The worker refuses to start: "TELEGRAM_OWNER_CHAT_IDS needs TELEGRAM_BOT_TOKEN" | A chat list without a token                                                                                       | Set the token, or empty the list                                                                                              |
| The bot never answers, no alarm                                                 | The worker cannot reach `api.telegram.org` (firewall)                                                             | Allow outbound HTTPS from the server to `api.telegram.org`                                                                    |
| "Matches are not available right now"                                           | The worker could not read the API (`API_INTERNAL_URL`)                                                            | Check the api container is healthy                                                                                            |

The token is never written to a log or an error message. If it may have leaked, revoke it in
@BotFather (`/revoke`), put the new one in the env file and recreate the worker.
