#!/usr/bin/env bash
# Tests infra/scripts/backup.sh `wal` and `scraper` against a stub `docker` (no Docker needed; `age`
# must be installed). Phase 12 review I2: with BACKUP_AGE_RECIPIENT set, WAL segments must be stored
# encrypted with a checksum, never in plaintext. The scraper archive tarball follows the same rules,
# and `prune` must never delete it.
#
# Usage: bash infra/scripts/backup.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v age >/dev/null && command -v age-keygen >/dev/null || {
  echo "backup.test.sh: age and age-keygen are required" >&2
  exit 2
}
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/pgwal" "$WORK/out" "$WORK/scraper/store/ab/cd"

# The stub runs `docker compose exec -T postgres|scraper …` and `docker compose cp postgres:…`
# locally, with the containers' /backups/wal mapped to $WORK/pgwal and /var/lib/vamos/scraper to
# $WORK/scraper.
cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  a="${a//\/backups\/wal/$FAKE_WAL}"
  args+=("${a//\/var\/lib\/vamos\/scraper/$FAKE_SCRAPER}")
done
[[ "${args[0]}" == compose ]] || { echo "stub docker: unexpected $*" >&2; exit 1; }
case "${args[1]}" in
  exec)
    i=2
    [[ "${args[$i]}" == -T ]] && i=$((i + 1))
    [[ "${args[$i]}" == postgres || "${args[$i]}" == scraper ]] ||
      { echo "stub docker: exec on ${args[$i]}" >&2; exit 1; }
    exec "${args[@]:$((i + 1))}"
    ;;
  cp) cp -r "${args[2]#postgres:}" "${args[3]}" ;;
  *) echo "stub docker: unexpected $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH" FAKE_WAL="$WORK/pgwal" FAKE_SCRAPER="$WORK/scraper" BACKUP_DIR="$WORK/out"

age-keygen -o "$WORK/key.txt" 2>/dev/null
RECIPIENT="$(age-keygen -y "$WORK/key.txt")"
SEGMENT=000000010000000000000001
printf 'wal segment one' | gzip >"$WORK/pgwal/$SEGMENT.gz"
printf 'raw snapshot' | gzip >"$WORK/scraper/store/ab/cd/abcdef.gz"
printf 'partial' >"$WORK/pgwal/000000010000000000000002.gz.tmp"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 1. Encrypted: <segment>.gz.age plus its checksum, nothing in plaintext, temp files skipped.
BACKUP_AGE_RECIPIENT="$RECIPIENT" bash "$ROOT/infra/scripts/backup.sh" wal >/dev/null
[[ -f "$WORK/out/wal/$SEGMENT.gz.age" ]] || fail "no encrypted segment"
[[ ! -e "$WORK/out/wal/$SEGMENT.gz" ]] || fail "plaintext segment copied"
[[ ! -e "$WORK/out/wal/000000010000000000000002.gz.tmp" ]] || fail "temp file copied"
(cd "$WORK/out/wal" && sha256sum -c --quiet "$SEGMENT.gz.age.sha256") || fail "bad checksum"
[[ "$(age -d -i "$WORK/key.txt" "$WORK/out/wal/$SEGMENT.gz.age" | gunzip)" == 'wal segment one' ]] ||
  fail "segment does not decrypt to the original"

# 2. A second run copies only new segments (an existing one is not rewritten).
before="$(stat -c %Y.%s "$WORK/out/wal/$SEGMENT.gz.age")"
sleep 1
printf 'wal segment three' | gzip >"$WORK/pgwal/000000010000000000000003.gz"
BACKUP_AGE_RECIPIENT="$RECIPIENT" bash "$ROOT/infra/scripts/backup.sh" wal >/dev/null
[[ -f "$WORK/out/wal/000000010000000000000003.gz.age" ]] || fail "new segment not copied"
[[ "$(stat -c %Y.%s "$WORK/out/wal/$SEGMENT.gz.age")" == "$before" ]] || fail "segment rewritten"

# 3. Without a recipient while the backup directory holds encrypted files: refused, nothing written.
printf 'wal segment four' | gzip >"$WORK/pgwal/000000010000000000000004.gz"
if bash "$ROOT/infra/scripts/backup.sh" wal >/dev/null 2>&1; then
  fail "plaintext backup next to encrypted ones was not refused"
fi
[[ ! -e "$WORK/out/wal/000000010000000000000004.gz" ]] || fail "plaintext segment written"

# 4. A plaintext setup (no age anywhere) still works, with checksums.
rm -rf "$WORK/out"/*
bash "$ROOT/infra/scripts/backup.sh" wal >/dev/null
[[ -f "$WORK/out/wal/$SEGMENT.gz" ]] || fail "plaintext segment missing"
(cd "$WORK/out/wal" && sha256sum -c --quiet "$SEGMENT.gz.sha256") || fail "bad plaintext checksum"

# 5. The scraper archive: an encrypted tarball with a checksum that restores the snapshot tree, and
#    prune leaves it alone however old it is.
BACKUP_AGE_RECIPIENT="$RECIPIENT" bash "$ROOT/infra/scripts/backup.sh" scraper >/dev/null
archive="$(find "$WORK/out/scraper" -name 'scraper-*.tar.gz.age')"
[[ -n "$archive" ]] || fail "no encrypted scraper archive"
[[ -z "$(find "$WORK/out/scraper" -name 'scraper-*.tar.gz' -print -quit)" ]] || fail "plaintext scraper archive written"
(cd "$WORK/out/scraper" && sha256sum -c --quiet "$(basename "$archive").sha256") || fail "bad scraper checksum"
mkdir "$WORK/restored"
age -d -i "$WORK/key.txt" "$archive" | tar -xz -C "$WORK/restored"
[[ "$(gunzip -c "$WORK/restored/store/ab/cd/abcdef.gz")" == 'raw snapshot' ]] || fail "snapshot not restored"
touch -d '2000-01-01' "$archive"
BACKUP_AGE_RECIPIENT="$RECIPIENT" bash "$ROOT/infra/scripts/backup.sh" prune >/dev/null
[[ -f "$archive" ]] || fail "prune deleted a scraper archive"
rm -rf "$WORK/out/scraper" "$WORK/restored"
echo "backup.test.sh: ok"
