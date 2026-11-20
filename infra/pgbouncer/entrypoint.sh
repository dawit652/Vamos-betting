#!/bin/sh
# Writes PgBouncer's configuration from the environment and runs it in the foreground.
# Transaction pooling: a server connection is held only for the length of one transaction, so a
# few dozen of them serve thousands of API connections. The API uses only transaction-level
# advisory locks and no LISTEN or session state (checked, and its whole test suite passes through
# transaction pooling), which is what makes this mode safe for it.
#
# Environment (all but the optional ones are required):
#   PGB_DATABASE        database name, the same on both sides
#   PGB_USER            the application role (vamos_app)
#   PGB_PASSWORD        its password (APP_DB_PASSWORD)
#   PGB_HOST            Postgres host (default postgres), PGB_PORT (default 5432)
#   PGB_POOL_SIZE       server connections per database and user (default 40)
#   PGB_MAX_CLIENT_CONN client connections accepted (default 3000)
#   PGB_DIR             where the generated files go (default /tmp, a tmpfs in compose)
set -eu

: "${PGB_DATABASE:?set PGB_DATABASE}"
: "${PGB_USER:?set PGB_USER}"
: "${PGB_PASSWORD:?set PGB_PASSWORD}"
dir="${PGB_DIR:-/tmp}"
host="${PGB_HOST:-postgres}"
port="${PGB_PORT:-5432}"

# userlist.txt: "user" "password", a double quote inside a value is written twice.
quote() { printf '%s' "$1" | sed 's/"/""/g'; }
umask 077
printf '"%s" "%s"\n' "$(quote "$PGB_USER")" "$(quote "$PGB_PASSWORD")" > "$dir/userlist.txt"

cat > "$dir/pgbouncer.ini" <<INI
[databases]
${PGB_DATABASE} = host=${host} port=${port} dbname=${PGB_DATABASE}

[pgbouncer]
listen_addr = ${PGB_LISTEN_ADDR:-0.0.0.0}
listen_port = ${PGB_LISTEN_PORT:-6432}
unix_socket_dir =
auth_type = scram-sha-256
auth_file = ${dir}/userlist.txt
pool_mode = transaction
default_pool_size = ${PGB_POOL_SIZE:-40}
max_client_conn = ${PGB_MAX_CLIENT_CONN:-3000}
server_idle_timeout = 60
server_reset_query =
ignore_startup_parameters = extra_float_digits,options
log_connections = 0
log_disconnections = 0
INI

exec pgbouncer "$dir/pgbouncer.ini"
