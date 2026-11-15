#!/usr/bin/env bash
# Writes a throwaway production env file that runs the compose stack in LICENSED mode on
# http://localhost URLs: for CI (.github/workflows/ci.yml) and local smoke tests. Not for a real
# deployment: every secret is random and discarded, the collection accounts are made up.
#
# It starts from infra/scripts/init-env.sh (random secrets in place of CHANGE_ME) and sets what a
# stack needs to boot with real-money settings and no external credentials:
#   - PAYMENT_PROVIDERS=sms (the SMS deposit rail, live, collection accounts in the operator's name):
#     the chapa and telebirr providers need credentials we do not have in CI.
#   - SMS_PROVIDER=mock and KYC_PROVIDER=mock: the only adapters that exist (SMS_PROVIDER=http makes the
#     api and worker refuse to start). Licensed mode allows them (it refuses only the mock PAYMENT
#     provider), but with them players' codes and ID checks are not real.
#
# Usage: infra/scripts/init-env-ci.sh [path]        (default: infra/.env.prod)
set -euo pipefail

cd "$(dirname "$0")/../.."
out="${1:-infra/.env.prod}"

bash infra/scripts/init-env.sh "$out"

# Replaces `NAME=...` (or appends it); the value is passed through the environment so that quotes,
# brackets and slashes need no escaping.
set_var() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  VALUE="$value" awk -v name="$name" '
    BEGIN { FS = OFS = "="; found = 0 }
    $1 == name { print name "=" ENVIRON["VALUE"]; found = 1; next }
    { print }
    END { if (!found) print name "=" ENVIRON["VALUE"] }
  ' "$out" >"$tmp"
  cat "$tmp" >"$out"
  rm -f "$tmp"
}

set_var OPERATING_MODE licensed
set_var NEXT_PUBLIC_OPERATING_MODE licensed
set_var PAYMENT_PROVIDERS sms
set_var SMS_RAIL_MODE live
set_var PAYOUT_REQUIRE_PROOF true
set_var OPERATOR_LEGAL_NAME 'CI Test Company'
set_var SMS_COLLECTION_ACCOUNTS '[{"institution":"telebirr","account":"0911000000","name":"CI Test Company"},{"institution":"cbe","account":"1000000000001","name":"CI Test Company"}]'
set_var SMS_PROVIDER mock
set_var REGISTRATION_SMS_VERIFICATION off
set_var KYC_PROVIDER mock
set_var FEED_PROVIDER manual
set_var TAX_CONFIG_CONFIRMED true

echo "licensed-mode CI env written to $out" >&2
