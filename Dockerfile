# syntax=docker/dockerfile:1
#
# The API and the built web app in one image, listening on $PORT. Needs
# DATABASE_URL; applies pending migrations on start unless
# SUGABOTS_SKIP_MIGRATIONS=true. Sign-up is closed unless SIGNUP_MODE is
# `referral` or `open`. A new installation admits its first account without an
# invitation.
# REQUIRE_EMAIL_VERIFICATION=true additionally withholds a session until the
# address is proven, and then EMAIL_PROVIDER must name a service that sends mail.
# Build from the repository root:
#
#   docker build -t sugabots .

FROM --platform=$BUILDPLATFORM scratch AS manifests
COPY package.json bun.lock /
COPY --parents packages/*/package.json /

# Bun installs, Node runs, as in CI.
FROM node:26-slim AS base
COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=manifests / ./

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS builder-bun

# --ignore-scripts: the root `prepare` script is editor tooling.
FROM --platform=$BUILDPLATFORM node:26-slim AS web
COPY --from=builder-bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=manifests / ./
RUN bun install --frozen-lockfile --ignore-scripts
# Vite reads the web package's tsconfig, which extends the root one.
COPY tsconfig.json tsconfig.base.json ./
COPY packages packages
RUN bun run --cwd packages/web build

# Only the server's dependency tree. Bun 1.3 keeps the root devDependencies
# under --production, so the toolchain is present regardless.
FROM base AS server
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @sugabots/server

FROM node:26-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=server /app ./
# The web app arrives built, below; the website is served elsewhere.
COPY --exclude=web --exclude=website packages packages
COPY --chmod=755 packages/server/docker-entrypoint.sh packages/server/docker-entrypoint.sh
COPY --from=web /app/packages/web/dist packages/web/dist

USER node
EXPOSE 3000

ENTRYPOINT ["packages/server/docker-entrypoint.sh"]
CMD ["node", "packages/server/src/index.ts"]
