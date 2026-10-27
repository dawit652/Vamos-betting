# Runbooks

Short procedures for the people on call. Each one says what you see, what to check, what to do, and what
must be recorded. Commands assume the production compose stack, run from the repository root of the host:

```bash
export COMPOSE_FILE=infra/docker-compose.prod.yml COMPOSE_ENV_FILES=infra/.env.prod
```

| Runbook                                                 | Use it when                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Incident basics](incident-basics.md)                   | Anything is down, slow or wrong: first 15 minutes, severities, communication     |
| [Payouts stuck or flagged](payouts-stuck-or-flagged.md) | A withdrawal is pending too long, flagged, or a deposit is flagged               |
| [SMS rail and manual payouts](sms-rail.md)              | An SMS-rail alarm, the SMS review queue, a manual payout, the collection handset |
| [Reconciliation mismatch](reconciliation-mismatch.md)   | A reconciliation run ends in `mismatches` or `failed`                            |
| [AML flag review](aml-flag-review.md)                   | A player was flagged or a withdrawal is held for `aml_review`                    |
| [ELS reporting failure](els-reporting-failure.md)       | ELS pending records grow, the reporter shows an error, files are missing         |
| [Rotating secrets](rotating-secrets.md)                 | Scheduled rotation or a suspected leak (incl. `ADMIN_TOTP_KEY`)                  |
| [Restore from backup](restore-from-backup.md)           | Data loss, corruption, a bad migration, or a disaster-recovery drill             |

Related: [deployment](../deployment.md), [backups](../backups.md), [compliance](../compliance.md).

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
