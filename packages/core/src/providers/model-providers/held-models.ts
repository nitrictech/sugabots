import { and, eq, isNotNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { query, transaction } from "../../database/database.ts";
import { agent, providerModel, workspace } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { offeredModels } from "./model-provider-reads.ts";
import { defaultModelOf, ModelNotEnabled } from "./model-provider-repository.ts";

/**
 * A workspace's models are held by its default, which new agents start on, and
 * by its system agents, since a system agent always runs. A held model stays
 * offered: every change that could stop offering one runs through
 * {@link keepingHeldModelsOffered}, and every change that makes one held runs
 * through {@link holdingModel} or {@link withHeldModelsLocked}. All three take
 * the same lock, so neither can slip between the other's check and its write.
 */

/** What holds one model: the workspace default, and the system agents by name. */
export interface Holders {
	readonly workspaceDefault: boolean;
	readonly systemAgents: readonly string[];
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
			const held = yield* heldModels(workspaceId);
			const before = yield* modelStates(workspaceId);
			const result = yield* change;
			const after = yield* modelStates(workspaceId);
			const lost = [...held].find(
				([modelId]) =>
					(before.offered.has(modelId) && !after.offered.has(modelId)) ||
					(before.listed.has(modelId) && !after.listed.has(modelId)),
			);
			if (lost) {
				const [modelId, holders] = lost;
				return yield* new ModelInUse({ modelId, holders });
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
		const [workspaceDefault, systemAgents] = yield* Effect.all([
			defaultModelOf(workspaceId),
			query((db) =>
				db
					.select({ name: agent.name, model: agent.model })
					.from(agent)
					.where(
						and(
							eq(agent.workspaceId, workspaceId),
							isNotNull(agent.systemAgentKey),
							isNotNull(agent.model),
						),
					)
					.orderBy(agent.name),
			),
		]);
		const held = new Map<string, Holders>();
		const holdersOf = (modelId: string) =>
			held.get(modelId) ?? { workspaceDefault: false, systemAgents: [] };
		if (workspaceDefault !== undefined) {
			held.set(workspaceDefault, { ...holdersOf(workspaceDefault), workspaceDefault: true });
		}
		for (const { name, model } of systemAgents) {
			if (model === null) continue;
			const holders = holdersOf(model);
			held.set(model, { ...holders, systemAgents: [...holders.systemAgents, name] });
		}
		return held;
	});

/** Which models the workspace offers agents, and which it lists at all. */
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

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** A change would stop the workspace offering a model its default or a system agent runs on. */
export class ModelInUse
	extends Data.TaggedError("ModelInUse")<{
		readonly modelId: string;
		readonly holders: Holders;
	}>
	implements UserFacing
{
	get userMessage() {
		const { workspaceDefault, systemAgents } = this.holders;
		const names = [...(workspaceDefault ? ["New bots"] : []), ...systemAgents];
		const one = names.length === 1 && !workspaceDefault;
		// System agents' names are ours; a model id is the provider's name for a
		// model an administrator switched on.
		const subject = UserMessage.unchecked(LIST.format(names));
		return UserMessage.of`${subject} ${one ? "uses" : "use"} ${UserMessage.unchecked(this.modelId)}. Choose another model for ${one ? "it" : "them"} under Models → Default first.`;
	}
}
