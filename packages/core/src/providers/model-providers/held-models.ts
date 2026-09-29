import { and, eq, isNotNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { query, transaction } from "../../database/database.ts";
import { agent, providerModel, workspace, workspaceDefaultModel } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { offeredModels } from "./model-provider-reads.ts";

/**
 * The models a workspace has to go on offering: its default, which new agents
 * start on, and each system agent's, since a system agent always runs. Each
 * maps to the names of what holds it.
 */
export const heldModels = (workspaceId: string) =>
	Effect.gen(function* () {
		const [defaults, systemAgents] = yield* Effect.all([
			query((db) =>
				db
					.select({ modelId: workspaceDefaultModel.modelId })
					.from(workspaceDefaultModel)
					.where(eq(workspaceDefaultModel.workspaceId, workspaceId)),
			),
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
		const holders = new Map<string, string[]>();
		const hold = (modelId: string, holder: string) =>
			holders.set(modelId, [...(holders.get(modelId) ?? []), holder]);
		for (const { modelId } of defaults) hold(modelId, DEFAULT_HOLDER);
		for (const { name, model } of systemAgents) if (model) hold(model, name);
		return holders;
	});

/**
 * Serialises everything that changes which models a workspace offers or which
 * of them it holds, so a model cannot stop being offered while another
 * transaction makes it held.
 */
export const lockHeldModels = (workspaceId: string) =>
	query((db) =>
		db
			.select({ id: workspace.id })
			.from(workspace)
			.where(eq(workspace.id, workspaceId))
			.for("update"),
	);

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
	transaction(
		Effect.gen(function* () {
			yield* lockHeldModels(workspaceId);
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

const DEFAULT_HOLDER = "The workspace default";

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** A change would stop the workspace offering a model its default or a system agent runs on. */
export class ModelInUse
	extends Data.TaggedError("ModelInUse")<{
		readonly modelId: string;
		readonly holders: readonly string[];
	}>
	implements UserFacing
{
	get userMessage() {
		const one = this.holders.length === 1;
		// Holders are system agents' names and our own words; a model id is the
		// provider's name for a model an administrator switched on.
		const holders = UserMessage.unchecked(LIST.format(this.holders));
		return UserMessage.of`${holders} ${one ? "uses" : "use"} ${UserMessage.unchecked(this.modelId)}. Choose another model for ${one ? "it" : "them"} first.`;
	}
}
