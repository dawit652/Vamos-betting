#!/usr/bin/env bash
# Creates infra/.env.prod from infra/env.prod.example with fresh random secrets in place of every
# CHANGE_ME. Refuses to overwrite an existing file. Review the result before use: the public URLs,
# providers and the licensed-mode settings are yours to set (docs/deployment.md).
#
# Usage: infra/scripts/init-env.sh [path]        (default: infra/.env.prod)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-$ROOT/infra/.env.prod}"
[[ -e "$TARGET" ]] && { echo "$TARGET exists; not overwriting" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 2; }

umask 077
cp "$ROOT/infra/env.prod.example" "$TARGET"
# Hex only: the passwords are embedded in connection URLs.
for entry in POSTGRES_PASSWORD:16 APP_DB_PASSWORD:16 REDIS_PASSWORD:16 SESSION_SECRET:32 ADMIN_TOTP_KEY:32 \
  PASSWORD_PEPPER:32 MOCK_PAYMENT_WEBHOOK_SECRET:24 SMS_WEBHOOK_SECRET:24 USSD_SHARED_SECRET:24; do
  name="${entry%%:*}" bytes="${entry##*:}"
  sed -i "s|^${name}=CHANGE_ME\$|${name}=$(openssl rand -hex "$bytes")|" "$TARGET"
done
if grep -q "=CHANGE_ME" "$TARGET"; then echo "warning: =CHANGE_ME values remain in $TARGET" >&2; fi
echo "wrote $TARGET (mode 600). ADMIN_TOTP_KEY, SESSION_SECRET and PASSWORD_PEPPER: store them in your secret manager."
