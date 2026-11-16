# @vamos/payout-agent

The payout sender's agent: the program that will sit next to a USB modem holding the payout SIM and
type the wallet's own USSD menu, one payout at a time. Design, rules and risks:
[docs/plans/payout-sender-design.md](../../docs/plans/payout-sender-design.md).

**State (16 Nov 2026): it has never talked to a real modem.** The command line below runs against the
simulated modem; a real modem needs the serial port library, which is not installed yet (the owner's
decision, see "A real modem" below). There is no connection to the API. What exists, tested against a
simulated modem and a simulated wallet:

| File                     | What it does                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/at/chat.ts`         | One conversation with a modem's AT port: a command and its answer, lines the modem sends on its own, time limits. A command that carries the PIN is never traced                                         |
| `src/at/codec.ts`        | Text on the AT interface (UCS2 hex, so a menu in any script travels on one line) and the `+CUSD:` line                                                                                                   |
| `src/ussd/session.ts`    | A USSD session on a modem: dial, answer, hang up                                                                                                                                                         |
| `src/runner.ts`          | `runTransfer`: types what core's `nextPayoutMenuAction` says, counts an answer as typed before it is written, never types the commit in a rehearsal, always hangs up                                     |
| `src/caps.ts`            | The agent's own limits (per send, per hour, per shift, per day, a pause), which the server cannot raise                                                                                                  |
| `src/record.ts`          | `recordSession`: a person answers the menu once for one real transfer; the screens are kept, the PIN is not. Core's `deriveMenuScript` (`packages/core/src/payoutmenulearn.ts`) makes the script from it |
| `src/sim/wallet-menu.ts` | An **invented** wallet and menu that keeps real books, with faults (a lost message, a lost answer after the money moved, an unexpected screen, a session cut, a modem error)                             |
| `src/sim/modem.ts`       | A modem for tests in front of that wallet: echo, both character sets, answers in pieces, the screen before its OK                                                                                        |

The test that matters is in `test/runner.test.ts`: for every fault at every step, and for random
combinations of faults and modem behaviour, **what the agent reports is what the simulated wallet did**.
"Not sent" is only ever said when no money moved; money that moved without a clear answer is only ever
"unknown"; a menu that shows another number, amount or name never gets the PIN; and the PIN is in no
transcript, trace or error.

```sh
pnpm --filter @vamos/payout-agent test
```

## Command line

From the repository root. `--simulate` uses the invented wallet and modem (nothing real is touched; its
PIN is `482913`), so the whole flow can be tried before any hardware exists:

```sh
pnpm --filter @vamos/payout-agent cli probe --simulate --ussd '*127#'
pnpm --filter @vamos/payout-agent cli record --simulate --to 0911234567 --amount 15 --name "ABEBE KEBEDE"
pnpm --filter @vamos/payout-agent cli rehearse --simulate --script scripts/telebirr.json --to 0922334455 --amount 40 --name "Sara Haile"
```

- `probe` asks the modem whether it answers commands, whether its SIM is ready (a SIM locked with its own
  SIM PIN is named as such), the signal, the network, USSD, UCS2 text and SMS reading, and says in one
  line whether the modem is usable. With `--ussd <code>` it dials that code (pick a harmless one, such as
  a balance check), shows the first screen and hangs up.
- `record` **sends one real transfer** (at least 11 birr; it asks you to type `SEND` first). You answer
  every screen as on the phone: keys as you would press them, `N` for the number, `A` for the amount,
  `P` for the PIN (typed without being shown, never stored), `Q` to give up. It saves the script
  (`scripts/<institution>.json`) and the recording next to it (`*.recording.json`, private: it holds the
  receiver's number and name).
- `rehearse` walks the menu for another number and amount up to the step that sends, and hangs up there.
  It asks for the PIN only when the menu wants it before that step.

## A real modem

Talking to a USB modem needs the [`serialport`](https://www.npmjs.com/package/serialport) library
(version 13.0.0, with prebuilt binaries for Windows and Linux). It is **not installed**: adding a native
library is the owner's decision. Until then `--port COM5` or `--port /dev/ttyUSB0` stops with that
message. Once it is approved, the adapter is about 30 lines behind the `BytePort` interface in
`src/at/chat.ts`, and `cli ports` can list the modem's ports.

Still to build (design, section 8): the serial port adapter (above), reading the SIM's SMS and
forwarding them to the gateway, a journal so the caps survive a restart, and the connection to the
server's instruction endpoint (C8c).
