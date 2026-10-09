## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the source for project commands, layout, and conventions. Read its:

- "Commands" section before running checks, builds, or database tools.
- "Branches, commits, and PRs" section before creating a branch, committing, or opening a PR.
- "UI development" section before changing components, views, or stories.

## Style and Practices

Write only what the current task needs. Keep behavior, preconditions, and side effects clear without tracing distant definitions.

### Readability

- Name the actual operation: `trimWhitespace`, not `sanitizeInput`. Spell out words; include units where types don't express them.
- Handle errors and edge cases with early returns. Keep the happy path flat; avoid excessively nested code.
- Extract functions for meaningful operations, repeated logic, or distinct complex phases—not line counts or test access. Their names should make opening the implementation optional.
- Replace magic values and “what” comments with named constants, expressions, or types. Comments explain non-obvious reasons; API docs state requirements and guarantees. Both must make sense without PR or chat context.

### Contracts and Dependencies

- Parse untrusted input into validated types at boundaries. Use distinct types for IDs, money, and units where mixing values causes bugs; represent valid field combinations with unions.
- Enforce required steps through one operation or types proving earlier steps completed. Don't rely on callers remembering validation or call order.
- Share logic that should change together, not code that merely looks alike. Avoid forwarding wrappers and speculative interfaces; prefer composition over inheritance.
- Construct infrastructure where configuration and resource lifetime are owned, then supply ready-to-use dependencies through the project's existing mechanism.
- Pass state explicitly instead of using distant mutable flags. Prefer clear transformation pipelines; separate domain calculations from database, network, and filesystem operations.

### Effect services

Follow `packages/core/src/email/email.ts`:

- The module is the service's namespace: it starts with `export * as Email from "./email.ts"`, and callers import `{ Email }` and write `Email.Service`, `Email.layer`, `Email.Message`. Name exports for their role inside the namespace (`Message`, `Address`, `DeliveryFailed`), not with the namespace's name again.
- Export, in this order at the top: `Interface`; `Service`, a `Context.Service<Service, Interface>` class; `make`, the effect that builds an `Interface`, reading settings through Effect's `Config`; `layerNoDeps = Layer.effect(Service, make)`; and `layer = layerNoDeps.pipe(Layer.provide(...))` with its standard dependencies, so the entry point composes layers without passing config or wiring dependencies. Layers are memoized by reference, so keep `layer` a constant, not a function. Supporting types, errors, and helpers go below.
- A domain service's `layer` provides the domain services it is built from, never the infrastructure every service shares: the database, `BlobStore`, `Ids`, `Credentials`, `Installation`, `Egress`, `Email` and `Accounts`. `packages/server/src/index.ts` provides those once, and tests provide `testInfrastructure` from `database/testing.ts` the same way.
- A repository's `layer` is `Layer.effect(Service, make)` alone, unless its commands also end another aggregate's work: `TurnRepository.layer` provides `ToolCallRepository.layer`, because ending a turn ends its tool calls.
- The conversation services leave two things to the edge: how workflows are started and signalled (`TurnRequests`, `TurnSignals`, `RoutineRuns`), which needs the workflow engine, and the event outbox their events are written to (`EventOutbox`). `Conversations.layer` is the composed unit: it provides `ConversationEvents`, because routine settlement, one of its handlers, is built from the repositories that emit. Entry points and tests build `Conversations.layer` over those workflow services and the event outbox.
- With several implementations, `make` picks one from an explicit setting with a default (`EMAIL_PROVIDER`, defaulting to `console`), reading only the chosen one's settings. Put each implementation in `implementations/`, typed as the namespace's `Interface`. A single implementation stays in the service file.
- Tests supply doubles as layers: `Layer.succeed(Email.Service, ...)`, or `unimplemented(Email.Service, { ... })` from `packages/core/src/testing.ts` for a double that dies on any method it does not define.
- Implementation files are imported by the service file, so they use its values only inside functions, never at module top level, to keep the import cycle safe.

### Testing

- Test observable behavior against requirements or reproduced defects, not private helpers or the implementation's algorithm.
- Use the smallest test boundary that exercises the real risk; include real integrations when wiring or persistence matters.
- Prefer fast, deterministic real dependencies. Use doubles at existing external boundaries when necessary; don't add production abstractions solely for mocking.
- Prefer types, static checks, or stronger coverage over adding new tests. Tests should survive behavior-preserving refactors.

## UI development

- Start `bun run storybook` and use the `storybook` MCP's `docs-list` and `docs-show` to find existing components and verify their APIs. If the MCP is unavailable, inspect colocated stories and component types directly.
- Use `get-storybook-story-instructions` before editing stories. Keep stories beside production components and cover meaningful states with deterministic fixtures.
- Reuse the semantic tokens in `packages/web/src/app.css` and the controls in `packages/web/src/ui/`.
- Verify changes with MCP `test-run` (or `bun run test:storybook` when MCP is unavailable), inspect relevant light/dark and narrow-viewport stories, and include preview links in the handoff.
