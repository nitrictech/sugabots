export * as PersonalAssistants from "./personal-assistants.ts";

import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import type { CrewAgentRow } from "./agent.ts";
import { AgentRepository } from "./agent-repository.ts";

/**
 * Making somebody's Personal Assistant, for the use cases that let a person
 * into a workspace. They decide who that is, so this takes any `userId` and
 * asks no actor; it is never handed to a route.
 */
export interface Interface {
	/**
	 * Makes `userId`'s Personal Assistant, only if it is missing. A new one
	 * starts on the workspace's default model, or on none while the workspace
	 * offers none.
	 */
	readonly provision: (input: {
		workspaceId: string;
		userId: string;
	}) => Effect.Effect<CrewAgentRow>;
	/**
	 * {@link Interface.provision} on `model`, which the workspace must offer. An
	 * existing assistant moves to `model` only when the workspace does not
	 * offer the one it runs on, so a model its person chose stays.
	 */
	readonly provisionWithModel: (input: {
		workspaceId: string;
		userId: string;
		model: string;
	}) => Effect.Effect<CrewAgentRow, ModelProviderRepository.ModelNotEnabled>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PersonalAssistants",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PersonalAssistants");
	const agents = yield* AgentRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;

	const isOffered = (workspaceId: string, model: string | null) =>
		model === null ? Effect.succeed(false) : modelProviders.isEnabled(workspaceId, model);

	const provision = (workspaceId: string, userId: string, model?: string) =>
		Effect.gen(function* () {
			return yield* agents.provisionPersonalAssistant({
				workspaceId,
				userId,
				model: model ?? (yield* modelProviders.defaultModel(workspaceId)),
			});
		});

	return Service.of({
		provision: ({ workspaceId, userId }) =>
			operation("provision", transaction(provision(workspaceId, userId))),

		provisionWithModel: ({ workspaceId, userId, model }) =>
			operation(
				"provisionWithModel",
				transaction(
					Effect.gen(function* () {
						if (!(yield* isOffered(workspaceId, model))) {
							return yield* new ModelProviderRepository.ModelNotEnabled({ model });
						}
						const assistant = yield* provision(workspaceId, userId, model);
						if (yield* isOffered(workspaceId, assistant.model)) return assistant;
						// Only the model of the assistant just read changes, so none of
						// `update`'s refusals can happen.
						return yield* agents.update(workspaceId, assistant.id, { model }).pipe(Effect.orDie);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([AgentRepository.layer, ModelProviderRepository.layer]),
);
