#!/usr/bin/env bash
# Backups of the production compose stack (docs/backups.md). Writes to BACKUP_DIR on the host:
#
#   dump   logical dump of the database (pg_dump -Fc)               db/vamos-<UTC time>.dump
#   base   physical base backup for point-in-time recovery          base/base-<UTC time>.tar
#   wal    copies the archived WAL segments off the pgwal volume    wal/<segment>
#   els    the ELS regulator reports (JSONL stream and CSVs)        els/els-<UTC time>.tar.gz
#   prune  deletes dumps and base backups past their retention      (ELS archives are kept, see below)
#   all    dump + els + wal (default)
#
# Usage: infra/scripts/backup.sh [dump|base|wal|els|prune|all]
# Environment:
#   COMPOSE_FILE / COMPOSE_ENV_FILES   default infra/docker-compose.prod.yml / infra/.env.prod
#   BACKUP_DIR                         default ./backups
#   BACKUP_AGE_RECIPIENT               an `age` public key: encrypts dump, base and els files (.age)
#   DUMP_KEEP_DAYS=35 DUMP_KEEP_MONTHS=24   daily dumps for 35 days, the 1st of each month for 24
#                                      months, the 1st of January for ever (>= 7 years: the ledger,
#                                      audit log and ELS reports must be kept 7 years)
#   ELS_KEEP_DAYS=2600                 ELS archives (7 years + margin); prune never touches newer ones
# Run it from cron or a systemd timer (docs/backups.md) and copy BACKUP_DIR off the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
export COMPOSE_ENV_FILES="${COMPOSE_ENV_FILES:-infra/.env.prod}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
DUMP_KEEP_DAYS="${DUMP_KEEP_DAYS:-35}"
DUMP_KEEP_MONTHS="${DUMP_KEEP_MONTHS:-24}"
ELS_KEEP_DAYS="${ELS_KEEP_DAYS:-2600}"
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

do_wal() {
  mkdir -p "$BACKUP_DIR/wal"
  dc cp postgres:/backups/wal/. "$BACKUP_DIR/wal/"
  echo "WAL segments in $BACKUP_DIR/wal: $(find "$BACKUP_DIR/wal" -type f | wc -l)"
}

do_els() {
  mkdir -p "$BACKUP_DIR/els"
  dc exec -T worker tar -C /var/lib/vamos/els -czf - . | write "$BACKUP_DIR/els/els-$STAMP.tar.gz"
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
  find "$BACKUP_DIR/els" -type f -name 'els-*' -mtime "+$ELS_KEEP_DAYS" -print -delete 2>/dev/null || true
}

case "${1:-all}" in
  dump) do_dump ;;
  base) do_base ;;
  wal) do_wal ;;
  els) do_els ;;
  prune) do_prune ;;
  all) do_dump; do_els; do_wal ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2 ;;
esac
