export * as PersonalAssistants from "./personal-assistants.ts";

import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import type { PersonFacingBotRow } from "./bot.ts";
import { BotStore } from "./bot-store.ts";

/**
 * Making somebody's Personal Assistant, for the operations that let a person
 * into a workspace. They decide who that is, so this takes any `personId` and
 * asks no actor; it is never handed to a route.
 */
export interface Interface {
	/**
	 * Makes `personId`'s Personal Assistant, only if it is missing. A new one
	 * starts on the workspace's default model, or on none while the workspace
	 * offers none; an existing one with no model is given that default.
	 */
	readonly provision: (input: {
		workspaceId: string;
		personId: string;
	}) => Effect.Effect<PersonFacingBotRow>;
	/**
	 * {@link Interface.provision} on `model`, which the workspace must offer. An
	 * existing assistant moves to `model` only when the workspace does not
	 * offer the one it runs on, so a model its person chose stays.
	 */
	readonly provisionWithModel: (input: {
		workspaceId: string;
		personId: string;
		model: string;
	}) => Effect.Effect<PersonFacingBotRow, ModelProviderStore.ModelNotEnabled>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PersonalAssistants",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PersonalAssistants");
	const bots = yield* BotStore.Service;
	const modelProviders = yield* ModelProviderStore.Service;

	const isOffered = (workspaceId: string, model: string | null) =>
		model === null ? Effect.succeed(false) : modelProviders.isEnabled(workspaceId, model);

	const provision = (workspaceId: string, personId: string, model?: string) =>
		Effect.gen(function* () {
			return yield* bots.provisionPersonalAssistant({
				workspaceId,
				personId,
				model: model ?? (yield* modelProviders.defaultModel(workspaceId)),
			});
		});

	/** Moves `personId`'s `assistant` onto `model`. Only its model changes, so none of `update`'s refusals can happen. */
	const moveOnto = (
		person: { workspaceId: string; personId: string },
		assistant: PersonFacingBotRow,
		model: string,
	) => bots.update(person.workspaceId, assistant.id, { model }, person.personId).pipe(Effect.orDie);

	return Service.of({
		provision: ({ workspaceId, personId }) =>
			operation(
				"provision",
				transaction(
					Effect.gen(function* () {
						const assistant = yield* provision(workspaceId, personId);
						if (assistant.model !== null) return assistant;
						const model = yield* modelProviders.defaultModel(workspaceId);
						return model === undefined
							? assistant
							: yield* moveOnto({ workspaceId, personId }, assistant, model);
					}),
				),
			),

		provisionWithModel: ({ workspaceId, personId, model }) =>
			operation(
				"provisionWithModel",
				transaction(
					Effect.gen(function* () {
						if (!(yield* isOffered(workspaceId, model))) {
							return yield* new ModelProviderStore.ModelNotEnabled({ model });
						}
						const assistant = yield* provision(workspaceId, personId, model);
						if (yield* isOffered(workspaceId, assistant.model)) return assistant;
						return yield* moveOnto({ workspaceId, personId }, assistant, model);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([BotStore.layer, ModelProviderStore.layer]));
