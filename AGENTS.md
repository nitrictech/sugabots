## Branches, Commits and PRs

Branch names should be short (2-5 words), hyphen-separated, no slashes, no prefixes (e.g. `auth-token-refresh`, `dark-mode-toggle`).

Commits & PR titles must use `conventional commits` format (i.e. `type(optional scope): description`). Use scope regularly. Use commit message bodies sparingly. Keep PR descriptions short, don't reiterate anything that's clear from reading the code (e.g. `feat(api): add rate-limit headers`, `docs: add setup walkthrough`, `refactor(web): extract form validation`). When a PR is related to an Issue, link it to the issue.

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

### Testing

- Test observable behavior against requirements or reproduced defects, not private helpers or the implementation's algorithm.
- Use the smallest test boundary that exercises the real risk; include real integrations when wiring or persistence matters.
- Prefer fast, deterministic real dependencies. Use doubles at existing external boundaries when necessary; don't add production abstractions solely for mocking.
- Prefer types, static checks, or stronger coverage over adding new tests. Tests should survive behavior-preserving refactors.

## UI development

- Read `docs/ui-development.md` when changing components, views, or stories.
- Start `bun run storybook` and use the `storybook` MCP's `docs-list` and `docs-show` to find existing components and verify their APIs. If the MCP is unavailable, inspect colocated stories and component types directly.
- Use `get-storybook-story-instructions` before editing stories. Keep stories beside production components and cover meaningful states with deterministic fixtures.
- Reuse the semantic tokens in `packages/web/src/app.css` and the controls in `packages/web/src/ui/`.
- Verify changes with MCP `test-run` (or `bun run test:storybook` when MCP is unavailable), inspect relevant light/dark and narrow-viewport stories, and include preview links in the handoff.
