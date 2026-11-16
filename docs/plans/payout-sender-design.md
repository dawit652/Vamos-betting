# Sending payouts by code, with no bank and no gateway (C8 reopened): design

16 Nov 2026. The owner cannot call the bank (C3, C5), does not want a gateway (C7) or a contract with
the state telecom (C4, C6), and asked for withdrawals to be automated by code alone. The plan's
section 6 called this option C8, "a robot on the handset", and did not recommend it. It is now the only
way left to send money without a person typing every transfer, so this design is how to do it with
the least risk. The risks of section 9 did not go away: the owner accepts them or not (decision D9).

## 1. What code can and cannot do

A payment only leaves an account through a door its institution gives: an API, a file upload, or the
menu a person uses. Without the first two, the only door is the one staff use today: dial the wallet's
menu (`*127#`), type the number and the amount, read the confirmation, type the PIN. Code can do
exactly that, on a SIM the company owns, and nothing more. So "by code" means **a small machine with
the payout SIM that types the menu itself**, told what to send by our server, and stopped by our
rules.

It cannot raise what the wallet allows per day, it cannot make a transfer faster than the menu
(20 to 40 seconds each), and it cannot make the wallet's operator like it.

## 2. The parts

```
back office ── shift open/stop ──▶ API + database ◀── debit SMS (existing gateway) ──┐
                                      │  one instruction at a time                    │
                                      ▼                                               │
                              payout agent (new, in the locked room) ── AT commands ─▶ USB modem + payout SIM
                              holds the PIN in memory only                             (USSD menu, incoming SMS)
```

| Part                 | What it is                                                                                                                                                          | State                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| The judgement        | `packages/core/src/payoutmenu.ts`: given the screens shown so far, what to type next or that it must stop. Pure, no I/O, never sees the PIN                         | **built** (section 5) |
| The agent            | `apps/payout-agent` (to build): drives a modem with `AT+CUSD`, asks the judgement at every screen, types the PIN from memory, reads the SIM's SMS and forwards them | C8b                   |
| The server side      | Shifts, send attempts, the instruction endpoint with its own secret, the caps, the stop rules                                                                       | C8c                   |
| Settlement           | A sent payout is recorded paid on proof, under the shift's operator (`auto_settle` of C2a)                                                                          | C8d                   |
| Back office, runbook | Start and stop a shift, see every attempt, resolve an unknown one                                                                                                   | C8e                   |

## 3. Rules that keep it safe

1. **A separate payout wallet with a small float.** Not the collection SIM. Whatever goes wrong, with
   the machine, the script, the PIN or the wallet operator, the most that can be lost is what is in
   that wallet. The owner tops it up from the collection account (the one manual transfer left); the
   float forecast (C10) says how much.
2. **The PIN lives in memory only.** The shift's operator types it at the agent when the shift
   starts. It is never written to disk, never sent to the server, never in a log or a transcript, and
   it is forgotten when the shift ends, the agent restarts, or a stop rule fires.
3. **Four eyes stay.** A sending shift is opened by an operator with `payouts.settle_manual`, with
   its caps. Each payout the agent is given is claimed in that operator's name by the same single-claim
   rule as today (never one they approved, never one compliance holds), and its settlement is recorded
   under them. Approving stays a different person (or the automatic approval below the threshold).
4. **One instruction at a time, at most once.** The server gives the agent one payout, and no other
   until that one has an outcome. An attempt ends as `sent`, `not_sent` or `unknown`:
   - `not_sent` is only said when the commit (the answer after which money may move) was never
     typed. The payout may be tried again or goes back to the people.
   - `unknown` means the commit was typed and the result is not one the script knows, or the session
     broke after it. **A machine never retries an unknown.** The shift pauses, an alarm is raised,
     and a person looks at the wallet before anything else happens to that payout.
   - A payout with a debit SMS proposed for it is never sent again, whatever its attempt said.
   - Two instructions for the same number and the same amount are at least ten minutes apart, so
     a late "sent" screen of the first can never be read as the result of the second.
5. **The confirmation is read back.** Money cannot move unless a screen, after the number and the
   amount were typed, showed this payout's own number and amount (and the holder's name where the
   menu shows one, compared with the player's name). Any screen that is not the expected one ends
   the session.
6. **Caps the server cannot raise.** Per send, per hour, per shift and per day, checked by the server
   and again by the agent from its own file. A minimum pause between sends.
7. **Stop rules.** A wrong PIN stops the shift at once (three lock the wallet). Balance too low
   pauses it and raises the float alarm. Two unexpected screens in a row stop it (the menu changed).
   "Stop sending" in the back office and `PAYOUT_SENDER=off` stop it from our side.
8. **Rehearsal before real.** In rehearsal the agent walks the menu for each payout up to the commit
   and cancels the session there: no money moves, and the script is proven against the live menu.
   The switch is `off`, `rehearse`, `on`; `on` comes after a rehearsal period and a first day with a
   small float.

## 4. Proof and settlement

