# Runbooks

Short procedures for the people on call. Each one says what you see, what to check, what to do, and what
must be recorded. Commands assume the production compose stack, run from the repository root of the host:

```bash
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
```

| Runbook                                                 | Use it when                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Incident basics](incident-basics.md)                   | Anything is down, slow or wrong: first 15 minutes, severities, communication                                             |
| [Payouts stuck or flagged](payouts-stuck-or-flagged.md) | A withdrawal is pending too long, flagged, or a deposit is flagged                                                       |
| [SMS rail and manual payouts](sms-rail.md)              | An SMS-rail alarm, the SMS review queue, a manual payout, the collection handset                                         |
| [Reconciliation mismatch](reconciliation-mismatch.md)   | A reconciliation run ends in `mismatches` or `failed`                                                                    |
| [AML flag review](aml-flag-review.md)                   | A player was flagged or a withdrawal is held for `aml_review`                                                            |
| [Rotating secrets](rotating-secrets.md)                 | Scheduled rotation or a suspected leak (incl. `ADMIN_TOTP_KEY`)                                                          |
| [Restore from backup](restore-from-backup.md)           | Data loss, corruption, a bad migration, or a disaster-recovery drill                                                     |
| [Feed source broken or blocked](feed-source-broken.md)  | A scraper source shows `broken` or `blocked`, or a `source_broken` item is open                                          |
| [Feed result disputed](feed-result-disputed.md)         | A result item is open: `result_conflict`, `result_correction` or `result_unverified`                                     |
| [Adding a new feed source](feed-new-source.md)          | A new scraper source is to be onboarded, from terms and dry runs to shadow mode                                          |
| [Odds credits low](odds-credits-low.md)                 | A `source_broken` item with reason `budget_low`, `budget_exhausted`, `unauthorized`, `unexpected_cost` or `market_stale` |

Related: [deployment](../deployment.md), [backups](../backups.md), [scraper operations](../scraper-operations.md).

Alerts: with `OWNER_ALERT_PHONES` set, the owner's phone gets a short SMS (at most one per alarm and 30
minutes) for a source broken or stale, the odds credits, the ladder shadow and the SMS rail alarms. It says
what the system already did, not what to do; the runbook of the same alarm says what to check
([`docs/scraper.md` 6.3a](../scraper.md)).

Rules that hold in every runbook:

- **Never edit the ledger.** `ledger_entries`, `ledger_transactions` and `audit_log` are append-only by
  database trigger. Corrections are new, balanced postings made through the back office or the application
  services, never SQL `UPDATE`/`DELETE`/`TRUNCATE`.
- **Money is only moved by the application** (ledger services with idempotency keys). Do not "fix" a balance
  with a hand-written transaction; use the back-office action named in the runbook.
- **Do not tip off players** about AML reasons; players only see `manual_review`.
- **Write down what you did** (time, who, what, why) in the incident log; staff actions are audited
  automatically, shell actions are not.
- Production data stays in production: do not copy it to a laptop or a lower environment.
