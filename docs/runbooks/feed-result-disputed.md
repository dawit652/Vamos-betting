# Feed result disputed

Use it when a result item from the scraper is open on `/feed/review` and the sources do not agree with each
other or with what was applied: `result_conflict`, `result_correction` or `result_unverified`. The rules are in
[`scraper.md`](../scraper.md) (R2, R3, R6, R8); the queue is in [scraper operations](../scraper-operations.md#5-how-results-reach-the-catalogue).

**What the three items mean**

| Item                | Raised when                                                                                                                                                                                                   | Money                                          | Severity |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------- |
| `result_conflict`   | a current observation disagrees with the proposed score (full time, or half time where the event needs it), says postponed, cancelled or abandoned, or its kickoff is more than five minutes from the event's | Nothing applied. Open bets wait                | SEV3     |
| `result_correction` | an event was resulted and a current source now shows a different score (or a void status after a score)                                                                                                       | Already settled. A correction reverses payouts | SEV2     |
| `result_unverified` | one upstream says final, and no second one has confirmed it six hours after the earliest possible end                                                                                                         | Nothing applied. Open bets wait for a person   | SEV3     |

A knockout match decided after extra time is a `result_conflict` by design: the 90-minute score and the
extra-time score differ (`known-limits.md`, rule R3). Read it as a basis question, not as a broken source.

## 1. Read the item

Open the item on `/feed/review/[id]`. It shows the match, the proposed or applied score, the sources and what
each one said (observations), and for a result that was applied, the exposure (open bets and total stake). Note
the kickoff each source gives: a different kickoff often means a different match or a postponement.

Before anything else, export the evidence while it is still there. A snapshot is kept only once a result has
been applied; unapplied snapshots are pruned after 30 days (`scraper-operations.md`, section 6). For each
source's snapshot, use the export in [feed-source-broken](feed-source-broken.md#2-compare-the-saved-page-with-the-last-good-one)
to an empty scratch directory on the production host, and keep it with the case file.

## 2. Check the real score

Find out what happened from a source the scraper does not use:

- the official competition or federation site, or the club's own published report;
- a second provider, or the licensed data provider once one is in place.

Write down, before you decide: the URL, the time you checked, the full-time score, the half-time score if the
event has a half-time market, whether the score is after 90 minutes or after extra time or penalties (the
basis), the kickoff and whether the match was postponed or cancelled.

If the official sources are silent or contradict each other, the decision is "not yet": leave the item open
and check again later. Do not guess a score.

## 3. Decide

**Who decides.** A person with `trading.result` (admin or trader) decides, in the back office. The plan does
not yet require a second approver for a correction (**pending**, a business decision). Until it does, a
`result_correction` or any cancellation or void is confirmed by a second person in the same shift before it is
entered, and the two names go in the note.

**Never** from scraped data: cancel, void or abandon an event. Only a person decides that, in Trading, with the
evidence in the note. A source saying "postponed" is a `cancellation_proposed` or `result_conflict` item, not
an instruction.

Then one of the following.

### a. `result_unverified`: one source

- The official score matches the proposed score: on the item, **Apply this result** (it asks you to repeat the
  score). This is an override of R6, audited as a staff decision.
- The official score differs, or nothing is found: **Dismiss** with a note that names the evidence. The item
  closes; if the event is still unresolved, a later source result raises a new item.

### b. `result_conflict`: nothing applied yet

Dismissing a conflict does not change what the sources say. While they still disagree, the next pass opens a new
item. Dismiss only to record that a person has looked, and only with a note. The conflict goes when the sources
agree, so the fix is in the source, the alias or the event:

- The official score matches the proposed one and another source is the outlier: fix or disable that source
  ([feed-source-broken](feed-source-broken.md)), then wait for its next run.
- The official score matches the dissenting observation: the proposal is wrong. Report the source that proposed
  it; the item will not be applied by the rules while the dissent stands.
- A kickoff mismatch: check the match is the same. If a source has the wrong match, fix its data or its alias
  (see the alias note in [scraper operations](../scraper-operations.md#5-how-results-reach-the-catalogue)). If
  the match was postponed, the decision is a Trading decision with the evidence, not a score.
- No evidence yet: leave the item open.

If the event must be resulted now (the evidence is clear and the sources will not agree in time), a person can
enter the verified result in Trading. Use it with the note that says why the sources were not waited for.

To enter a result by hand, use the event in **Trading** (`/trading/[id]`, the **Enter result** form):
choose **Finished** and the verified score (and the half-time score where the event has a half-time market),
or the status the evidence shows. A first result needs no reason; a correction needs one (the form asks for it,
and the server refuses a correction without it).

### c. `result_correction`: an applied score is contradicted

The applied score stays until a person corrects it. What a correction does:

- it re-resolves every market of the event with the new result, and records the previous result on the event
  (`event.result_corrected`), so settlement re-settles the affected bets;
- bets already paid out on the old result are reversed through the normal settlement and ledger path (entries
  are added, never edited or deleted);
- a correction to cancelled, abandoned or postponed voids every bet not already decided in play. It is the
  most serious correction; use it only with the evidence and the second person above;
- a correction can be **blocked**: when a player already moved the old winnings (into other bets or a
  withdrawal), reversing them would overdraw the balance. The bet keeps its settlement, the retry runs every five
  minutes, and the player's withdrawals are held. Follow [payouts stuck or flagged](payouts-stuck-or-flagged.md#procedure-a-blocked-settlement-correction).

Then:

1. If the **applied** score was wrong: enter the verified score in Trading with the **Enter result** form and a
   reason that names the evidence. Check the event's markets and the bet count, then the result of the
   reconciliation for the day (`reconciliation-mismatch.md`).
2. If the **source** was wrong and the applied score is right: dismiss the item with a note. No catalogue change.
3. Close the item with a note that names the Trading correction, or the dismissal reason.

## 4. Record the decision

On the item: the decision, the note (the evidence in one line: source, URL, time checked, score), and the
staff name (recorded automatically). In Trading: the same reason text. Keep the exported snapshots and the
official evidence (a screenshot or a record id) with the case file.

Scraper actions are audited with the actor `system:scraper`; staff actions with the staff id. Nothing is
edited by hand: no SQL on `scrape_observations`, `scrape_observation_history`, the audit log or the ledger.

## Afterwards

- Check the affected bets settled as expected, and that the reconciliation for the day is `clean`
  ([reconciliation](reconciliation-mismatch.md)).
- Record the incident log entry ([basics](incident-basics.md)) for any `result_correction` on settled bets, and
  for every correction that voided a bet: time, match, old and new score, decision, who checked, evidence.
