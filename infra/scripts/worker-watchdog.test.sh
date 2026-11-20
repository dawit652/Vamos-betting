#!/usr/bin/env bash
# Tests infra/scripts/worker-watchdog.sh against a stub `docker` (no Docker needed).
#
# Usage: bash infra/scripts/worker-watchdog.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# The stub answers `docker compose ps -q worker` with $FAKE/id (empty: no running container),
# `docker inspect … <id>` with $FAKE/status, and records every `docker compose restart worker`
# in $FAKE/restarts, failing it when $FAKE/restart-exit holds a non-zero code.
cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == compose && "$2" == ps && "$3" == -q && "$4" == worker ]]; then
  cat "$FAKE/id"
elif [[ "$1" == inspect ]]; then
  [[ "${!#}" == "$(cat "$FAKE/id")" ]] || { echo "stub docker: inspect of ${!#}" >&2; exit 1; }
  cat "$FAKE/status"
elif [[ "$1" == compose && "$2" == restart && "$3" == worker && $# -eq 3 ]]; then
  echo restart >>"$FAKE/restarts"
  exit "$(cat "$FAKE/restart-exit")"
else
  echo "stub docker: unexpected $*" >&2
  exit 1
fi
STUB
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH" FAKE="$WORK" WATCHDOG_STATE_FILE="$WORK/state"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
reset() {
  rm -f "$WORK/state" "$WORK/restarts" "$WORK/err"
  echo abc123 >"$WORK/id"
  echo healthy >"$WORK/status"
  echo 0 >"$WORK/restart-exit"
  : >"$WORK/restarts"
}
# run: the script's exit code in $code, its stderr in $WORK/err.
run() {
  code=0
  bash "$ROOT/infra/scripts/worker-watchdog.sh" >/dev/null 2>"$WORK/err" || code=$?
}
restarts() { wc -l <"$WORK/restarts" | tr -d ' '; }
status() { echo "$1" >"$WORK/status"; }

# 1. Healthy: nothing happens, no alarm.
reset
run
[[ $code -eq 0 && "$(restarts)" == 0 && ! -s "$WORK/err" ]] || fail "healthy worker touched"

# 2. One unhealthy reading does nothing; the second restarts exactly once, with the alarm line.
status unhealthy
run
[[ $code -eq 0 && "$(restarts)" == 0 ]] || fail "restarted after one unhealthy reading"
grep -q alarm "$WORK/err" && fail "alarm after one unhealthy reading"
run
[[ $code -eq 0 && "$(restarts)" == 1 ]] || fail "not restarted after two unhealthy readings"
grep -q '"level":50,.*"alarm":"worker_restarted","unhealthyChecks":2' "$WORK/err" ||
  fail "no worker_restarted alarm line: $(cat "$WORK/err")"
[[ "$(wc -l <"$WORK/err" | tr -d ' ')" == 1 ]] || fail "more than one line on stderr"

# 3. Still unhealthy right after: inside the gap nothing is restarted again, and it says so.
run
run
[[ $code -eq 0 && "$(restarts)" == 1 ]] || fail "restarted again inside the gap"
grep -q '"alarm":"worker_unhealthy"' "$WORK/err" || fail "no worker_unhealthy alarm inside the gap"

# 4. With the gap over, it is restarted again.
WATCHDOG_MIN_RESTART_GAP_SECONDS=0 run
[[ $code -eq 0 && "$(restarts)" == 2 ]] || fail "not restarted once the gap was over"

# 5. A healthy or starting reading between two unhealthy ones resets the count.
for between in healthy starting; do
  reset
  status unhealthy
  run
  status "$between"
  run
  status unhealthy
  run
  [[ "$(restarts)" == 0 ]] || fail "'$between' did not reset the count"
  run
  [[ "$(restarts)" == 1 ]] || fail "no restart after two unhealthy readings following '$between'"
done

# 6. No running container, or one without a health check: nothing done, the count is kept.
reset
status unhealthy
run
: >"$WORK/id"
run
run
[[ $code -eq 0 && "$(restarts)" == 0 ]] || fail "acted without a running container"
echo abc123 >"$WORK/id"
status none
run
[[ $code -eq 0 && "$(restarts)" == 0 ]] || fail "acted on a container without a health check"
status unhealthy
run
[[ "$(restarts)" == 1 ]] || fail "the count was lost while the container was away"

# 7. A restart that fails: the failed alarm, exit 1, and it is tried again on the next run.
reset
status unhealthy
echo 1 >"$WORK/restart-exit"
run
run
[[ $code -eq 1 && "$(restarts)" == 1 ]] || fail "failed restart: exit $code, $(restarts) attempts"
grep -q '"alarm":"worker_restart_failed"' "$WORK/err" || fail "no worker_restart_failed alarm"
echo 0 >"$WORK/restart-exit"
run
[[ $code -eq 0 && "$(restarts)" == 2 ]] || fail "not tried again after a failed restart"
grep -q '"alarm":"worker_restarted"' "$WORK/err" || fail "no alarm for the restart that worked"

# 8. A damaged state file reads as "no unhealthy readings yet".
reset
echo 'not numbers' >"$WORK/state"
status unhealthy
run
[[ $code -eq 0 && "$(restarts)" == 0 ]] || fail "a damaged state file caused a restart"

# 9. Bad settings are refused with exit 2, before anything is read or restarted.
reset
status unhealthy
WATCHDOG_UNHEALTHY_CHECKS=0 run
[[ $code -eq 2 && "$(restarts)" == 0 ]] || fail "threshold 0 accepted"
WATCHDOG_MIN_RESTART_GAP_SECONDS=soon run
[[ $code -eq 2 && "$(restarts)" == 0 ]] || fail "a gap that is not a number accepted"

echo "worker-watchdog.test.sh: ok"
