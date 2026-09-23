# Contributing to Sugabots

Start with a local installation: follow [Set up Sugabots](README.md#set-up-sugabots)
in the README.

## Commands

Useful project commands:

```sh
bun run check           # lint, typecheck, and test
bun run build           # build all packages
bun run format          # apply Biome formatting fixes
bun run db:studio       # inspect the database with Drizzle Studio
bun run explore:traces  # browse the API's traces in motel
```

`bun run dev` also starts [motel](https://github.com/kitlangton/motel) in the
background, which collects the API's traces and logs into `.motel/` in this
checkout; `explore:traces` browses them. Its settings, and the API's, are the
tracing lines in `.env` (see `.env.example`); any OTLP/HTTP viewer works instead.

## Project layout

| Directory            | Responsibility                                                      |
| -------------------- | ------------------------------------------------------------------- |
| `packages/contracts` | Portable API schemas and shared wire types                          |
| `packages/core`      | Domain modules, database schema and migrations, stores, and workers |
| `packages/server`    | Hono API, authentication, configuration, and process composition    |
| `packages/sdk`       | Typed API, authentication, and reconnecting SSE client              |
| `packages/web`       | React and Vite web app                                              |

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
