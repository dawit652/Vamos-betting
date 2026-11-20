# PgBouncer for the optional scale-out overlay (infra/docker-compose.scale.yml): transaction
# pooling between several API processes and Postgres. Built from Alpine's own package, so there is
# no third-party image to trust. Runs as the unprivileged `pgbouncer` user the package creates.
FROM alpine:3.20
RUN apk add --no-cache pgbouncer
COPY infra/pgbouncer/entrypoint.sh /entrypoint.sh
USER pgbouncer
EXPOSE 6432
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD nc -z 127.0.0.1 6432 || exit 1
ENTRYPOINT ["/entrypoint.sh"]
