#!/usr/bin/env bash
# Sets the licensed-mode (real money) settings in an existing production env file, keeping every other
# value (secrets, URLs, feed settings). For a deployment that has no SMS gateway: SMS and KYC use the
# mock adapters (the only ones that exist) and registration runs without an SMS code.
#
#   infra/scripts/go-licensed.sh infra/.env.prod "<legal name>" <telebirr number> "<telebirr holder>" \
#       <cbe account> "<cbe holder>"
#
# Sets: OPERATING_MODE=licensed, PAYMENT_PROVIDERS=sms (the live SMS deposit rail), SMS_RAIL_MODE=live,
# PAYOUT_REQUIRE_PROOF=true, OPERATOR_LEGAL_NAME, SMS_COLLECTION_ACCOUNTS, SMS_PROVIDER=mock,
# KYC_PROVIDER=mock, REGISTRATION_SMS_VERIFICATION=off. It creates SMS_GATEWAY_SECRET when the file has none
# (never printed). It does NOT touch TAX_CONFIG_CONFIRMED (only counsel's confirmation sets that) or the feed.
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: $0 <env-file> <legal name> <telebirr number> <telebirr holder> <cbe account> <cbe holder>" >&2
  exit 2
fi
out="$1" legal="$2" tb_number="$3" tb_holder="$4" cbe_number="$5" cbe_holder="$6"
[[ -f "$out" ]] || { echo "no such file: $out" >&2; exit 1; }

for v in "$legal" "$tb_holder" "$cbe_holder"; do
  if [[ "$v" == *\"* || "$v" == *\\* ]]; then
    echo "names must not contain quotes or backslashes: $v" >&2
    exit 2
  fi
done
for v in "$tb_number" "$cbe_number"; do
  [[ "$v" =~ ^[0-9]{6,20}$ ]] || { echo "account numbers are digits only: $v" >&2; exit 2; }
done

# Replaces `NAME=...` (or appends it); the value goes through the environment so quotes, brackets and
# slashes need no escaping.
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

has_value() { grep -Eq "^$1=.+" "$out"; }

cp "$out" "$out.before-licensed"
chmod 600 "$out.before-licensed"

set_var OPERATING_MODE licensed
set_var NEXT_PUBLIC_OPERATING_MODE licensed
set_var PAYMENT_PROVIDERS sms
set_var SMS_RAIL_MODE live
set_var PAYOUT_REQUIRE_PROOF true
set_var OPERATOR_LEGAL_NAME "$legal"
set_var SMS_COLLECTION_ACCOUNTS "[{\"institution\":\"telebirr\",\"account\":\"$tb_number\",\"name\":\"$tb_holder\"},{\"institution\":\"cbe\",\"account\":\"$cbe_number\",\"name\":\"$cbe_holder\"}]"
set_var SMS_PROVIDER mock
set_var KYC_PROVIDER mock
set_var REGISTRATION_SMS_VERIFICATION off
if ! has_value SMS_GATEWAY_SECRET; then
  set_var SMS_GATEWAY_SECRET "$(openssl rand -hex 32)"
  echo "created SMS_GATEWAY_SECRET (put the same value in the SMS forwarder app; it is in $out)" >&2
fi

echo "licensed settings written to $out (previous file kept as $out.before-licensed)" >&2
echo "now: $(grep -E '^(OPERATING_MODE|PAYMENT_PROVIDERS|SMS_RAIL_MODE|SMS_PROVIDER|KYC_PROVIDER|REGISTRATION_SMS_VERIFICATION|FEED_PROVIDER|TAX_CONFIG_CONFIRMED|OPERATOR_LEGAL_NAME)=' "$out" | tr '\n' ' ')" >&2
