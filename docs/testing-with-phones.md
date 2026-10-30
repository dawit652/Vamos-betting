# Test it on your laptop and on several phones

You run the whole system on your laptop (play money only) and open it from two or three phones on the same
Wi-Fi. One person plays on each phone, a trader works on the laptop, and you watch prices, bets and results
move between them. Nothing here uses real money or real SMS.

What you will do, in order: set up the laptop once (about 10 minutes), point the system at the laptop's
address, start it, open it on the phones, then run the checks in section 6.

## 0. What you need

- A laptop and two or three phones on the **same Wi-Fi**. Not a guest network (they often keep devices apart),
  and the laptop must not be on a VPN.
- On the laptop: Git, Node 22.13 or newer, pnpm 10, and Docker Desktop (the easy way to get the database).
- **Windows:** type every command in **Git Bash** (it comes with Git). Plain WSL hides the system from the
  phones, so do not use it for this.
- **Only on a network you trust.** The back office uses published demo passwords (section 4). Anyone on the
  same Wi-Fi who knows the address could sign in to it while it runs. Stop it when you finish (section 8).

## 1. Set up the laptop (once)

Get the latest code and move to the branch:

```bash
git fetch origin
git checkout claude/busy-rubin-1shjt6
git pull origin claude/busy-rubin-1shjt6
```

Install, create the settings file, start the database, and prepare it:

```bash
pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm db:seed
```

(On Linux you can use `pnpm services:start` instead of Docker.) Run `pnpm db:migrate` and `pnpm db:seed` again
after every `git pull`; both are safe to repeat.

## 2. Point the system at the laptop's address

A phone cannot use `localhost`, because there it means the phone itself. This command finds the laptop's
address on the Wi-Fi and writes it into the settings:

```bash
pnpm lan
```

It prints the two addresses to open, for example `http://192.168.1.20:3000` for the phones and
`http://192.168.1.20:3001` for the back office. If the laptop has several network addresses it lists them and
picks the usual Wi-Fi one; if that is wrong, choose yours with `pnpm lan -- --ip 192.168.1.20`.

If the laptop's address changes later (new Wi-Fi, router restart), run `pnpm lan` again and rebuild.

## 3. Build and start

```bash
pnpm phones:build
```

```bash
pnpm phones:start
```

The build takes a few minutes the first time. Start waits until the API, the player site and the back office
answer, then prints `worker: running`. Leave that terminal open or not, it runs in the background. Logs are in
`e2e/.stack/` (`api.log`, `worker.log`, `web.log`, `admin.log`).

This starts the system the way it runs in production (not the developer mode), because the developer mode did
not become usable when opened by a network address in our test.

The first time, your computer may ask whether Node.js may accept connections from the network (Windows
Firewall, macOS). Say **yes**, for private networks.

Match speed: by default the demo matches are fast. A new match kicks off every minute and is over in seconds,
so bets settle within about two minutes. For slower, watchable matches (about two minutes each), start with:

```bash
SIM_SPEED=1 FEED_ROLLING_EVERY_MINUTES=3 FEED_ROLLING_HORIZON_MINUTES=10 pnpm phones:start
```

(stop first with `pnpm phones:stop` if it is already running).

## 4. Check it on the laptop first

Open the player address from section 2 in the laptop's browser. **Use the address, not `localhost`**: the
system accepts browsers only from the address in its settings, and your login belongs to that address. You
should see a list of football games with prices.

Open the back office address and sign in as the demo trader:

- email `trader@demo.vamos.test`
- password `vamos-demo-staff`
- the 6-digit code comes from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy). Add
  the key `OZQW233TFVSGK3LPFVZXIYLGMYWW65DQ` by hand: time-based, 6 digits. A phone can hold the app.

These accounts exist only in demo mode. The `admin` account has the same password and key.

## 5. Open it on the phones

On each phone, open the player address in the browser (type it in; it starts with `http://`). Then, on each:

1. The app starts in Amharic. Tap the language switch in the header and choose **EN**.
2. **Register.** Use a different test number on every phone, for example `0911000101`, `0911000102`,
   `0911000103` (the app only accepts numbers shaped like Ethio telecom `09…` or Safaricom `07…`; no SMS is
   sent). Password: 12 or more characters, not a common one, for example `phone-trial-123`. Date of birth: any
   date that makes the player at least 21. Tick the terms.
3. **Verify.** The next page shows the demo code ("Your code is 824258"). Type it in and tap Verify.
4. **Add play money.** On the wallet page pick `1,000` and tap `Add ETB 1,000.00`.

The "install as app" option is not offered over plain `http`, so use the phone's browser.