The agent's word alone settles nothing. A payout is recorded paid when: its attempt ended `sent`,
**and** the debit SMS for the same amount and number arrived on the payout SIM after the claim (the
agent forwards the SIM's SMS to the existing gateway, so `applyDebit` and the C12 checks apply), and,
where the menu showed one, the reference agrees. Where the institution has a receipt page, the
double-proof rule of C2 adds the proof that does not come from our own machine. A `sent` without its
SMS within the window, or an SMS without a `sent`, goes to a person.

## 5. Built: the judgement (C8a)

`packages/core/src/payoutmenu.ts`, tests in `payoutmenu.test.ts` (25, with fast-check properties).

- A **script** per institution: the dial code, how the number and the amount are typed, the steps in
  order (the screen that must be showing, as a template with `{number}`, `{amount}`, `{name}`,
  `{any}`; and the answer: fixed keys, the number, the amount or the PIN), the success screen
  (`{reference}` reads the transaction id) and the screens that mean it certainly failed.
- `validatePayoutMenuScript` refuses a script that does not type the number and the amount itself
  (no fixed beneficiary), does not type the PIN exactly once, is never shown both values back after
  typing them, has a template that would match any screen, or has a step after the one that sends
  the money (the result screen would be read as an ordinary screen and a transfer that went through
  reported as not sent).
- `nextPayoutMenuAction(script, transfer, screens)` returns `dial`, `reply` (with `commit` set on
  the last one), `reply_pin` (the driver types the PIN: this code never holds it) or `finish`.
  `payoutMenuOutcomeAfterBreak` covers a session that broke; the driver counts a reply as typed
  before it writes it.
- Amounts are compared exactly in santim; an amount or a number is never read out of the middle of a
  longer figure; line breaks, spacing and letter case are ignored and nothing else.
- Tested: both menu shapes (confirm then PIN; PIN first), every stop, and properties: an honest menu
  always ends `sent` with the PIN asked once at the commit; a confirmation showing another number or
  amount never reaches the commit; one wrong screen anywhere never ends `sent`; arbitrary screens
  never throw. Eleven deliberate faults were planted in the code; the tests caught ten, and the
  eleventh (a look-behind on `{number}`) cannot change a result because the number is compared
  afterwards.
- The two scripts in the tests are **invented**. A real script comes from the real SIM (section 6).

### Built: the agent's core, against a simulated modem (C8b, part 1)

`apps/payout-agent` (its README lists the files). It has **never talked to a real modem**, and nothing
can run it yet: no command line, no serial port, no connection to the API.

- `runTransfer` types what the judgement says and adds three rules of its own: an answer counts as
  typed before it is written to the modem (a write that failed half-way is never "nothing was sent");
  a rehearsal never types the commit; the session is always hung up afterwards, also when the last
  screen said it was over (found by a test: a late screen of an earlier session had left the new
  session open, and the next transfer answered into it).
- The PIN is read from memory at the moment it is typed, sent with a flag that keeps it out of the
  trace and out of error messages, and written as `<PIN>` in the transcript.
- `checkSendCaps`: per send, sends and sum per hour, sum per shift, sum per East Africa Time day, a
  pause; an `unknown` outcome counts as money that left.
- Tests (69): the AT channel and codec; the whole path; a rehearsal; every stop before the PIN; and
  five kinds of fault (a lost message, a lost answer after the menu acted, an unexpected screen, a
  cut session, a modem error) at each of the six exchanges. A property test runs random faults,
  menus that take other values, both character sets, answers cut into pieces and screens before
  their OK, and checks each time that the report agrees with the simulated wallet's own books.
  Seven deliberate faults planted in the runner were all caught.

### Built: a script from one recorded session (C8b, part 2a)

- `packages/core/src/payoutmenulearn.ts`, `deriveMenuScript(recording)`: the number, the amount and
  the holder's name on the recorded screens become `{number}`, `{amount}`, `{name}`; the transaction
  id on the result becomes `{reference}`; every other figure (a fee, a balance, a date) becomes
  `{any}`; the numbers of menu choices (`1. Confirm`) stay, as words of the menu. A figure on a
  screen shown before it was typed is never taken for the transfer's. The script is only returned
  when it validates and replays its own recording: the same answers in the same order, then `sent`.
  It says what it will not check (no name given, no transaction id, no failure screens known).
- `apps/payout-agent/src/record.ts`, `recordSession`: types the person's answers, keeps the screens,
  and passes the PIN from the prompt to the modem without keeping it.
- Tested on the simulated wallet: the script made from one recording is the same as the one written
  by hand for that menu; it then sends other amounts to other people, rehearses without the PIN, and
  stops where the hand-written one stops. Known limit: one recording knows no failure screens, so a
  transfer the menu refuses after the PIN (a wrong PIN, no balance) is reported `unknown` until those
  screens are added to the script by hand.

## 6. What only the owner can do (no calls to anyone)

1. **Decide D9**: accept a machine that types the wallet's menu with the PIN in its memory during a
   shift, knowing section 9.
2. **A payout SIM and wallet** used for nothing else, with as high an account level as it can get
   (D10), and tell us its daily limit as the wallet's app or menu states it.
3. **A USB modem** that takes a SIM (a "3G/4G dongle"; the Huawei E-series answer AT commands) and a
   computer that stays on in the locked room. The agent will run on Linux or Windows.
4. **Teach the menu once.** The agent's `record` command shows each screen and the owner answers as
   they would on the phone, for one real transfer of 11 birr or more (a smaller amount looks like a
   menu choice); it writes the script from that session, with the PIN left out. Then `rehearse` with
   two or three other numbers and amounts (no money moves): only that shows which parts of a screen
   change. No screenshots to send, no menu to describe.
5. **Caps (D11)**: suggested to start: ETB 2,000 a send, ETB 20,000 a shift, only payouts that were
   approved automatically.

## 7. What it will and will not reach

- **Pace**: about 100 to 150 payouts an hour for one modem. The plan's peak (600 in the hour after the
  final whistles) needs several wallets and modems, or the queue drains over the following hours.
