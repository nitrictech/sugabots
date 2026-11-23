export * as BuiltInProviderSeeding from "./built-in-provider-seeding.ts";

import { asc, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { query, transaction } from "../../database/database.ts";
import { workspace } from "../../database/schema.ts";
import { ModelProviderStore } from "./model-provider-store.ts";

/**
 * Seeds the built-in providers into every workspace and refreshes their starter
 * models from the list Sugabots ships, so a workspace made before a built-in
 * provider existed, or before the list changed, catches up.
 *
 * Every process runs it at start-up; a transaction-scoped advisory lock lets
 * one do the work while the others skip it, since theirs would be the same.
 */
export const seedEveryWorkspace = Effect.gen(function* () {
	const modelProviders = yield* ModelProviderStore.Service;
	yield* transaction(
		Effect.gen(function* () {
			const [lock] = yield* query((db) =>
				db.execute<{ taken: boolean }>(
					sql`select pg_try_advisory_xact_lock(hashtextextended('model-providers:seed-built-in-providers', 0)) as taken`,
					"objects",
				),
			);
			if (!lock?.taken) return;
			const workspaces = yield* query((db) =>
				db.select({ id: workspace.id }).from(workspace).orderBy(asc(workspace.id)),
			);
			yield* Effect.forEach(workspaces, ({ id }) => modelProviders.seedBuiltInProviders(id), {
				discard: true,
			});
		}),
	);
}).pipe(Effect.withSpan("ModelProviders.seedEveryWorkspace"));

/**
 * Runs {@link seedEveryWorkspace} once, in the background, so starting does
 * not wait on every workspace. A failure is logged rather than stopping the
 * process: every workspace keeps the built-in providers it has, and the next start tries
 * again.
 */
export const layer = Layer.effectDiscard(
	Effect.forkScoped(
		seedEveryWorkspace.pipe(
			Effect.catchCause((cause) =>
				Effect.logError("Seeding built-in model providers failed", cause),
			),
		),
	),
).pipe(Layer.provide(ModelProviderStore.layer));
