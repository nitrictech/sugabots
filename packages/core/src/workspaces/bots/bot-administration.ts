export {
	AssistantInstructionsManaged,
	AssistantManaged,
	AssistantVisibilityFixed,
	EmptyBotUpdate,
} from "@sugabots/contracts/errors/bots";
export * as BotAdministration from "./bot-administration.ts";

import type { Bot, BotUpdate } from "@sugabots/contracts";
import {
	type AssistantInstructionsManaged,
	type AssistantManaged,
	type AssistantVisibilityFixed,
	EmptyBotUpdate,
} from "@sugabots/contracts/errors/bots";
import { Context, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import type { Actor } from "../../authorization/permissions.ts";
import { serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import type { LeadsProjects } from "../projects/project-leads.ts";
import { memberFacingBot, visibleMemberFacingBots } from "./bot-reads.ts";
import { BotStore } from "./bot-store.ts";
import { requireAssistantAvatarOnly } from "./bots.ts";

/**
 * What tools still do with bots for the member a bot answers, as the current
 * actor: a Personal Assistant's `workspace_guide` lists the bots its member
 * sees and its `pin_bot` pins one, and `save_instructions` changes a bot's
 * instructions. It exists only because those tools still call services
 * directly; it goes when tools become operations, called in the bot loop like
 * any other entrypoint's. Everything else, and the HTTP API, goes through the
 * bots operations and the `Bots` service, which demands proofs.
 */
export interface Interface {
	/** The bots the current actor sees, by name: those they reach, and every personal one for an admin. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Bot[], AuthorizationDenied, CurrentActor.Service>;
	/** Pins the bot to the actor's sidebar, or takes it off. */
	readonly setPinned: (input: {
		botId: string;
		pinned: boolean;
	}) => Effect.Effect<Bot, AuthorizationDenied, CurrentActor.Service>;
	readonly update: (input: {
		botId: string;
		changes: BotUpdate;
	}) => Effect.Effect<
		Bot,
		| AuthorizationDenied
		| EmptyBotUpdate
		| ModelProviderStore.ModelNotEnabled
		| BotStore.BotNameTaken
		| BotStore.BotHandleReserved
		| BotStore.BotGone
		| BotStore.SystemBotImmutable
		| LeadsProjects
		| AssistantVisibilityFixed
		| AssistantInstructionsManaged
		| AssistantManaged,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/BotAdministration",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("BotAdministration");
	const authorization = yield* Authorization.Service;
	const bots = yield* BotStore.Service;
	const modelProviders = yield* ModelProviderStore.Service;

	/** The bot as `actor` is shown it, with whether they pinned it. */
	const shown = (row: schema.BotRow, actor: Actor) =>
		Effect.flatMap(memberFacingBot(row.id, actor), (bot) =>
			bot ? Effect.succeed(bot) : Effect.fail(new ResourceHidden({ resource: "bot" })),
		);

	return Service.of({
		list: (input) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						input.workspace,
						"workspace.read",
					);
					return yield* visibleMemberFacingBots(workspaceId, actor);
				}),
			),

		setPinned: ({ botId, pinned }) =>
			operation(
				"setPinned",
				Effect.gen(function* () {
					const { bot, actor } = yield* authorization.bot(botId, "bot.read");
					yield* bots.setPinned({
						workspaceId: bot.workspaceId,
						memberId: actor.memberId,
						botId: bot.id,
						pinned,
					});
					return yield* shown(bot, actor);
				}),
			),

		update: ({ botId, changes }) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { bot, actor } = yield* authorization.bot(botId, "bot.update");
					if (Object.values(changes).every((value) => value === undefined)) {
						return yield* new EmptyBotUpdate();
					}
					if (bot.assistantOf !== null) yield* requireAssistantAvatarOnly(changes);
					if (changes.usesComputer !== undefined && changes.usesComputer !== bot.usesComputer) {
						yield* authorization.bot(botId, "computer.manage");
					}
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(bot.workspaceId, changes.model);
					}
					return yield* shown(
						yield* bots.update(bot.workspaceId, bot.id, changes, actor.memberId),
						actor,
					);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, BotStore.layer, ModelProviderStore.layer]),
);
