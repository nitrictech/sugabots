export * as PersonalAssistants from "./personal-assistants.ts";

import { Context, Effect, Layer } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { processLayer, Tier } from "../../tiers.ts";
import type { MemberFacingBotRow } from "./bot.ts";
import { BotStore } from "./bot-store.ts";

/**
 * Making somebody's Personal Assistant, for the operations that let a member
 * into a workspace. They decide who that is, so this takes any `memberId` and
 * asks no actor; it is never handed to a route.
 */
export interface Interface {
	/**
	 * Makes `memberId`'s Personal Assistant, only if it is missing. A new one
	 * starts on the workspace's default model, or on none while the workspace
	 * offers none; an existing one with no model is given that default.
	 */
	readonly provision: (input: {
		workspaceId: string;
		memberId: string;
	}) => Effect.Effect<MemberFacingBotRow>;
	/**
	 * {@link Interface.provision} on `model`, which the workspace must offer. An
	 * existing assistant moves to `model` only when the workspace does not
	 * offer the one it runs on, so a model its member chose stays.
	 */
	readonly provisionWithModel: (input: {
		workspaceId: string;
		memberId: string;
		model: string;
	}) => Effect.Effect<MemberFacingBotRow, ModelProviderStore.ModelNotEnabled>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/PersonalAssistants",
) {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("PersonalAssistants");
	const bots = yield* BotStore.Service;
	const modelProviders = yield* ModelProviderStore.Service;

	const isOffered = (workspaceId: string, model: string | null) =>
		model === null ? Effect.succeed(false) : modelProviders.isEnabled(workspaceId, model);

	const provision = (workspaceId: string, memberId: string, model?: string) =>
		Effect.gen(function* () {
			return yield* bots.provisionPersonalAssistant({
				workspaceId,
				memberId,
				model: model ?? (yield* modelProviders.defaultModel(workspaceId)),
			});
		});

	/** Moves `memberId`'s `assistant` onto `model`. Only its model changes, so none of `update`'s refusals can happen. */
	const moveOnto = (
		member: { workspaceId: string; memberId: string },
		assistant: MemberFacingBotRow,
		model: string,
	) => bots.update(member.workspaceId, assistant.id, { model }, member.memberId).pipe(Effect.orDie);

	return Service.of({
		provision: ({ workspaceId, memberId }) =>
			operation(
				"provision",
				transaction(
					Effect.gen(function* () {
						const assistant = yield* provision(workspaceId, memberId);
						if (assistant.model !== null) return assistant;
						const model = yield* modelProviders.defaultModel(workspaceId);
						return model === undefined
							? assistant
							: yield* moveOnto({ workspaceId, memberId }, assistant, model);
					}),
				),
			),

		provisionWithModel: ({ workspaceId, memberId, model }) =>
			operation(
				"provisionWithModel",
				transaction(
					Effect.gen(function* () {
						if (!(yield* isOffered(workspaceId, model))) {
							return yield* new ModelProviderStore.ModelNotEnabled({ model });
						}
						const assistant = yield* provision(workspaceId, memberId, model);
						if (yield* isOffered(workspaceId, assistant.model)) return assistant;
						return yield* moveOnto({ workspaceId, memberId }, assistant, model);
					}),
				),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(Layer.provide([BotStore.layer, ModelProviderStore.layer]));
