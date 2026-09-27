#!/bin/sh
# Installs and starts Sugabots with Docker, in a `sugabots` folder in the
# current directory:
#
#   curl -fsSL https://sugabots.ai/install.sh | sh
#
# Safe to run again: an existing compose.yml and .env are kept, so the keys that
# sign people in and encrypt saved API keys never change under an installation.
set -eu

COMPOSE_URL="https://sugabots.ai/compose.yml"
INSTALL_DIR="sugabots"
APP_URL="http://localhost:3000"
HEALTH_URL="$APP_URL/api/health"
# How long to wait for the first start, which downloads images and migrates the database.
STARTUP_TIMEOUT_SECONDS=120

fail() {
	echo "sugabots: $1" >&2
	exit 1
}

# 32 random bytes, base64-encoded, as `openssl rand -base64 32` prints them.
random_key() {
	head -c 32 /dev/urandom | base64 | tr -d '\n'
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v docker >/dev/null 2>&1 ||
	fail "Docker is required. Install it from https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 ||
	fail "Docker Compose is required. It comes with Docker Desktop, or see https://docs.docker.com/compose/install/"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ -f compose.yml ]; then
	echo "Keeping the existing $INSTALL_DIR/compose.yml"
else
	curl -fsSL "$COMPOSE_URL" -o compose.yml
fi

if [ -f .env ]; then
	echo "Keeping the existing keys in $INSTALL_DIR/.env"
else
	(
		umask 077
		printf 'BETTER_AUTH_SECRET=%s\nCREDENTIALS_ENCRYPTION_KEY=%s\n' "$(random_key)" "$(random_key)" >.env
	)
	echo "Wrote new keys to $INSTALL_DIR/.env. Back it up and keep it private."
fi

docker compose up -d

printf 'Waiting for Sugabots to start'
waited=0
until curl -fs "$HEALTH_URL" >/dev/null 2>&1; do
	if [ "$waited" -ge "$STARTUP_TIMEOUT_SECONDS" ]; then
		echo
		fail "Sugabots didn't start in time. See what it printed with: cd $INSTALL_DIR && docker compose logs sugabots"
	fi
	printf '.'
	sleep 2
	waited=$((waited + 2))
done
echo

echo "Sugabots is running at $APP_URL"
echo "Open it and create your account. Emails, such as your verification link, are in: cd $INSTALL_DIR && docker compose logs sugabots"
