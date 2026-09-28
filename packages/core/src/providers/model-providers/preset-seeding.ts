import { asc, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { query, transaction } from "../../database/database.ts";
import { workspace } from "../../database/schema.ts";
import { ModelProviderRepository } from "./model-provider-repository.ts";

/**
 * Seeds the preset providers into every workspace and refreshes their starter
 * models from the catalog, so a workspace made before a preset existed, or
 * before the catalog changed, catches up.
 *
 * Every process runs it at start-up; a transaction-scoped advisory lock lets
 * one do the work while the others skip it, since theirs would be the same.
 */
export const seedEveryWorkspace = Effect.gen(function* () {
	const modelProviders = yield* ModelProviderRepository.Service;
	yield* transaction(
		Effect.gen(function* () {
			const [lock] = yield* query((db) =>
				db.execute<{ taken: boolean }>(
					sql`select pg_try_advisory_xact_lock(hashtextextended('model-providers:seed-presets', 0)) as taken`,
					"objects",
				),
			);
			if (!lock?.taken) return;
			const workspaces = yield* query((db) =>
				db.select({ id: workspace.id }).from(workspace).orderBy(asc(workspace.id)),
			);
			yield* Effect.forEach(workspaces, ({ id }) => modelProviders.seedPresets(id), {
				discard: true,
			});
		}),
	);
}).pipe(Effect.withSpan("ModelProviders.seedEveryWorkspace"));

/**
 * Runs {@link seedEveryWorkspace} once, in the background, so starting does
 * not wait on every workspace. A failure is logged rather than stopping the
 * process: every workspace keeps the presets it has, and the next start tries
 * again.
 */
export const seedEveryWorkspaceLayer = Layer.effectDiscard(
	Effect.forkScoped(
		seedEveryWorkspace.pipe(
			Effect.catchCause((cause) => Effect.logError("Seeding model provider presets failed", cause)),
		),
	),
).pipe(Layer.provide(ModelProviderRepository.layer));
