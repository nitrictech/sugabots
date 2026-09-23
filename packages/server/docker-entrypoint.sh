#!/bin/sh
# Applies pending database migrations, then runs the given command.
# SUGABOTS_SKIP_MIGRATIONS=true skips the migrations.
set -eu

case "${SUGABOTS_SKIP_MIGRATIONS:-false}" in
	false) node packages/core/src/database/migrate.ts ;;
	true) echo "SUGABOTS_SKIP_MIGRATIONS=true: leaving the database schema as it is" ;;
	*)
		echo "SUGABOTS_SKIP_MIGRATIONS must be true or false" >&2
		exit 1
		;;
esac

exec "$@"
