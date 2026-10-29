#!/usr/bin/env bash
# Smoke test for a running Vamos deployment: health and readiness endpoints, the public catalogue
# API, the player home page (and one of its static assets) and the back-office login page.
# It only reads: no accounts, bets or other state are created. Works against any deployment URL.
#
# Usage:
#   scripts/smoke.sh [options]
#     --api URL        API base URL           (SMOKE_API_URL,    default http://localhost:4000)
#     --web URL        player web app         (SMOKE_WEB_URL,    default http://localhost:3000)
#     --admin URL      back-office web app    (SMOKE_ADMIN_URL,  default http://localhost:3001)
#     --worker URL     worker health server   (SMOKE_WORKER_URL, default: not checked; the worker's
#                      port is not published by the compose file, see docs/deployment.md)
#     --scraper URL    scraper health server  (SMOKE_SCRAPER_URL, default: not checked; the scraper's
#                      port is not published by the compose file, see docs/deployment.md)
#     --wait SECONDS   wait up to this long for the API to answer first (default 60; 0 = no wait)
#     --require-ready  fail (instead of skip) when an endpoint answers 404 for GET /ready
#     --production     also check that development helpers are absent (GET /dev/sms must not answer)
#     -h, --help
# Exit status: 0 when every check passed, 1 otherwise. Needs bash and curl.
set -uo pipefail

API_URL="${SMOKE_API_URL:-http://localhost:4000}"
WEB_URL="${SMOKE_WEB_URL:-http://localhost:3000}"
ADMIN_URL="${SMOKE_ADMIN_URL:-http://localhost:3001}"
WORKER_URL="${SMOKE_WORKER_URL:-}"
SCRAPER_URL="${SMOKE_SCRAPER_URL:-}"
WAIT_S="${SMOKE_WAIT_S:-60}"
REQUIRE_READY=0
PRODUCTION=0

usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --api) API_URL="${2:?--api needs a URL}"; shift 2 ;;
    --web) WEB_URL="${2:?--web needs a URL}"; shift 2 ;;
    --admin) ADMIN_URL="${2:?--admin needs a URL}"; shift 2 ;;
    --worker) WORKER_URL="${2:?--worker needs a URL}"; shift 2 ;;
    --scraper) SCRAPER_URL="${2:?--scraper needs a URL}"; shift 2 ;;
    --wait) WAIT_S="${2:?--wait needs a number}"; shift 2 ;;
    --require-ready) REQUIRE_READY=1; shift ;;
    --production) PRODUCTION=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
API_URL="${API_URL%/}"; WEB_URL="${WEB_URL%/}"; ADMIN_URL="${ADMIN_URL%/}"; WORKER_URL="${WORKER_URL%/}"; SCRAPER_URL="${SCRAPER_URL%/}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0 SKIP=0
ok() { PASS=$((PASS + 1)); printf 'ok    %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'skip  %s\n' "$1"; }

# get URL -> sets CODE (000 when the connection failed), BODY (file) and HEADERS (file).
get() {
  CODE="$(curl -sS -m 15 -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' "$1" 2>"$TMP/err")" || CODE=000
  BODY="$TMP/body"
  HEADERS="$TMP/headers"
}

# check NAME URL EXPECTED_CODE [BODY_REGEX]
check() {
  local name="$1" url="$2" want="$3" pattern="${4:-}"
  get "$url"
  if [[ "$CODE" != "$want" ]]; then
    bad "$name: GET $url answered $CODE, expected $want$([[ $CODE == 000 ]] && printf ' (%s)' "$(head -c 120 "$TMP/err")")"
  elif [[ -n "$pattern" ]] && ! grep -Eq -- "$pattern" "$BODY"; then
    bad "$name: GET $url answered $want but the body does not match /$pattern/"
  else
    ok "$name"
  fi
}

# check_ready NAME BASE_URL: GET /ready is 200 when the service can serve; 404 = not implemented.
check_ready() {
  local name="$1" url="$2/ready"
  get "$url"
  case "$CODE" in
    200) ok "$name" ;;
    404) if ((REQUIRE_READY)); then bad "$name: GET $url answered 404"; else skip "$name: GET /ready not implemented (404)"; fi ;;
    *) bad "$name: GET $url answered $CODE, expected 200 ($(head -c 200 "$BODY" 2>/dev/null | tr '\n' ' '))" ;;
  esac
}

echo "smoke: api=$API_URL web=$WEB_URL admin=$ADMIN_URL worker=${WORKER_URL:-(not checked)} scraper=${SCRAPER_URL:-(not checked)}"

# Wait for the API: a stack that was just started needs a moment.
deadline=$((SECONDS + WAIT_S))
until get "$API_URL/health" && [[ "$CODE" == 200 ]]; do
  if ((SECONDS >= deadline)); then break; fi
  sleep 2
done

# API
check "api /health" "$API_URL/health" 200 '"status" *: *"ok"'
check_ready "api /ready" "$API_URL"
check "api /sports" "$API_URL/sports" 200 '"items"'
check "api /events" "$API_URL/events" 200 '"items"'
check "api unknown route is a JSON 404" "$API_URL/__smoke_not_found" 404 '"not_found"'
check "api staff routes need a session" "$API_URL/admin/dashboard" 401
get "$API_URL/health"
if grep -qi '^x-content-type-options: *nosniff' "$HEADERS"; then ok "api security headers"; else bad "api security headers: x-content-type-options missing"; fi
if ((PRODUCTION)); then
  get "$API_URL/dev/sms?phone=0911000000"
  if [[ "$CODE" == 404 ]]; then ok "api has no development inbox"; else bad "api /dev/sms answered $CODE in production (expected 404)"; fi
fi

# Worker (optional)
if [[ -n "$WORKER_URL" ]]; then
  check "worker /health" "$WORKER_URL/health" 200
  check_ready "worker /ready" "$WORKER_URL"
fi

# Scraper (optional)
if [[ -n "$SCRAPER_URL" ]]; then
  check "scraper /health" "$SCRAPER_URL/health" 200
  check_ready "scraper /ready" "$SCRAPER_URL"
fi

# Player web app: the page, a static asset it references, the PWA manifest
check "web home page" "$WEB_URL/" 200 '<html'
asset="$(grep -Eo '/_next/static/[^"]+\.js' "$BODY" 2>/dev/null | head -n 1 || true)"
if [[ -n "$asset" ]]; then check "web static asset $asset" "$WEB_URL$asset" 200; else bad "web home page references no /_next/static script"; fi
check "web manifest" "$WEB_URL/manifest.webmanifest" 200 '"name"'

# Back office
check "admin login page" "$ADMIN_URL/login" 200 'Back Office'

echo "smoke: $PASS passed, $FAIL failed, $SKIP skipped"
((FAIL == 0))
