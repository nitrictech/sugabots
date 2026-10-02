# syntax=docker/dockerfile:1.7
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

# Bun installs, Node runs, as in CI.
FROM node:26-slim AS base
COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/accounting/package.json packages/accounting/
COPY packages/avatars/package.json packages/avatars/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/docs/package.json packages/docs/
COPY packages/provider-logos/package.json packages/provider-logos/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/website/package.json packages/website/
COPY packages/workflow/package.json packages/workflow/

# --ignore-scripts: the root `prepare` script is editor tooling.
FROM base AS web
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
COPY packages/accounting packages/accounting
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/docs packages/docs
COPY packages/server packages/server
COPY packages/workflow packages/workflow
COPY --chmod=755 packages/server/docker-entrypoint.sh packages/server/docker-entrypoint.sh
COPY --from=web /app/packages/web/dist packages/web/dist

USER node
EXPOSE 3000

ENTRYPOINT ["packages/server/docker-entrypoint.sh"]
CMD ["node", "packages/server/src/index.ts"]
