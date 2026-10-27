# Backups and restore

What is backed up, how often, how long it is kept, and how to prove it can be restored. The scripts are
`infra/scripts/backup.sh` and `infra/scripts/restore-drill.sh`; the compose stack
(`infra/docker-compose.prod.yml`) already archives WAL. Restore procedure:
[runbook](runbooks/restore-from-backup.md).

## 1. What matters

| Data                                                                                | Where                               | Loss means                                                                           | Kept                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| PostgreSQL: ledger, bets, wallets, audit log, KYC, staff, summaries, reconciliation | volume `pgdata`                     | Money records gone. The ledger and audit log are append-only by DB trigger.          | **7 years** (ledger, audit, summaries, reconciliation) |
| ELS reports (JSONL stream, daily CSVs)                                              | volume `els` (`/var/lib/vamos/els`) | A regulatory breach; the database can re-emit missing rows but not rewrite history.  | **7 years**                                            |
| Secrets (`ADMIN_TOTP_KEY`, `SESSION_SECRET`, `PASSWORD_PEPPER`, provider keys)      | secret manager                      | Staff cannot sign in after a restore; no password verifies; ID hashes stop matching. | as long as the data they protect                       |
| Redis (queues, rate limits, pub/sub)                                                | volume `redisdata`                  | Nothing durable: queued jobs are rebuilt from the outbox by sweeps.                  | not backed up                                          |
| Images and code                                                                     | git + registry                      | Rebuild from the tagged commit.                                                      | per release                                            |

The database is never pruned, so the live database itself holds 7 years of ledger. The backups below protect
it against loss; their own retention is shorter except for the yearly archive.

## 2. Strategy

1. **Logical dump every night** (`pg_dump -Fc`, about 10 minutes at launch scale). Portable, restores one
   table or the whole database, version-independent within PostgreSQL 16.x. It is the backup the restore
   drill checks.
2. **WAL archiving, continuous.** The compose Postgres runs `archive_mode=on` with `archive_timeout=300`:
   every finished 16 MB segment (or every 5 minutes at the latest) is gzipped into the `pgwal` volume, and
   `backup.sh wal` copies each new one to `BACKUP_DIR/wal` through the same path as every other backup:
   encrypted (`<segment>.gz.age`) when `BACKUP_AGE_RECIPIENT` is set, always with a `.sha256`.
   Together with a **weekly base backup** (`backup.sh base`, `pg_basebackup`) this allows point-in-time
   recovery to any moment, for example "one second before the bad deploy". Target RPO once the segments are
   copied off the host: 5 minutes. A dump alone gives an RPO of up to a day.
3. **ELS directory archive** (`backup.sh els`, a tarball) at least daily, and after every business-day
   finalisation (the file set only grows).
