# @vamos/payout-agent

The payout sender's agent: the program that will sit next to a USB modem holding the payout SIM and
type the wallet's own USSD menu, one payout at a time. Design, rules and risks:
[docs/plans/payout-sender-design.md](../../docs/plans/payout-sender-design.md).

**State (16 Nov 2026): it has never talked to a real modem and nothing can run it yet.** There is no
command line, no serial port and no connection to the API. What exists is the part that must be right
before any of that, tested against a simulated modem and a simulated wallet:

| File                     | What it does                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/at/chat.ts`         | One conversation with a modem's AT port: a command and its answer, lines the modem sends on its own, time limits. A command that carries the PIN is never traced             |
| `src/at/codec.ts`        | Text on the AT interface (UCS2 hex, so a menu in any script travels on one line) and the `+CUSD:` line                                                                       |
| `src/ussd/session.ts`    | A USSD session on a modem: dial, answer, hang up                                                                                                                             |
| `src/runner.ts`          | `runTransfer`: types what core's `nextPayoutMenuAction` says, counts an answer as typed before it is written, never types the commit in a rehearsal, always hangs up         |
| `src/caps.ts`            | The agent's own limits (per send, per hour, per shift, per day, a pause), which the server cannot raise                                                                      |
| `src/sim/wallet-menu.ts` | An **invented** wallet and menu that keeps real books, with faults (a lost message, a lost answer after the money moved, an unexpected screen, a session cut, a modem error) |
| `src/sim/modem.ts`       | A modem for tests in front of that wallet: echo, both character sets, answers in pieces, the screen before its OK                                                            |

The test that matters is in `test/runner.test.ts`: for every fault at every step, and for random
combinations of faults and modem behaviour, **what the agent reports is what the simulated wallet did**.
"Not sent" is only ever said when no money moved; money that moved without a clear answer is only ever
"unknown"; a menu that shows another number, amount or name never gets the PIN; and the PIN is in no
transcript, trace or error.

```sh
pnpm --filter @vamos/payout-agent test
```

Still to build (design, section 8): the command line (`probe`, `record`, `rehearse`, `run`), the serial
port, reading the SIM's SMS and forwarding them to the gateway, a journal so the caps survive a restart,
and the connection to the server's instruction endpoint (C8c).
