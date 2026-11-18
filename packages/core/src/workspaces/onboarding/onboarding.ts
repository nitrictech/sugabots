export * as Onboarding from "./onboarding.ts";

import { userText } from "@sugabots/errors";
import { and, eq, isNull } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { agent, workspace } from "../../database/schema.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import type { UserFacing } from "../../user-message.ts";
import { AgentRepository } from "../agents/agent-repository.ts";

/**
 * The current actor finishing setting up a workspace. It is transactional and
 * locks the rows it checks, so the check still holds when the writes that
 * follow it land.
 */
export interface Interface {
	/**
	 * Finishes setting up `workspaceId`, once `agentId` is a bot the actor
	 * made there, and that bot runs on a model the workspace offers. Finishing settles the first agent and the model the
	 * workspace runs it on, so it takes `workspace.providers.manage`.
	 *
	 * That model also becomes the workspace's default and every system agent's:
	 * it is the one model the person setting the workspace up has chosen, and
	 * the system agents have to run on something.
	 *
	 * The first time, it records when the workspace's setup was completed.
	 */
	readonly complete: (input: {
		workspaceId: string;
		agentId: string;
	}) => Effect.Effect<
		void,
		AuthorizationDenied | NotReadyToFinish | NoModelChosen,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Onboarding") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Onboarding");
	const authorization = yield* Authorization.Service;
	const modelProviders = yield* ModelProviderRepository.Service;
	const agents = yield* AgentRepository.Service;

	return Service.of({
		complete: ({ workspaceId, agentId }) =>
			operation(
				"complete",
				transaction(
					Effect.gen(function* () {
						const { workspaceId: resolved, actor } = yield* authorization.workspace(
							workspaceId,
							"workspace.providers.manage",
						);
						const [eligible] = yield* query((db) =>
							db
								.select({ model: agent.model })
								.from(agent)
								.where(
									and(
										eq(agent.id, agentId),
										eq(agent.workspaceId, resolved),
										eq(agent.createdById, actor.userId),
										isNull(agent.systemAgentKey),
									),
								)
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
								agents.setAllSystemAgentModels(resolved, model),
							]),
						).pipe(Effect.catchTag("ModelNotEnabled", () => Effect.fail(new NoModelChosen())));
						yield* recordSetupCompleted(resolved);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ModelProviderRepository.layer, AgentRepository.layer]),
);

/** The bot named is not one this person may finish onboarding with. */
export class NotReadyToFinish extends Data.TaggedError("NotReadyToFinish") implements UserFacing {
	get userMessage() {
		return userText`Finish creating your bot first`;
	}
}

/** The first agent runs on no model, or on one the workspace does not offer. */
export class NoModelChosen extends Data.TaggedError("NoModelChosen") implements UserFacing {
	get userMessage() {
		return userText`Choose a model for your first bot first`;
	}
}

/** Records that `workspaceId`'s setup is complete, unless it already was. */
export const recordSetupCompleted = (workspaceId: string) =>
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) =>
			db
				.update(workspace)
				.set({ setupCompletedAt: now })
				.where(and(eq(workspace.id, workspaceId), isNull(workspace.setupCompletedAt))),
		),
	);
