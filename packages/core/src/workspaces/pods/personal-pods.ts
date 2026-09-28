export * as PersonalPods from "./personal-pods.ts";

import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { AgentRepository } from "../agents/agent-repository.ts";
import { PodRepository } from "./pod-repository.ts";

/**
 * Making somebody's Personal pod and its Personal Assistant, for the use
 * cases that let a person into a workspace. They decide who that is, so this
 * takes any `userId` and asks no actor; it is never handed to a route.
 */
export interface Interface {
	/**
	 * Makes `userId`'s Personal pod and its Personal Assistant, each only if it
	 * is missing. A new assistant runs on
	 * {@link AgentRepository.FALLBACK_ASSISTANT_MODEL}.
	 */
	readonly provision: (input: {
		workspaceId: string;
		userId: string;
	}) => Effect.Effect<schema.PodRow>;
	/**
	 * {@link Interface.provision} on `model`, which the workspace must offer. An
	 * existing assistant moves to `model` only when the workspace does not
	 * offer the one it runs on, so a model its owner chose stays.
	 */
	readonly provisionWithModel: (input: {
		workspaceId: string;
		userId: string;
		model: string;
	}) => Effect.Effect<schema.PodRow, ModelProviderRepository.ModelNotEnabled>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/PersonalPods") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PersonalPods");
	const pods = yield* PodRepository.Service;
	const agents = yield* AgentRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;

	const isOffered = (workspaceId: string, model: string | null) =>
		model === null ? Effect.succeed(false) : modelProviders.isEnabled(workspaceId, model);

	const provision = (workspaceId: string, userId: string, model?: string) =>
		Effect.gen(function* () {
			const personal = yield* pods.provisionPersonal(workspaceId, userId);
			const assistant = yield* agents.provisionPersonalAssistant({
				workspaceId,
				podId: personal.id,
				userId,
				model,
			});
			return { personal, assistant };
		});

	return Service.of({
		provision: ({ workspaceId, userId }) =>
			operation(
				"provision",
				transaction(Effect.map(provision(workspaceId, userId), ({ personal }) => personal)),
			),

		provisionWithModel: ({ workspaceId, userId, model }) =>
			operation(
				"provisionWithModel",
				transaction(
					Effect.gen(function* () {
						if (!(yield* isOffered(workspaceId, model))) {
							return yield* new ModelProviderRepository.ModelNotEnabled({ model });
						}
						const { personal, assistant } = yield* provision(workspaceId, userId, model);
						if (!(yield* isOffered(workspaceId, assistant.model))) {
							// Only the model of the assistant just read changes, so none of
							// `update`'s refusals can happen.
							yield* agents.update(workspaceId, assistant.id, { model }).pipe(Effect.orDie);
						}
						return personal;
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([PodRepository.layer, AgentRepository.layer, ModelProviderRepository.layer]),
);
