# Review of the 4-digit PIN sign-in (X6), 16 Nov 2026

An independent, read-only security review of commits c881d54 and d078dea (the owner's choice of a
4-digit PIN, login limits per number and year-long sessions), done by the first account's session after
the second account's review agent stopped without a result. The owner's choices themselves were not
questioned. Every finding below was checked against the code before anything was changed.

## Fixed in this change

| #   | Finding                                                                                                                                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **A stolen session could guess the PIN about 64 times faster than the login form.** `POST /me/password` and `POST /me/sessions/revoke` check the current PIN under their own limit (10 per 15 minutes per player, 960 a day), not the number's login limits (6 per 15 minutes, 15 a day): about 5 days to find a random PIN, then change it and lock the owner out | The PIN check of both routes now counts in the number's login limits, with the same keys as `POST /auth/login` (one budget). Only requests that actually compare a PIN count (a malformed or weak new PIN does not). Medium |
| F4  | **Changing the PIN skipped sessions that were only idle**, and an idle limit is read from the configuration at every request: on 16 Nov the idle limit went from 30 minutes to none, so a session a PIN change had skipped came back                                                                                                                               | Ending other sessions now ends every one that is not revoked and not past its absolute end, idle or not. Low                                                                                                                |
| F3  | **The easy-PIN rule missed common shapes:** runs round the 0 (7890, 0987), pair patterns (1414, 5566, 1221), three of a digit (1110), most years (1950 to 2026) and the start of the player's own number (0911)                                                                                                                                                    | `pinWeaknessReason` refuses runs round the 0, pair patterns and three of a digit, the years 1940 to 2030, and any four digits in a row of the player's number: about 590 PINs (5.9%), tested against a generated reference  |
| F9  | The login field showed a number pad, which cannot type the letter passwords made before the PIN (the owner kept them valid); the contract still described 12-hour sessions                                                                                                                                                                                         | Full keyboard on the login field (the registration and reset forms keep the number pad); comment corrected                                                                                                                  |

Each fix has a test that fails without it (F1 and F4 were checked by undoing the fix).

## Open: for the owner or a later task

| #   | Finding                                                                                                                                                                                                                                                                                      | Proposed                                                                                                                         | Needs                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| F2  | **Locking a player out is cheap:** 16 wrong logins lock a number for 24 hours, even for the right PIN; 12 more requests (2 SMS at our cost) also block the SMS reset for a day. Keeping one number locked costs 16 requests a day (before 16 Nov: about 1,920). No staff tool lifts the lock | A signed "known device" cookie that gives a device the player used before its own budget; a staff action to lift a number's lock | A design (no migration if the cookie is signed) |
| F5  | The "new device" SMS is skipped when the browser's user agent matches an earlier one exactly: someone who guessed the PIN can copy a common user agent and stay silent                                                                                                                       | The same device cookie as F2                                                                                                     | As F2                                           |
| F6  | The year-long session token is also returned in the JSON of the login answer; the web app never reads it (it uses the cookie), so an injected script could take a token valid for a year                                                                                                     | Return it only to clients that ask for it                                                                                        | Check the non-browser clients first             |
| F7  | Self-exclusion (also permanent) and the data export need no PIN: a stolen session can exclude the player or take their data                                                                                                                                                                  | Ask the PIN for both                                                                                                             | Owner (responsible-gambling choice)             |
| F8  | The password pepper is required only when `NODE_ENV=production`, not in licensed mode                                                                                                                                                                                                        | Add it to the licensed-mode checks                                                                                               | Owner (CLAUDE.md limits those checks)           |
| —   | No alarm on a high overall rate of failed logins (one common PIN tried on many numbers)                                                                                                                                                                                                      | An `error` log line with an `alarm` field above a threshold                                                                      | A threshold                                     |

## The numbers that remain (the owner's accepted risk)

- A stranger on one number: 15 guesses a day. For a PIN chosen at random from the ~9,400 allowed,
  about 0.16% the first day, 5% in a month, about half in a year. People do not choose at random, so
  the real chance is higher.
- One address trying one likely PIN on many numbers: up to about 1,900 numbers a day per address
  (the per-address limit), more with many addresses. Registration tells whether a number has an
  account.
- A phone left signed in stays signed in for a year: it can bet the balance away and read the
  account, but money only leaves to the player's own registered wallet or KYC-named bank account,
  and since F1 it gets no more PIN guesses than a stranger.

Checked and fine (the review's own list): Argon2id with a server-side pepper (a database-only leak is
not enough), the strength check on register, reset and change, the 4-ASCII-digit schema, phone
normalisation of the limit keys, counting before the check, failing closed when Redis is down, the
reset lifting the lock only with a valid code, 256-bit session tokens stored as hashes, cookie
flags, CSRF, revocation on reset, self-exclusion and suspension, staff sign-in unaffected, and no PIN
in logs, errors or audit rows.

**16 Nov 2026, evening: the owner allowed years again.** Players kept choosing their birth year and
the form refused it, so the year rule of F3 is removed (`pinWeaknessReason` no longer has `year`):
1990 or 2016 is a valid PIN. The other rules stay (repeats, runs, pair patterns, the common list, the
player's own number), and so do the login limits per number that hold guessing back.

**16 Nov 2026, late evening: the owner was still refused at registration** ("it says easy number to
predict or used password"), so the rule keeps only what every player understands: one digit four
times, runs (also round the 0) and the last four digits of the player's own number, 31 of the 10,000
PINs. Pair patterns, three of a digit, the common list and the other digits of the number (its 09..
start, its middle) are valid again. The cost: the PINs an attacker tries first on a number
(1212, 2000, 6969, 1122, years) now exist, so the per-number login limits (6 per 15 minutes, 15 a
day) are what holds guessing back, and the failed-login alarm (X6b: one PIN tried on many numbers)
matters more. Every PIN refused now was refused before, so no player is sent to the reset.

**18 Nov 2026: the failed-login alarm (X6b) is built.** `recordLoginFailure`
(`apps/api/src/lib/login-alarm.ts`) counts every failed player login in a 15-minute window (Redis,
numbers hashed) and writes one `error` log line with an `alarm` field per kind and window: 60
failures in all, 30 distinct numbers, or 10 numbers from one address. A Redis error never fails the
login. Tests: `apps/api/test/login-alarm.test.ts`.
