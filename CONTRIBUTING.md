# Contributing to Sugabots

## Run from source

This runs PostgreSQL in Docker and the web app and API directly on your
machine. The application is a React web app, a Hono API, and PostgreSQL.

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
CREDENTIALS_ENCRYPTION_KEY=<output of another openssl rand -base64 32>
```

Generate each value separately:

```sh
openssl rand -base64 32
```

The remaining defaults are ready for a localhost installation. Keep `.env`
private and backed up. Losing `CREDENTIALS_ENCRYPTION_KEY` makes saved
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
restarting or recreating the container does not remove your data. If you want to
reset your data, just delete the volume.

### 5. Start Sugabots

```sh
bun run dev
```

Keep this terminal open. It runs the API and web app together and reloads them
when source files change. On its first run, Portless creates a local certificate
authority, adds it to your system trust store, and may ask for administrator
access to start its HTTPS proxy.

Open <https://sugabots.localhost>, create an account, and follow the onboarding
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

Stop `bun run dev`, then run:

```sh
git pull --ff-only
bun install
docker compose up -d
bun run db:migrate
bun run dev
```

Back up your PostgreSQL volume and `.env` before updating an installation that
contains data you care about.

### Reset everything

The following removes the database volume and all Sugabots data:

```sh
docker compose down -v
docker compose up -d
bun run db:migrate
```

Do not run `docker compose down -v` unless you intend to delete every account,
workspace, conversation, and saved credential.

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
bun run build:sandbox   # build the sandbox image, ghcr.io/nitrictech/sugabots-sandbox:latest
```

The API exports traces and logs to any OTLP/HTTP collector set by the tracing
lines in `.env` (see `.env.example`). For local development,
[motel](https://github.com/kitlangton/motel#readme) is one easy option.

## Project layout

| Directory            | Responsibility                                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `packages/errors`    | `DomainError`, user text, and what of a failure may leave the system           |
| `packages/contracts` | Portable API schemas and shared wire types                                     |
| `packages/core`      | Domain services, database schema and migrations, and the durable workflows     |
| `packages/server`    | HTTP API, authentication, configuration, and process composition               |
| `packages/workflow`  | The workflow engines (in memory, and single-runner on Postgres) and activities |
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

Storybook packages are pinned to `11.0.0-alpha.1` because stable 10.6's Vitest
addon supports only Vitest 3 and 4, and this repo uses Vitest 5. Upgrade all
Storybook packages together.
