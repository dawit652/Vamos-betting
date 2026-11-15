# Incident basics

## Severities

| Level | Meaning                                                                              | Response                       |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------ |
| SEV1  | Money at risk or wrong (ledger/balance error, double payout), data breach, site down | Page on-call + lead now        |
| SEV2  | Betting, deposits or withdrawals impaired for many players                           | Page on-call, fix within hours |
| SEV3  | Degraded or single-feature problem, one player's issue, a flagged item to review     | Next working hours             |

Anything touching the ledger, payouts or the licence is SEV1/SEV2 until proven otherwise.

## First 15 minutes

1. **Confirm and size it.** `scripts/smoke.sh --production --worker http://localhost:4100` (use the public
   URLs from an outside machine too: `--api https://api... --web ... --admin ...`).
2. **Look at the stack.**
   ```bash
   docker compose ps                       # unhealthy / restarting containers
   docker compose logs --since 30m api worker | grep -E '"level":(50|60)'     # errors and fatals
   curl -s localhost:4100/ready            # worker: database, redis, queues
   ```
   A log line carries a `requestId`; the same id is in the `x-request-id` response header and in the error
   body the player or support saw, so one request can be followed across the logs.
3. **Classify**
   - `api` unhealthy, `worker` fine: look at its fatal logs (refused configuration, database unreachable).
   - `postgres` unhealthy or disk full: stop writes to avoid corruption, free disk (WAL archive in the
     `pgwal` volume is the usual cause when `archive_command` fails, see [backups](../backups.md#6-monitoring-the-backups)),
     then restart.
   - `redis` down: the api answers but live updates, rate limits and queues stop; restart it, the worker
     recovers its queues from the outbox sweeps.
   - Everything up but results wrong: go to the specific runbook (payouts, reconciliation, AML).
4. **Stop the bleeding** (use the least drastic option that works):
   - suspend one market or event in the back office (Trading: market status), or void a market/selection;
   - stop new money in/out: `docker compose stop worker` pauses payouts, settlement and reporting (nothing
     is lost, the outbox keeps the events; restart when fixed). Bets and deposits already in flight are
     idempotent by key;
   - put a maintenance page in front of `web` at the proxy;
   - as a last resort `docker compose stop web api` (the ledger stays consistent; every write is one DB
     transaction).
5. **Communicate.** One incident channel, one commander, one scribe. Tell support what to say; do not
   speculate publicly. For suspected fraud or a data breach the operator decides on notifying the
   data-protection authority within the legal deadlines (to confirm with counsel).

## Useful commands

```bash
docker compose logs -f --tail 200 api worker       # follow
docker compose restart worker                      # graceful: finishes in-flight jobs (up to 60 s)
docker compose exec postgres psql -U vamos -d vamos      # read-only investigation only
docker compose exec postgres psql -U vamos -d vamos -c "select state, count(*) from pg_stat_activity group by 1"
docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli info memory | head -5'
docker compose run --rm migrate node dist/ops/admin-unlock.js --email staff@example.et   # locked-out staff
```

Staff locked out? Another admin can unlock from the back office; `admin-unlock.js` is the out-of-band way.
A lost authenticator: an admin with `staff.manage` resets it (`POST /admin/staff/:id/reset-totp`, audited as
`staff.totp_reset`; the response carries the new secret to enrol, shown once) and the user re-enrols.

## After the incident

- Restore service, then verify: smoke test, a reconciliation run for today (back office, Compliance,
  Reconciliation, "Run now") that ends `clean`.
- Write a blameless review within 3 working days: timeline, impact (players, ETB), cause, what worked,
  actions with owners. Store it with the compliance files (7 years for anything touching money).
- If the cause was a defect, add a regression test before the fix lands.