- **The wallet's daily limit is the real ceiling, not the code.** Published figures for telebirr
  disagree: a January 2026 report gives 8,000 birr a day for the highest personal level, Ethio
  telecom's own page says the daily limits of levels 2 and 3 were lifted, a May 2025 report of the
  National Bank's directive gives 300,000 birr for level 2. At a few hundred birr a payout, 4,000
  payouts a day is over a million birr: more than any of those figures for one personal wallet. The
  number that counts is the one the owner's wallet shows.
- **Wallets first.** A bank-account payout has another menu (and a holder name to check); it stays
  with the people until wallets run well.
- **Fees**: every transfer costs the wallet's fee, as today.

## 8. Build order

| Task | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Model / effort               | Done when                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| C8a  | The judgement in core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | done                         |                                                                                                 |
| C8b  | `apps/payout-agent`. **Part 1 done:** the AT channel, the USSD session, the driver, the PIN handling, the local caps and the simulated modem and wallet. **Part 2a done:** making a script from one recorded session. **Part 2b open:** the command line around what exists (`probe` a modem, `record`, `rehearse`), the serial port (`serialport`), reading the SIM's SMS (PDU mode, so long messages are put together) and forwarding them to the gateway, a journal so the caps survive a restart. No database | Opus, high                   | The driver passes against the simulator: every stop of section 3, a session broken at each step |
| C8c  | Server: migration (the next free number: coordinate, one session at a time), shifts, attempts, the instruction endpoint with its own secret and allowlist, caps, stop rules, alarms                                                                                                                                                                                                                                                                                                                               | Opus, high                   | Database tests: at most once, never after an unknown, never with a proposed SMS, four eyes      |
| C8d  | Settlement on proof for sent payouts (C12 checks, `auto_settle` of C2a, C2's receipt where there is one)                                                                                                                                                                                                                                                                                                                                                                                                          | Opus, high                   | No settle on the agent's word alone; mismatches go to a person                                  |
| C8e  | Back office (shift, attempts, resolve an unknown), runbook, e2e with the simulated modem                                                                                                                                                                                                                                                                                                                                                                                                                          | Sonnet, medium; Opus reviews | Works on a phone width; runbook merged                                                          |
| C8f  | Gate: the real script recorded, rehearsal on real payouts, first day with a small float                                                                                                                                                                                                                                                                                                                                                                                                                           | Owner + Opus, high           | Written sign-off; `PAYOUT_SENDER=on` with low caps                                              |

C8b part 2 needs no decision and no migration. C8c changes CLAUDE.md's rule that the worker never
touches manual payouts: reword it when C8c lands, not before.

## 9. Risks the owner accepts with D9

1. **The wallet's terms.** A personal wallet used by a machine, at volume, for a betting business may
   be against its terms. The operator can suspend it, with the float in it. The small float bounds
   the loss; nothing removes the risk. Nothing here hides that a machine is typing: the pause between
   sends is a safety pace, not a disguise.
2. **The PIN on a machine.** Whoever controls the agent's computer during a shift can send the float
   anywhere the menu allows. Locked room, its own user account, no other use, the caps in a file only
   the owner edits.
3. **A menu that changes** stops the sender (it stops rather than guesses) until the script is recorded
   again; people take over meanwhile.
4. **A wrong script** is the one way this code could misreport a transfer. The validation, the
   read-back of the confirmation, the rehearsal and the rule that a payout with a debit SMS is never
   sent again are the answers; the first real day runs with a float small enough to lose.

## 10. Rejected

- **Driving the bank's website with a browser on the server**, reading the one-time code from the
  forwarded SMS: it puts the banking password on an internet-facing server and defeats the bank's own
  second factor.
- **Paying winners from other players' deposits directly**: the collection handset would see no SMS,
  so nothing could be proven, and it pays third parties, which CLAUDE.md excludes.
- **One dial string per payout on the operator's phone** (`*127*…#` as a link): nothing found says the
  wallet's menu accepts a whole transfer in one string, and a dial string cannot carry santim. Worth
  two minutes on the phone to try; if it works it is a cheap help for the people who remain.
