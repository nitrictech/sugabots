# Contributing to Sugabots

## Run from source

This runs PostgreSQL in Docker and the web app and API directly on your
machine. The application is a React web app, an API built on Effect's HttpApi, and PostgreSQL.

### 1. Install the prerequisites

You need:

- [Node.js](https://nodejs.org/) 26 or newer; `.nvmrc` contains the expected version
- [Bun](https://bun.sh/) 1.4.2 or newer
- [Docker](https://docs.docker.com/get-docker/) with Docker Compose

Check that they are available:

```sh
node --version
bun --version
docker compose version
```

### 2. Install dependencies

```sh
nvm use # Optional
bun install
```

### 3. Configure the installation

Create your local environment file:

```sh
cp .env.example .env
```

Open `.env` and replace both development keys before storing any provider
credentials:

```dotenv
BETTER_AUTH_SECRET=<output of openssl rand -base64 32>
SECRETS_ENCRYPTION_KEY=<output of another openssl rand -base64 32>
```

Generate each value separately:

```sh
openssl rand -base64 32
```

The remaining defaults are ready for a localhost installation. Keep `.env`
private and backed up. Losing `SECRETS_ENCRYPTION_KEY` makes saved
credentials unreadable; changing `BETTER_AUTH_SECRET` signs everyone
out.

### 4. Start PostgreSQL

```sh
docker compose up -d
docker compose ps
```

Wait for `postgres` to report `healthy`, then create the database schema:

```sh
bun run db:migrate
```

PostgreSQL stores its data in the `sugabots_postgres_data` Docker volume, so
restarting or recreating the container keeps your data. To start fresh, see
[Reset a database](#reset-a-database).

### 5. Start Sugabots

```sh
bun run dev
```

Keep this terminal open. It runs the API and web app together and reloads them
when source files change. On its first run, Portless creates a local certificate
authority, adds it to your system trust store, and may ask for administrator
access to start its HTTPS proxy.

Open <https://sugabots.localhost>, create an account, and follow the workspace setup
flow. Development email is printed in the terminal, including the verification
link.

The local services are:

| Service          | Address                                     |
| ---------------- | ------------------------------------------- |
| Web app          | <https://sugabots.localhost>                |
| API              | <https://sugabots.localhost/api>            |
| API health check | <https://sugabots.localhost/api/health>     |
| PostgreSQL       | `localhost:5436`                            |

The API answers under `/api` of the address the web app is served from. In
development Vite serves the app and proxies `/api` to the API process; in a
deployment the API serves the built app itself. Either way the browser sees
one origin and nothing about the installation's address is built into the
app. Hosting the web app on an origin of its own is still supported: see
`WEB_APP_URL` and `VITE_API_URL` in `.env.example`.

Portless gives the app stable local names, HTTPS, and HTTP/2. Use these commands
to inspect or troubleshoot it:

```sh
bunx portless list
bunx portless doctor
```

### Run it again

After the first setup:

```sh
docker compose up -d
bun run db:migrate
bun run dev
```

Press `Ctrl-C` to stop the web app and API. Stop PostgreSQL separately with:

```sh
docker compose stop
```

### Update an installation

Stop Sugabots and back up the database, keys and any file volume together
before updating. Keep the encryption key to read saved credentials and the
signing key to keep sessions. Back up work on provider computers separately.

If your version is older than the projects release, stop every copy of
Sugabots before taking the backup. Run the migration once before starting any
copies of the new server. See
[Upgrading to projects](https://sugabots.ai/docs/upgrading-to-projects).

For a local installation, run:

```sh
git pull --ff-only
bun install
docker compose up -d
bun run db:migrate
bun run dev
```

If your `.env` uses `CREDENTIALS_ENCRYPTION_KEY`, rename it to
`SECRETS_ENCRYPTION_KEY` and keep its value so the server can still read saved
secrets. The old name still works during the upgrade.

### Reset a database

Stop Sugabots or the tests before resetting the database they use. Only reset the
database named in the settings for the environment you want to clear.
`DATABASE_URL` names the development database. `TEST_DATABASE_URL` names the
test template database. When it is unset, the template uses the
`DATABASE_URL` database name with `_test` appended. Test workers use their own
numbered copies.

For example, with the local Compose defaults, reset the development database
named `sugabots` and apply the migrations again:

```sh
docker compose exec -T postgres dropdb -U sugabots sugabots
docker compose exec -T postgres createdb -U sugabots sugabots
bun run db:migrate
```

To reset the default test template only, drop `sugabots_test` and let the
next test run recreate it:

```sh
docker compose exec -T postgres dropdb -U sugabots sugabots_test
```

### Build the Docker image

The `Dockerfile` at the repository root builds the image the
[deploy guide](https://sugabots.ai/docs/deploy-with-docker) runs: the API,
serving the built web app at every path outside `/api`.

```sh
docker build -t sugabots .
```

## Commands

Useful project commands:

```sh
bun run check           # lint, typecheck, and test
bun run build           # build all packages
bun run format          # apply Biome formatting fixes
bun run db:studio       # inspect the database with Drizzle Studio
bun run build:computer  # build the computer image, as sugabots-computer:dev
```

`packages/contracts/src/http/http-api.json` records the public HTTP API: each
endpoint's route, statuses, fields and the status of each error. A test fails
while it disagrees with the API. After changing the API on purpose, such as
adding or moving an operation's endpoint, write it again with
`bun run test --project contracts -u` and review its diff.

`bun run db:compare-migrations <revision>` checks that the migrations after
`main`'s newest upgrade a database the same way as the ones at a git revision.
It runs both sets on copies of a database at `main`'s schema, one holding an
installation's rows and one empty, then compares the copies' schemas and rows.
Run it after changing a migration that's already been reviewed, such as when
squashing migrations.

The squashed migration `20261125093952_bots_projects_and_chats` was edited
after it was first applied. A database that already ran it doesn't run it
again, so any development, preview or test database built from an earlier copy
of the branch keeps the old schema. Drop it and make it again. For the local
development database and the test template (`sugabots_test`, or the database
your `TEST_DATABASE_URL` names):

```sh
docker compose exec postgres dropdb -U sugabots --force sugabots
docker compose exec postgres dropdb -U sugabots --force sugabots_test
docker compose exec postgres createdb -U sugabots sugabots
bun run db:migrate
```

The next test run makes and migrates the test template again.

Computers are made from the published image their tag names on its registry,
so a local build under the published name is never used. To try one, set the
OpenSandbox provider's image to `sugabots-computer:dev` in the workspace's
settings. Projects' computers move to it once idle.

The API exports traces and logs to any OTLP/HTTP collector set by the tracing
lines in `.env` (see `.env.example`). For local development,
[motel](https://github.com/kitlangton/motel#readme) is one easy option.

## Project layout

| Directory            | Responsibility                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `packages/errors`    | `DomainError`, user text, and what of a failure may leave the system           |
| `packages/contracts` | Portable API schemas and shared wire types                                     |
| `packages/core`      | Domain services, database schema and migrations, and the durable workflows     |
| `packages/bot-loop`  | The bot loop: the turn workflow and its steps, recording through operations     |
| `packages/server`    | HTTP API, authentication, configuration, and process composition               |
| `packages/workflow`  | The workflow engine (single-runner on Postgres) and activities                 |
| `packages/sdk`       | Typed API, authentication, and reconnecting SSE client                         |
| `packages/web`       | React and Vite web app                                                         |
| `packages/docs`      | The docs pages, which the website publishes and bots read                      |
| `packages/website`   | Landing page and docs, prerendered and served from Cloudflare                  |
| `packages/demo`      | Seed data: the development seed, and the showcase the website is captured from |

When an area's errors are all `DomainError`s, add its path to two lists: the
`biome.json` override that runs the rules in `lint/`, and the Effect language
service override in `tsconfig.base.json`.

## Docs

The docs are part of the website, at `/docs`. Each page is an MDX file in
`packages/docs/content/` with a `title` and `description` in its frontmatter,
and is published once it's listed in `packages/website/src/docs/nav.ts`, which
sets its place and the bot beside it. Bots read the same files through their
`read_docs` tool, a `##` section at a time, so give each section a heading
that says what it covers. Pages can use the components in
`packages/website/src/docs/components/mdx-components.ts` without importing
them. Preview with `bun run --cwd packages/website dev`.

The website sends analytics to PostHog, through Suga's proxy at `p.suga.app`,
only from a production build made with `VITE_POSTHOG_KEY` set to the project
key. Build previews without it so they send nothing. It runs in PostHog's
cookieless mode, so the site sets no cookies and has no consent banner.

## Branches, commits, and PRs

Branch names should be short (2-5 words), hyphen-separated, no slashes, no prefixes (e.g. `auth-token-refresh`, `dark-mode-toggle`).

Commits & PR titles must use `conventional commits` format (i.e. `type(optional scope): description`). Use scope regularly. Use commit message bodies sparingly. Keep PR descriptions short, don't reiterate anything that's clear from reading the code (e.g. `feat(api): add rate-limit headers`, `docs: add setup walkthrough`, `refactor(web): extract form validation`). When a PR is related to an Issue, link it to the issue.

## UI development

Storybook is the catalogue of the app's controls, product components, and
views. Stories live beside the production components in `packages/web/src`.
Keep story-only support beside the stories in `*.test-support.ts` or `*.test-support.tsx` files.

### Run Storybook

Install the test browser once:

```sh
bun run --cwd packages/web playwright install chromium
```

Then, from the repository root:

```sh
bun run storybook        # http://localhost:6006
bun run test:storybook   # browser interaction and accessibility tests
bun run build:storybook
```

The port is fixed so the MCP URL stays valid; startup fails if 6006 is taken.
The browser tests run headlessly in Chromium and need neither the Storybook
server nor the API. They have their own config in `packages/web/vitest.config.ts`;
run the web app's other tests with `bun run test --project web`.

CI runs `test:storybook` and `build:storybook` on every PR. Accessibility
violations fail the checks. There are no screenshot comparisons.

### Write stories

1. Look for an existing control or composition before adding one. Reuse the
   semantic tokens in `packages/web/src/app.css` and the controls in
   `packages/web/src/ui/`.
2. Import `preview` from `#storybook/preview` and use `preview.meta` /
   `meta.story` (CSF Next). Keep each story to one state or use case.
3. Use real components, semantic tokens, and realistic deterministic fixtures.
   Add a short description saying when the pattern is useful.
4. Use `storybook/test` for interaction assertions. Test visible outcomes and
   keyboard behaviour, not implementation details.
5. Check light and dark themes and relevant viewports from the toolbar.
6. Run the story tests and the web type check. Stories tagged `ai-generated`
   need human review; remove the tag once reviewed.

`packages/web/.storybook/preview.tsx` loads the app's real CSS and fonts and
provides tooltips; it does not recreate the theme.

Connected screens register HTTP fixtures with MSW Storybook addon v3's
`beforeEach({ msw })`, and each story gets a fresh query cache. Storybook sets
the API origin to `https://api.storybook.test`, so no backend or credentials are
needed; unhandled requests to that origin are errors.

Only Storybook serves the generated MSW worker. After upgrading MSW, regenerate
it:

```sh
bun run --cwd packages/web msw init .storybook/public --no-save
```

### Connect an AI agent

With `bun run storybook` running, connect your agent to
<http://localhost:6006/mcp> over Streamable HTTP and name the server `storybook`
(see [Storybook's MCP instructions](https://storybook.js.org/docs/ai/mcp/overview#3-add-the-mcp-server-to-your-agent)).

| Tool                               | Use                                          |
| ---------------------------------- | -------------------------------------------- |
| `docs-list`                        | Find documented components and story IDs     |
| `docs-show`, `docs-show-story`     | Show supported usage and examples            |
| `get-storybook-story-instructions` | Get story authoring guidance                 |
| `test-run`                         | Run interaction and accessibility checks     |
| `stories-preview`                  | Get preview links for review                 |

The component manifest is at <http://localhost:6006/manifests/components.html>.
Props are extracted with `react-docgen`, because TypeScript 7 lacks the compiler
API `react-docgen-typescript` needs. Where it can't resolve inherited or complex
props, read the source types and add explicit story controls.

Import components from their source modules, such as `@/ui/button.tsx`. The
manifest may suggest `@sugabots/web` imports, but the app package has no
component barrel.

### Storybook versions

Storybook packages are pinned to `11.0.0-alpha.6` because stable 10.6's Vitest
addon supports only Vitest 3 and 4, and this repo uses Vitest 5. Upgrade all
Storybook packages together.
