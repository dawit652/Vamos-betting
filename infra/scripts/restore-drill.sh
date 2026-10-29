#!/usr/bin/env bash
# Restore drill (docs/backups.md): restores a database dump into a THROWAWAY postgres container
# and checks that the ledger is intact. It never touches the running stack. Run it monthly, and
# after every change to the backup setup; record the result in the drill log.
#
# Usage: infra/scripts/restore-drill.sh <dump file> [scraper archive to list]
#   <dump file>   a pg_dump -Fc file from backup.sh (a .age file needs AGE_IDENTITY=<key file>)
#   scraper archive   a scraper-<time>.tar.gz from backup.sh (a .age file is decrypted the same way)
# Environment: POSTGRES_USER (default vamos), POSTGRES_DB (default vamos), POSTGRES_IMAGE
# (default postgres:16-alpine, keep it equal to the production major version).
# Exit status: 0 when every check passed.
set -euo pipefail

DUMP="${1:?usage: restore-drill.sh <dump file> [scraper archive]}"
SCRAPER="${2:-}"
PGUSER_="${POSTGRES_USER:-vamos}"
PGDB="${POSTGRES_DB:-vamos}"
IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
NAME="vamos-restore-drill-$$"
[[ -f "$DUMP" ]] || { echo "no such file: $DUMP" >&2; exit 2; }

if [[ -f "$DUMP.sha256" ]]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$DUMP").sha256") || { echo "checksum mismatch" >&2; exit 1; }
fi
reader=(cat "$DUMP")
if [[ "$DUMP" == *.age ]]; then
  reader=(age -d -i "${AGE_IDENTITY:?set AGE_IDENTITY to the age identity file}" "$DUMP")
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER="$PGUSER_" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB="$PGDB" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U "$PGUSER_" -d "$PGDB" >/dev/null 2>&1 && break
  sleep 1
done
# The entrypoint restarts the server once after initdb: wait for a stable one.
sleep 3
docker exec "$NAME" pg_isready -U "$PGUSER_" -d "$PGDB" >/dev/null || { echo "scratch postgres did not start" >&2; exit 1; }

# Roles live outside the dump: create the app role (migration 0030) so its GRANTs restore.
docker exec "$NAME" psql -U "$PGUSER_" -d "$PGDB" -qc "CREATE ROLE vamos_app NOLOGIN" >/dev/null

echo "restoring $DUMP ..."
start=$SECONDS
"${reader[@]}" | docker exec -i "$NAME" pg_restore -U "$PGUSER_" -d "$PGDB" --no-owner --exit-on-error
echo "restored in $((SECONDS - start)) s"

q() { docker exec "$NAME" psql -U "$PGUSER_" -d "$PGDB" -tAq -c "$1"; }
fail=0
check() { # check NAME SQL EXPECTED
  local got
  got="$(q "$2")"
  if [[ "$got" == "$3" ]]; then printf 'ok    %s\n' "$1"; else printf 'FAIL  %s (got %s, expected %s)\n' "$1" "$got" "$3"; fail=1; fi
}

check "every ledger transaction sums to zero" \
  "SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY 1 HAVING sum(amount) <> 0) t" 0
check "every account balance equals the sum of its entries" \
  "SELECT count(*) FROM ledger_accounts a LEFT JOIN (SELECT account_id, sum(amount) s FROM ledger_entries GROUP BY 1) e ON e.account_id = a.id WHERE a.balance <> coalesce(e.s, 0)" 0
check "every entry belongs to a transaction" \
  "SELECT count(*) FROM ledger_entries e LEFT JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.id IS NULL" 0
check "migrations are recorded" "SELECT (count(*) > 0)::int FROM drizzle.__drizzle_migrations" 1

echo "--- figures to compare with production (docs/backups.md) ---"
for t in ledger_transactions ledger_entries audit_log users bets; do
  printf '%-24s %s rows\n' "$t" "$(q "SELECT count(*) FROM $t" 2>/dev/null || echo n/a)"
done
printf '%-24s %s\n' "latest ledger entry" "$(q "SELECT coalesce(max(created_at)::text, 'none') FROM ledger_entries")"
printf '%-24s %s\n' "latest audit record" "$(q "SELECT coalesce(max(created_at)::text, 'none') FROM audit_log")"

if [[ -n "$SCRAPER" ]]; then
  echo "--- scraper archive $SCRAPER ---"
  [[ -f "$SCRAPER" ]] || { echo "no such file: $SCRAPER" >&2; exit 2; }
  if [[ -f "$SCRAPER.sha256" ]]; then
    (cd "$(dirname "$SCRAPER")" && sha256sum -c "$(basename "$SCRAPER").sha256") || { echo "scraper archive checksum mismatch" >&2; exit 1; }
  fi
  listing=(cat "$SCRAPER")
  if [[ "$SCRAPER" == *.age ]]; then
    listing=(age -d -i "${AGE_IDENTITY:?set AGE_IDENTITY to the age identity file}" "$SCRAPER")
  fi
  "${listing[@]}" | tar -tz | head -n 5
  printf 'snapshots: %s\n' "$("${listing[@]}" | tar -tz | grep -c '\.gz$' || true)"
fi

if ((fail)); then echo "restore drill FAILED"; exit 1; fi
echo "restore drill passed"
