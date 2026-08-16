#!/usr/bin/env bash
#
# Local test-database lifecycle, Docker-free.
#
# compose.yaml has a `postgres-test` service for CI and for anyone who does run
# Docker. This script is the equivalent for a Homebrew Postgres box: it puts a
# *second cluster* on :5433 rather than a second database inside the dev server
# on :5432, so the suite's TRUNCATEs are physically unable to reach dev data.
#
# The data directory is disposable — `reset` throws it away and rebuilds. Never
# point this at a cluster that holds anything you want to keep.
#
#   bun run db:up:test      start (creating the cluster on first run)
#   bun run db:down:test    stop
#   bun run db:reset:test   delete the cluster and rebuild it empty
#
set -euo pipefail

PORT=5433
DB_USER=helpdesk
DB_PASS=helpdesk
DB_NAME=helpdesk_test

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGDATA="$REPO_ROOT/.pgdata-test"
LOGFILE="$PGDATA/postgres.log"

require_postgres() {
  if ! command -v pg_ctl >/dev/null 2>&1; then
    echo "pg_ctl not found. Install Postgres (brew install postgresql@17) or use" >&2
    echo "the Docker path instead: docker compose --profile test up -d postgres-test" >&2
    exit 1
  fi
}

is_running() {
  pg_ctl --pgdata="$PGDATA" status >/dev/null 2>&1
}

init_cluster() {
  echo "==> initdb $PGDATA"
  # --auth=trust: this cluster listens on loopback only and holds nothing but
  # disposable test data, so a password prompt would buy nothing. The role
  # password below exists purely because DATABASE_URL carries one.
  local pwfile
  pwfile="$(mktemp)"
  printf '%s' "$DB_PASS" >"$pwfile"
  initdb --pgdata="$PGDATA" --username="$DB_USER" --auth=trust \
    --pwfile="$pwfile" --encoding=UTF8 --locale=C >/dev/null
  rm -f "$pwfile"

  # Durability is worthless for a cluster that gets thrown away; spend it on
  # speed. Mirrors the `command:` overrides on the compose service.
  cat >>"$PGDATA/postgresql.conf" <<-CONF

	# --- helpdesk e2e overrides ---
	port = $PORT
	listen_addresses = 'localhost'
	fsync = off
	synchronous_commit = off
	full_page_writes = off
CONF
}

start_cluster() {
  if is_running; then
    echo "==> already running on :$PORT"
    return
  fi
  echo "==> starting on :$PORT"
  pg_ctl --pgdata="$PGDATA" --log="$LOGFILE" --wait start >/dev/null
}

create_database() {
  if psql --host=localhost --port="$PORT" --username="$DB_USER" --dbname=postgres \
    --tuples-only --no-align --command \
    "select 1 from pg_database where datname = '$DB_NAME'" 2>/dev/null | grep -q 1; then
    return
  fi
  echo "==> creating database $DB_NAME"
  createdb --host=localhost --port="$PORT" --username="$DB_USER" "$DB_NAME"
}

cmd_up() {
  require_postgres
  [ -f "$PGDATA/PG_VERSION" ] || init_cluster
  start_cluster
  create_database
  echo "==> ready: postgres://$DB_USER:$DB_PASS@localhost:$PORT/$DB_NAME"
}

cmd_down() {
  require_postgres
  if is_running; then
    echo "==> stopping"
    pg_ctl --pgdata="$PGDATA" --wait --mode=fast stop >/dev/null
  else
    echo "==> not running"
  fi
}

cmd_reset() {
  require_postgres
  is_running && pg_ctl --pgdata="$PGDATA" --wait --mode=immediate stop >/dev/null
  echo "==> removing $PGDATA"
  rm -rf "$PGDATA"
  cmd_up
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  *)
    echo "usage: test-db.sh [up|down|reset]" >&2
    exit 1
    ;;
esac