4. **Off the host, encrypted, in two places.** Everything under `BACKUP_DIR` is copied to storage on another
   machine and another site (rsync/rclone/object storage), encrypted with `age` (`BACKUP_AGE_RECIPIENT`:
   every file `backup.sh` writes, WAL segments included, is encrypted on the host before it is copied
   anywhere; once `BACKUP_DIR` holds `.age` files a run without the recipient is refused, so a cron line that
   forgets it cannot leave plaintext beside them). Keep
   the private key apart from the backups and from the host (two custodians). Where the copies may live is a
   data-residency question ([deployment.md](deployment.md#7-hosting-in-ethiopia-and-data-residency-to-confirm)).
5. **Checksums.** `backup.sh` writes a `.sha256` beside every file (WAL segments too); the drill verifies it.
   `pnpm test:infra` (`infra/scripts/backup.test.sh`, in CI) checks the WAL path against a stub docker.

Managed Postgres (when you move to one) replaces items 1-2 with its own snapshots and PITR; keep the nightly
logical dump and the ELS archive.

## 3. Schedule

Run from the repository root of the host (cron or a systemd timer), as a user that can use Docker:

```cron
# m h dom mon dow
17 2 * * *  cd /srv/vamos && BACKUP_DIR=/var/backups/vamos BACKUP_AGE_RECIPIENT=age1... infra/scripts/backup.sh all
47 * * * *  cd /srv/vamos && BACKUP_DIR=/var/backups/vamos BACKUP_AGE_RECIPIENT=age1... infra/scripts/backup.sh wal
37 3 * * 0  cd /srv/vamos && BACKUP_DIR=/var/backups/vamos BACKUP_AGE_RECIPIENT=age1... infra/scripts/backup.sh base
27 4 * * *  cd /srv/vamos && BACKUP_DIR=/var/backups/vamos infra/scripts/backup.sh prune
```

Then sync `/var/backups/vamos` off the host right after each run and alert when the newest dump is older than
26 hours, when `sha256sum -c` fails, or when `pg_stat_archiver.failed_count` rises (see section 6).
Hourly `wal` copies bound the loss of a lost disk to about an hour; run it every 5 minutes if the RPO
promise is 5 minutes.

`all` = dump + els + wal. WAL segments in the `pgwal` volume are cleaned manually after a base backup, so the
volume does not fill: keep everything since the oldest base backup you still rely on, then
`docker compose exec postgres pg_archivecleanup -x .gz /backups/wal <first segment named in the oldest kept
base backup's .backup label>` (the label file is `<segment>.<offset>.backup` in the same directory).

## 4. Retention

| Backup                    | Keep                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Nightly dumps             | 35 days; the 1st of each month for 24 months; **the 1st of January for ever** (at least 7 years) |
| Weekly base backups + WAL | the last 5 weeks of base backups and every WAL segment since the oldest of them                  |
| ELS archives              | **7 years** minimum (`ELS_KEEP_DAYS=2600`); never delete earlier on your own                     |
| Drill logs and checksums  | 7 years                                                                                          |

`backup.sh prune` applies the dump and base-backup rules (`DUMP_KEEP_DAYS`, `DUMP_KEEP_MONTHS`); it never
removes ELS archives younger than `ELS_KEEP_DAYS`. After the 7 years, deleting requires a decision from
counsel (retention periods are a placeholder in `docs/compliance.md`, to confirm) and consideration of
player-data erasure duties: PII in old backups cannot be edited, so shorten the life of the non-archive copies
rather than the archive.

## 5. Restore drill

Prove the backups work, on a calendar, not when you need them.

- **When:** monthly, after any change to the database version, the backup scripts or the key custody, and
  before the first real-money launch.
- **Logical check (minutes, no impact on production):**

  ```bash
  infra/scripts/restore-drill.sh /var/backups/vamos/db/vamos-<stamp>.dump[.age] [/var/backups/vamos/els/els-<stamp>.tar.gz]
  ```

  (an `.age` file needs `AGE_IDENTITY=/path/to/age-key.txt`). It verifies the checksum, restores into a
  throwaway postgres container, and checks that every ledger transaction sums to zero, every account balance
  equals the sum of its entries, every entry has its transaction, and the migrations are recorded. It prints
  row counts and the newest ledger/audit timestamps: compare them with production
  (`select count(*), max(created_at) from ledger_entries`) and with the dump time.

- **PITR check (quarterly):** restore the latest base backup plus WAL to a scratch host following the
  [runbook](runbooks/restore-from-backup.md#point-in-time-recovery) with `recovery_target_time` set to a
  known moment, and check that the data stops there.
- **Full-stack check (before launch, then yearly):** on a scratch machine restore the dump, the ELS
  archive and the secrets, start the compose stack and run `scripts/smoke.sh`; sign in to the back office with
  a real staff TOTP (this proves `ADMIN_TOTP_KEY` custody).
- **Record** date, backup used, who ran it, duration (compare with the RTO below), the printed figures and any
  failure in the drill log kept with the compliance files. A drill that was not recorded did not happen.

Targets to confirm with the licence: RTO 4 hours, RPO 5 minutes with WAL shipping (24 hours without).

## 6. Monitoring the backups

```bash
# WAL archiving health: failed_count must stay 0, last_archived_time recent
docker compose exec postgres psql -U vamos -d vamos -c \
  "select last_archived_wal, last_archived_time, failed_count, last_failed_time from pg_stat_archiver"
# Disk used by the archive and the data directory
docker compose exec postgres du -sh /backups/wal /var/lib/postgresql/data
# Newest dump and its checksum
ls -t /var/backups/vamos/db | head -2; (cd /var/backups/vamos/db && sha256sum -c "$(ls -t *.sha256 | head -1)")
```

A failing `archive_command` stops WAL from being recycled and can fill the disk: a rising `failed_count` is a
page-the-on-call alert.
