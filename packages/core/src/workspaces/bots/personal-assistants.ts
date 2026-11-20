export * as PersonalAssistants from "./personal-assistants.ts";

import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import type { PersonFacingBotRow } from "./bot.ts";
import { BotRepository } from "./bot-repository.ts";

/**
 * Making somebody's Personal Assistant, for the use cases that let a person
 * into a workspace. They decide who that is, so this takes any `userId` and
 * asks no actor; it is never handed to a route.
 */
export interface Interface {
	/**
	 * Makes `userId`'s Personal Assistant, only if it is missing. A new one
	 * starts on the workspace's default model, or on none while the workspace
	 * offers none; an existing one with no model is given that default.
	 */
	readonly provision: (input: {
		workspaceId: string;
		userId: string;
	}) => Effect.Effect<PersonFacingBotRow>;
	/**
	 * {@link Interface.provision} on `model`, which the workspace must offer. An
	 * existing assistant moves to `model` only when the workspace does not
	 * offer the one it runs on, so a model its person chose stays.
	 */
	readonly provisionWithModel: (input: {
		workspaceId: string;
		userId: string;
		model: string;
	}) => Effect.Effect<PersonFacingBotRow, ModelProviderRepository.ModelNotEnabled>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PersonalAssistants",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PersonalAssistants");
	const bots = yield* BotRepository.Service;
	const modelProviders = yield* ModelProviderRepository.Service;

	const isOffered = (workspaceId: string, model: string | null) =>
		model === null ? Effect.succeed(false) : modelProviders.isEnabled(workspaceId, model);

	const provision = (workspaceId: string, userId: string, model?: string) =>
		Effect.gen(function* () {
			return yield* bots.provisionPersonalAssistant({
				workspaceId,
				userId,
				model: model ?? (yield* modelProviders.defaultModel(workspaceId)),
			});
		});

	/** Moves `userId`'s `assistant` onto `model`. Only its model changes, so none of `update`'s refusals can happen. */
	const moveOnto = (
		person: { workspaceId: string; userId: string },
		assistant: PersonFacingBotRow,
		model: string,
	) => bots.update(person.workspaceId, assistant.id, { model }, person.userId).pipe(Effect.orDie);

	return Service.of({
		provision: ({ workspaceId, userId }) =>
			operation(
				"provision",
				transaction(
					Effect.gen(function* () {
						const assistant = yield* provision(workspaceId, userId);
						if (assistant.model !== null) return assistant;
						const model = yield* modelProviders.defaultModel(workspaceId);
						return model === undefined
							? assistant
							: yield* moveOnto({ workspaceId, userId }, assistant, model);
					}),
				),
			),

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
						return yield* moveOnto({ workspaceId, userId }, assistant, model);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([BotRepository.layer, ModelProviderRepository.layer]),
);
