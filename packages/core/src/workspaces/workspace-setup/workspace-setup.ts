export * as WorkspaceSetup from "./workspace-setup.ts";

import { NoModelChosen, NotReadyToFinish } from "@sugabots/contracts/errors/workspace";
import { and, eq, isNull } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { bot, workspace } from "../../database/schema.ts";
import type { Named } from "../../proofs/proof.ts";
import { eligibleSetupBot, type ReachesSetupBot } from "../../proofs/reaches-setup-bot.ts";
import type { CanManageWorkspace } from "../../proofs/workspace-permissions.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { BotStore } from "../bots/bot-store.ts";

/**
 * A member finishing setting up a workspace. It is transactional and locks
 * the rows it checks, so the check still holds when the writes that follow
 * it land.
 */
export interface Interface {
	/**
	 * Finishes setting up the workspace, once `chosenBot` is a bot the member who
	 * may manage it made there, and that bot runs on a model the workspace
	 * offers. Finishing settles the first bot and the model the workspace runs
	 * it on, so it takes managing the workspace.
	 *
	 * That model also becomes the workspace's default and every system bot's:
	 * it is the one model the member setting the workspace up has chosen, and
	 * the system bots have to run on something.
	 *
	 * The first time, it records when the workspace's setup was completed.
	 */
	readonly complete: <P, W, B>(
		canManage: CanManageWorkspace<P, W>,
		chosenBot: Named<B, string>,
		target: ReachesSetupBot<P, W, B>,
	) => Effect.Effect<void, NotReadyToFinish | NoModelChosen>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/WorkspaceSetup",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("WorkspaceSetup");
	const modelProviders = yield* ModelProviderStore.Service;
	const bots = yield* BotStore.Service;

	return Service.of({
		complete: (canManage, chosenBot, target) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						const resolved = target.workspace.value;
						const [eligible] = yield* query((db) =>
							db
								.select({ model: bot.model })
								.from(bot)
								.where(eligibleSetupBot(canManage, chosenBot))
								.limit(1)
								.for("update"),
						);
						if (!eligible) {
							return yield* new NotReadyToFinish();
						}
						const model = eligible.model;
						if (model === null) {
							return yield* new NoModelChosen();
						}
						yield* holdingModel(
							resolved,
							model,
							Effect.all([
								modelProviders.setDefaultModel(resolved, model),
								bots.setAllSystemBotModels(resolved, model),
							]),
						).pipe(Effect.catchTag("ModelNotEnabled", () => Effect.fail(new NoModelChosen())));
						yield* recordSetUp(resolved);
					}),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([ModelProviderStore.layer, BotStore.layer]));

/** Records that `workspaceId`'s setup is complete, unless it already was. */
export const recordSetUp = (workspaceId: string) =>
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) =>
			db
				.update(workspace)
				.set({ setUpAt: now })
				.where(and(eq(workspace.id, workspaceId), isNull(workspace.setUpAt))),
		),
	);
