#!/usr/bin/env bash
# Backups of the production compose stack (docs/backups.md). Writes to BACKUP_DIR on the host:
#
#   dump   logical dump of the database (pg_dump -Fc)               db/vamos-<UTC time>.dump
#   base   physical base backup for point-in-time recovery          base/base-<UTC time>.tar
#   wal    copies new archived WAL segments off the pgwal volume    wal/<segment>.gz[.age]
#   scraper the scraper's raw snapshot archive (evidence behind   scraper/scraper-<UTC time>.tar.gz
#          applied results; the `scraper_archive` volume)
#   prune  deletes dumps and base backups past their retention  (scraper archives are kept, see below)
#   all    dump + scraper + wal (default)
#
# Usage: infra/scripts/backup.sh [dump|base|wal|scraper|prune|all]
# Environment:
#   COMPOSE_FILE / COMPOSE_ENV_FILES   default infra/docker-compose.prod.yml / infra/.env.prod
#   BACKUP_DIR                         default ./backups
#   BACKUP_AGE_RECIPIENT               an `age` public key: encrypts every file written (.age), WAL
#                                      segments included. Once BACKUP_DIR holds .age files, a run
#                                      without it is refused (BACKUP_ALLOW_PLAINTEXT=1 overrides)
#   DUMP_KEEP_DAYS=35 DUMP_KEEP_MONTHS=24   daily dumps for 35 days, the 1st of each month for 24
#                                      months, the 1st of January for ever (>= 7 years: the ledger
#                                      and audit log must be kept 7 years)
#                                      Scraper archives are never pruned: the evidence behind a
#                                      result that settled a bet stays as long as the bets do.
# Run it from cron or a systemd timer (docs/backups.md) and copy BACKUP_DIR off the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
export COMPOSE_ENV_FILES="${COMPOSE_ENV_FILES:-infra/.env.prod}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DUMP_KEEP_DAYS="${DUMP_KEEP_DAYS:-35}"
DUMP_KEEP_MONTHS="${DUMP_KEEP_MONTHS:-24}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077

dc() { docker compose "$@"; }

# finish FILE: encrypt when BACKUP_AGE_RECIPIENT is set, then record a checksum.
write() {
  local file="$1" tmp="$1.partial"
  if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
    command -v age >/dev/null || { echo "age is required when BACKUP_AGE_RECIPIENT is set" >&2; exit 2; }
    age -r "$BACKUP_AGE_RECIPIENT" >"$tmp"
    file="$file.age"
  else
    cat >"$tmp"
  fi
  [[ -s "$tmp" ]] || { rm -f "$tmp"; echo "empty backup: $file" >&2; exit 1; }
  mv "$tmp" "$file"
  (cd "$(dirname "$file")" && sha256sum "$(basename "$file")" >"$(basename "$file").sha256")
  echo "wrote $file ($(du -h "$file" | cut -f1))"
}

do_dump() {
  mkdir -p "$BACKUP_DIR/db"
  dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' \
    | write "$BACKUP_DIR/db/vamos-$STAMP.dump"
}

do_base() {
  mkdir -p "$BACKUP_DIR/base"
  # Tar to stdout; WAL is archived separately (-X none), `wal` copies it off the host's volume.
  dc exec -T postgres sh -c 'pg_basebackup -U "$POSTGRES_USER" -D - -Ft -X none -c fast' \
    | write "$BACKUP_DIR/base/base-$STAMP.tar"
}

# A run without BACKUP_AGE_RECIPIENT (e.g. a cron line missing it) must not leave plaintext copies
# next to encrypted backups.
check_encryption() {
  if [[ -z "${BACKUP_AGE_RECIPIENT:-}" && "${BACKUP_ALLOW_PLAINTEXT:-}" != 1 ]] &&
    [[ -n "$(find "$BACKUP_DIR" -name '*.age' -print -quit 2>/dev/null)" ]]; then
    echo "BACKUP_DIR holds encrypted backups but BACKUP_AGE_RECIPIENT is not set: refusing to" \
      "write plaintext (set it, or BACKUP_ALLOW_PLAINTEXT=1)" >&2
    exit 2
  fi
}

# Each finished segment once, through write() (encrypted when BACKUP_AGE_RECIPIENT is set, with its
# .sha256). archive_command writes <segment>.gz.tmp and renames it, so *.tmp is still being written.
# WAL files never change: a segment with a checksum here (plain or .age) is not copied again.
do_wal() {
  mkdir -p "$BACKUP_DIR/wal"
  local names name copied=0
  names="$(dc exec -T postgres sh -c 'cd /backups/wal && ls -1A' </dev/null)"
  while IFS= read -r name; do
    [[ -n "$name" && "$name" != *.tmp ]] || continue
    if [[ ! "$name" =~ ^[0-9A-Za-z._-]+$ ]]; then
      echo "skipping unexpected name in the WAL archive: $name" >&2
      continue
    fi
    [[ -f "$BACKUP_DIR/wal/$name.sha256" || -f "$BACKUP_DIR/wal/$name.age.sha256" ]] && continue
    dc exec -T postgres cat "/backups/wal/$name" </dev/null | write "$BACKUP_DIR/wal/$name" >/dev/null
    copied=$((copied + 1))
  done <<<"$names"
  echo "WAL: $copied new file(s) copied to $BACKUP_DIR/wal${BACKUP_AGE_RECIPIENT:+ (encrypted)}"
}

# The archive only grows and the database marks the snapshots behind applied results `keep`, so each
# run is a full tarball and none is ever pruned. The tarball is read through the running scraper
# container (it must be up, like postgres for the dump).
do_scraper() {
  mkdir -p "$BACKUP_DIR/scraper"
  dc exec -T scraper tar -C /var/lib/vamos/scraper -czf - . </dev/null |
    write "$BACKUP_DIR/scraper/scraper-$STAMP.tar.gz"
}

# keep_dump NAME: succeeds when a dump/base file named ...-YYYYmmddTHHMMSSZ... must be kept.
keep_dump() {
  local stamp day month age_days
  stamp="$(sed -E 's/.*-([0-9]{8})T[0-9]{6}Z.*/\1/' <<<"$1")"
  [[ "$stamp" =~ ^[0-9]{8}$ ]] || return 0 # not ours: keep
  day="${stamp:6:2}" month="${stamp:4:2}"
  age_days=$((($(date -u +%s) - $(date -u -d "${stamp:0:4}-$month-$day" +%s)) / 86400))
  ((age_days <= DUMP_KEEP_DAYS)) && return 0
  [[ "$day" == 01 ]] && ((age_days <= DUMP_KEEP_MONTHS * 31)) && return 0
  [[ "$day" == 01 && "$month" == 01 ]] && return 0
  return 1
}

do_prune() {
  local f
  for f in "$BACKUP_DIR"/db/vamos-*.dump* "$BACKUP_DIR"/base/base-*.tar*; do
    [[ -e "$f" && "$f" != *.sha256 ]] || continue
    if ! keep_dump "$(basename "$f")"; then
      rm -f -- "$f" "$f.sha256"
      echo "pruned $f"
    fi
  done
}

case "${1:-all}" in
  dump | base | wal | scraper | all) check_encryption ;;
esac
case "${1:-all}" in
  dump) do_dump ;;
  base) do_base ;;
  wal) do_wal ;;
  scraper) do_scraper ;;
  prune) do_prune ;;
  all) do_dump; do_scraper; do_wal ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2 ;;
esac