## 6. The checks

Do these in order. Each says what you should see.

1. **Several players, one match.** On each phone open the same match, tap one price (the same or different
   ones), open the betslip, choose a stake (50), and place the bet. Each phone shows "Bet placed" with its own
   bet ID, and its own balance goes down by the stake. On the laptop, open **Bets** in the back office: every
   phone's bet is listed.
2. **Prices change on every phone at once.** Keep the same match open on two phones. On the laptop go to
   **Trading**, open that match, type a new price for one selection and press **Set**. Both phones show the
   new price within a second, without refreshing (in our trial: about 0.2 s).
3. **Suspend and resume.** On the same trading page press **Suspend event**. The price buttons on both phones
   switch off at once. Press **Resume event** and they come back. **Suspend market** and **Open market** do the
   same for one market.
4. **Results and winnings.** Wait for the match to be played (section 3 says how long). On each phone open
   **My Bets**: the bet shows won or lost, and the balance and the wallet history change. A winning bet pays
   what the betslip's "Net payout" showed when it was placed; a losing bet pays nothing.
5. **A price that moves while you decide.** On one phone open a match and add a pick. Before placing the bet,
   change that price on the laptop (as in check 2). Watch what the betslip does: its "If odds change" choice
   decides whether it asks first or accepts the new price. The bet that is placed must carry the price that
   was accepted, and My Bets must show that same price.
6. **Language.** Switch a phone between English and Amharic. Texts, amounts and dates should change, and the
   choice should stick after a refresh.
7. **Money in with the simulated mobile money.** On a phone open the wallet's deposit option and follow it; the
   page `/dev/phone` is the simulated handset that approves the payment. The balance rises after approval.

## 7. Optional: real Premier League data and a result you control

This is the data scraper from [`scraper-local-test.md`](scraper-local-test.md): real games, with prices from
our own model. Set `FEED_PROVIDER=scraped` in `.env`, run `pnpm phones:stop`, `pnpm phones:start`, and in a
second terminal `pnpm --filter @vamos/scraper-app dev`. Then follow that guide for the back office steps (enable
the source, review ratings, open betting). The phones then see those games.

To watch a result settle a phone's bet today, run the demo match with that phone's number
(`pnpm --filter @vamos/scraper-app seed:result-demo demo --player 0911000101`, after that player has registered
and added play money), then apply the result in **Feed → Review** on the laptop. See "Try a result today" in
that guide.

## 8. If something does not work

| What you see                                         | What to do                                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The phone cannot open the address                    | Same Wi-Fi as the laptop? Not a guest network? Typed `http://` and the port (`:3000`)? Allow Node.js through the laptop's firewall. On Linux with `ufw`: `sudo ufw allow 3000,3001,4000/tcp`.         |
| It worked, then stopped after the laptop reconnected | The laptop's address changed. Run `pnpm lan`, then `pnpm phones:stop`, `pnpm phones:build`, `pnpm phones:start`, and open the new address on the phones.                                              |
| The page opens, but buttons or sign-in do nothing    | The page was opened by a different address than the one in the settings (for example `localhost`, or an old address). Open exactly the address `pnpm lan` printed.                                    |
| Cannot sign in to the back office                    | Open it by its address (not `localhost`). The code changes every 30 seconds and the clocks of the laptop and the authenticator phone must agree. Wait for a new code, since one code works only once. |
| Balance is 0                                         | Add play money on the wallet page (section 5, step 4).                                                                                                                                                |
| `pnpm phones:start` says a file is missing           | Run `pnpm phones:build` first.                                                                                                                                                                        |
| Something else                                       | Look at the newest lines of the four logs in `e2e/.stack/`.                                                                                                                                           |

## 9. Finish

```bash
pnpm phones:stop
```

```bash
pnpm lan -- --reset
```

The second command puts the settings back to `localhost`. To stop the database as well: `docker compose -f
infra/docker-compose.yml down` (add `-v` to wipe all data and start fresh next time).

## What was and was not tried

Tried in a test environment, using the machine's network address instead of `localhost`: two phone-sized
browsers registering (the code shown on screen), adding play money and placing bets on the same match, a
trader signing in on a third browser at the back office address, a price change and a suspension reaching both
phones live, and the settings script. Not tried: real phones, a real router and firewall, iPhone Safari, bet
settlement on this exact setup (the automated end-to-end test covers settlement on the same production-mode
stack), and checks 5 to 7 of section 6 (a price that moves while you decide, the language switch, the simulated
mobile money deposit). If one of them behaves differently from what is written here, the text is wrong, not
you: note what you saw.
