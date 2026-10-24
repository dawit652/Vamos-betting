# Restore from backup

Use for data loss, corruption, a destructive migration, a lost host, or a drill. Backups and their schedule:
[backups.md](../backups.md). **SEV1.** Decide first: _restore at all?_ A restore discards everything after the
chosen point (bets, deposits, payouts that happened since). Prefer fixing forward (a code fix and a
correction) when the data is merely wrong; restore when data is missing or untrustworthy.

## Before you start

- Declare the incident and stop writes: `docker compose stop web admin api worker` (keep `postgres` for a
  last dump of the damaged state: `infra/scripts/backup.sh dump`, then keep that file: it is evidence and
  it contains the transactions since the last backup).
- Gather: the backup files (`db/*.dump[.age]`, `base/*.tar`, `wal/*`, `els/*.tar.gz`), the age identity,
  and the **matching secrets** (`ADMIN_TOTP_KEY`, `SESSION_SECRET`, provider keys). Check `.sha256` files.
- Decide the recovery point: latest dump (loses up to a day), or point-in-time with WAL (to the minute).
- Never restore a demo database into a licensed deployment or the reverse (the operating mode is claimed at
  startup and a mismatch is refused).

## A. Logical restore (from a dump)

```bash
# 1. Prove the dump first (scratch container, does not touch production)
infra/scripts/restore-drill.sh /var/backups/vamos/db/vamos-<stamp>.dump
# 2. New, empty database in the production Postgres (the old one is kept for evidence)
docker compose up -d postgres
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"${POSTGRES_DB}_damaged_$(date +%Y%m%d)\"" -c "CREATE DATABASE \"$POSTGRES_DB\""'
# 3. Restore (an .age file: age -d -i key.txt file | ...)
cat /var/backups/vamos/db/vamos-<stamp>.dump | docker compose exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error'
```

Roles are not in the dump. The production cluster already has the app role `vamos_app` (migration 0030);
on a **new** cluster (lost host) create it before step 3, or the dump's `GRANT ... TO vamos_app` stops the
restore: `docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "CREATE ROLE vamos_app NOLOGIN"'`.
The migrate job gives it its login again from `APP_DB_PASSWORD` when the stack starts.

If a connection still holds the old database, terminate it first (`SELECT pg_terminate_backend(pid) FROM
pg_stat_activity WHERE datname = '<db>' AND pid <> pg_backend_pid()`).

## B. Point-in-time recovery (base backup + WAL)

For a lost host or "restore to just before 14:07". The restored server must start with the **same server
settings** as production (`max_connections` etc.; the compose `command` list), or recovery aborts with
"insufficient parameter settings".

```bash
W=/srv/restore && mkdir -p $W/data $W/wal
tar -xf /var/backups/vamos/base/base-<stamp>.tar -C $W/data          # newest base backup BEFORE the target
cp -r /var/backups/vamos/wal/. $W/wal/ && chmod -R a+rX $W/wal         # all segments since that base backup
mkdir -p $W/data/pg_wal && chown -R 70:70 $W/data && chmod 700 $W/data  # uid 70 = postgres in the alpine image
cat >> $W/data/postgresql.auto.conf <<'CONF'
restore_command = 'gunzip -c /wal/%f.gz > %p'
recovery_target_time = '2026-10-19 14:06:30+00'
recovery_target_action = 'promote'
CONF
touch $W/data/recovery.signal && chown 70:70 $W/data/recovery.signal $W/data/postgresql.auto.conf
docker run -d --name vamos-pitr -v $W/data:/var/lib/postgresql/data -v $W/wal:/wal:ro \
  -e POSTGRES_PASSWORD=unused postgres:16-alpine postgres -c max_connections=200
docker logs -f vamos-pitr      # wait for "archive recovery complete" and "ready to accept connections"
```

Check the data stops at the target (`select max(created_at) from ledger_entries`). Then either dump this
server and restore the dump into production (procedure A), or run the production stack on this data
directory (mount it as the `pgdata` volume; with `recovery_target_action = 'promote'` it opens read-write,
on a new timeline). Remove `recovery_target_*` from `postgresql.auto.conf` before long-term use. This
procedure was exercised against the compose stack (base backup + gzipped WAL, restore to a time between two
commits); repeat it in the quarterly drill.

## C. ELS reports and secrets

```bash
docker compose up -d --no-start worker
docker run --rm -v vamos_els:/els -v /var/backups/vamos/els:/in:ro node:22-alpine \
  sh -c 'cd /els && tar -xzf /in/els-<stamp>.tar.gz && chown -R 1000:1000 /els && chmod -R u=rwX,go= /els'
```

Restore the ELS archive that is **closest after** the database recovery point. Records written to the old
database after the backup but missing from the files are re-emitted by the sweep only if `els_reports` did not
record them; otherwise see [ELS reporting failure](els-reporting-failure.md). Put the original secrets back
before starting the services: without the matching `ADMIN_TOTP_KEY` staff cannot sign in
([rotating secrets](rotating-secrets.md#admin_totp_key-staff-authenticator-secrets)).

## Bring it back and verify

1. `docker compose up -d --wait` (migrate runs first and applies anything newer than the backup).
2. `scripts/smoke.sh --production --worker http://localhost:4100`.
3. Sign in to the back office with a real staff TOTP.
4. **Reconcile**: Compliance -> Reconciliation -> "Run now" for the last 7 business dates; every check must be
   `clean`. Expect the PSP check to differ if payments completed at the providers after the recovery point:
   see step 5.
5. **Reconcile with the real world for the lost window** (from the recovery point to the outage): provider
   dashboards/statements for deposits and payouts, ELS stream, support tickets. Deposits the provider
   collected but we lost must be credited (flagged-deposit flow); payouts the provider sent but we lost
   must be recorded (settle as paid) so nobody is paid twice. Do this _before_ reopening withdrawals: keep
   `worker` stopped until the payouts that were `processing` at the recovery point are understood, then start it.
6. Reopen `web`/`admin`, announce, and write the review: backup used, recovery point, window lost, players
   affected, ETB reconciled, time to recover (compare with the RTO in [backups](../backups.md#5-restore-drill)).

Keep the renamed damaged database and the last dump of it until counsel and the licence holder agree they
can be destroyed.
