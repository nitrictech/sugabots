import { ModelInUse } from "@sugabots/contracts/errors/providers";
import { DisplayName } from "@sugabots/errors";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { query, transaction } from "../../database/database.ts";
import { bot, providerModel, workspace } from "../../database/schema.ts";
import { offeredModels } from "./model-provider-reads.ts";
import { defaultModelOf, ModelNotEnabled } from "./model-provider-store.ts";

/**
 * A workspace's models are held by its default, which new bots start on, and
 * by its system bots, since a system bot always runs. A held model stays
 * offered: every change that could stop offering one runs through
 * {@link keepingHeldModelsOffered}, and every change that makes one held runs
 * through {@link holdingModel} or {@link withHeldModelsLocked}. All three take
 * the same lock, so neither can slip between the other's check and its write.
 */

/** What holds one model: the workspace default, and the system bots by name. */
interface Holders {
	readonly workspaceDefault: boolean;
	readonly systemBots: readonly DisplayName[];
}

/**
 * Runs `hold`, which makes `modelId` held, in a transaction that first checks
 * the workspace offers it, so it cannot stop being offered before `hold`
 * commits.
 */
export const holdingModel = <A, E, R>(
	workspaceId: string,
	modelId: string,
	hold: Effect.Effect<A, E, R>,
) =>
	withHeldModelsLocked(
		workspaceId,
		Effect.gen(function* () {
			const { models } = yield* offeredModels(workspaceId);
			if (!models.some((offered) => offered.modelId === modelId)) {
				return yield* new ModelNotEnabled({ model: modelId });
			}
			return yield* hold;
		}),
	);

/**
 * Runs `change` in a transaction that no change to which models the workspace
 * offers or holds can interleave with. For a change that picks the model to
 * hold itself; one that is handed the model uses {@link holdingModel}.
 */
export const withHeldModelsLocked = <A, E, R>(
	workspaceId: string,
	change: Effect.Effect<A, E, R>,
) => transaction(Effect.andThen(lockHeldModels(workspaceId), change));

/**
 * Runs `change` in a transaction, and rolls it back with {@link ModelInUse} if
 * it stops the workspace offering a held model or deletes one. A held model
 * already not offered, because a failed test switched its provider off, may
 * still be switched off further, so it does not block every other change; it
 * may not be deleted.
 */
export const keepingHeldModelsOffered = <A, E, R>(
	workspaceId: string,
	change: Effect.Effect<A, E, R>,
) =>
	withHeldModelsLocked(
		workspaceId,
		Effect.gen(function* () {
			const before = yield* modelStates(workspaceId);
			const result = yield* change;
			const after = yield* modelStates(workspaceId);
			// What holds a model once the change has run, so a change may move the
			// default or a system bot off a model as it stops offering it.
			const held = yield* heldModels(workspaceId);
			const lost = [...held].find(
				([modelId]) =>
					(before.offered.has(modelId) && !after.offered.has(modelId)) ||
					(before.listed.has(modelId) && !after.listed.has(modelId)),
			);
			if (lost) {
				const [modelId, holders] = lost;
				return yield* new ModelInUse({ modelId: DisplayName.fromRecord(modelId), holders });
			}
			return result;
		}),
	);

const lockHeldModels = (workspaceId: string) =>
	query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.where(eq(workspace.id, workspaceId))
			.for("update"),
	);

/** Each held model, and what holds it. */
const heldModels = (workspaceId: string) =>
	Effect.gen(function* () {
		const [workspaceDefault, systemBots] = yield* Effect.all([
			defaultModelOf(workspaceId),
			query((db) =>
				db
					.select({ name: bot.name, model: bot.model })
					.from(bot)
					.where(
						and(
							eq(bot.workspaceId, workspaceId),
							isNotNull(bot.systemBotKey),
							isNotNull(bot.model),
						),
					)
					.orderBy(bot.name),
			),
		]);
		const held = new Map<string, Holders>();
		const holdersOf = (modelId: string) =>
			held.get(modelId) ?? { workspaceDefault: false, systemBots: [] };
		if (workspaceDefault !== undefined) {
			held.set(workspaceDefault, { ...holdersOf(workspaceDefault), workspaceDefault: true });
		}
		for (const { name, model } of systemBots) {
			if (model === null) continue;
			const holders = holdersOf(model);
			held.set(model, {
				...holders,
				systemBots: [...holders.systemBots, DisplayName.fromRecord(name)],
			});
		}
		return held;
	});

/** Which models the workspace offers bots, and which it lists at all. */
const modelStates = (workspaceId: string) =>
	Effect.all({
		offered: Effect.map(
			offeredModels(workspaceId),
			({ models }) => new Set(models.map(({ modelId }) => modelId)),
		),
		listed: Effect.map(
			query((db) =>
				db
					.select({ modelId: providerModel.modelId })
					.from(providerModel)
					.where(eq(providerModel.workspaceId, workspaceId)),
			),
			(rows) => new Set(rows.map(({ modelId }) => modelId)),
		),
	});
