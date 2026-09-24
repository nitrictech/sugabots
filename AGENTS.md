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

- Declare a `…Service` class with `Context.Service`, its interface written inline, at the top of the file; supporting types and errors go below it.
- Every service has a static `layer`: ready to use, reading its own settings through Effect's `Config` and providing its standard dependencies, so the entry point composes layers without passing config or wiring dependencies. Layers are memoized by reference, so keep `layer` a constant, not a function.
- When tests need to swap a dependency, also expose `layerNoDeps` (the same layer with dependencies left open) and define `layer` as `layerNoDeps.pipe(Layer.provide(...))`.
- With several implementations, also expose each as `from<Backend>` (`EmailService.fromWebhook(config)`, `EmailService.fromConsole`) and put each in `implementations/`, returning `XService["Service"]` for the class to wrap in `Layer.succeed`/`Layer.effect`. A single implementation stays in the service file.
- Tests supply doubles with `Effect.provideService`, not as statics.
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
