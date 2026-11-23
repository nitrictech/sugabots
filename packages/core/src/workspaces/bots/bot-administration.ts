export * as BotAdministration from "./bot-administration.ts";

import type { Bot, BotUpdate, NewBot, SystemBot, SystemBotKey } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { Context, Data, Effect, Layer } from "effect";
import { type AuthorizationDenied, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import type { Actor } from "../../authorization/permissions.ts";
import type { Computers } from "../../computers/computers.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { serviceOperations } from "../../database/database.ts";
import type * as schema from "../../database/schema.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import type { UserFacing } from "../../user-message.ts";
import type { LeadsProjects } from "../projects/project-leads.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";
import { personFacingBot, systemBots, visiblePersonFacingBots } from "./bot-reads.ts";
import { BotStore } from "./bot-store.ts";
import { PersonalAssistants } from "./personal-assistants.ts";

/**
 * A workspace's bots: those people make, each person's Personal Assistant,
 * and the system bots it sets up once. Whatever a bot runs on has to be a
 * model the workspace offers.
 */
export interface Interface {
	/** The bots the current actor sees, by name: those they reach, and every private one for an admin. */
	readonly list: (input: {
		workspace: string;
	}) => Effect.Effect<Bot[], AuthorizationDenied, CurrentActor.Service>;
	/** A bot made by the actor, and pinned for them. */
	readonly create: (input: {
		workspace: string;
		bot: NewBot;
	}) => Effect.Effect<
		Bot,
		| AuthorizationDenied
		| ModelProviderStore.ModelNotEnabled
		| BotStore.BotNameTaken
		| BotStore.BotHandleReserved,
		CurrentActor.Service
	>;
	/** Pins the bot to the actor's sidebar, or takes it off. */
	readonly setPinned: (input: {
		botId: string;
		pinned: boolean;
	}) => Effect.Effect<Bot, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * The actor's Personal Assistant, made on `model` when they have none. An
	 * existing one moves onto `model` when it has no model or runs on one the
	 * workspace no longer offers, so a model its person chose stays. Without
	 * `model`, one with no model is given the workspace's default.
	 */
	readonly ensureAssistant: (input: {
		workspace: string;
		model?: string;
	}) => Effect.Effect<
		Bot,
		AuthorizationDenied | ModelProviderStore.ModelNotEnabled,
		CurrentActor.Service
	>;
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
		| AssistantStaysPrivate
		| AssistantInstructionsManaged
		| AssistantManaged,
		CurrentActor.Service
	>;
	readonly remove: (input: {
		botId: string;
	}) => Effect.Effect<
		void,
		| AuthorizationDenied
		| BotStore.SystemBotImmutable
		| LeadsProjects
		| Computers.Unavailable
		| ProjectComputers.ComputerMadeMeanwhile,
		CurrentActor.Service
	>;
	readonly systemBots: (input: {
		workspace: string;
	}) => Effect.Effect<SystemBot[], AuthorizationDenied, CurrentActor.Service>;
	/** Points a system bot at a model the workspace offers. */
	readonly setSystemBotModel: (input: {
		workspace: string;
		key: SystemBotKey;
		model: string;
	}) => Effect.Effect<
		SystemBot,
		AuthorizationDenied | ModelProviderStore.ModelNotEnabled | BotStore.SystemBotMissing,
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
	const projectComputers = yield* ProjectComputers.Service;
	const personalAssistants = yield* PersonalAssistants.Service;

	/** The bot as `actor` is shown it, with whether they pinned it. */
	const shown = (row: schema.BotRow, actor: Actor) =>
		Effect.flatMap(personFacingBot(row.id, actor), (bot) =>
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
					return yield* visiblePersonFacingBots(workspaceId, actor);
				}),
			),

		create: ({ workspace, bot }) =>
			operation(
				"create",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(workspace, "bot.create");
					yield* modelProviders.requireEnabled(workspaceId, bot.model);
					const made = yield* bots.create(workspaceId, { createdById: actor.personId, bot });
					return yield* shown(made, actor);
				}),
			),

		setPinned: ({ botId, pinned }) =>
			operation(
				"setPinned",
				Effect.gen(function* () {
					const { bot, actor } = yield* authorization.bot(botId, "bot.read");
					yield* bots.setPinned({
						workspaceId: bot.workspaceId,
						personId: actor.personId,
						botId: bot.id,
						pinned,
					});
					return yield* shown(bot, actor);
				}),
			),

		ensureAssistant: ({ workspace, model }) =>
			operation(
				"ensureAssistant",
				Effect.gen(function* () {
					const { workspaceId, actor } = yield* authorization.workspace(
						workspace,
						"workspace.read",
					);
					const person = { workspaceId, personId: actor.personId };
					const assistant =
						model === undefined
							? yield* personalAssistants.provision(person)
							: yield* personalAssistants.provisionWithModel({ ...person, model });
					return yield* shown(assistant, actor);
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
						yield* bots.update(bot.workspaceId, bot.id, changes, actor.personId),
						actor,
					);
				}),
			),

		remove: ({ botId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { bot, actor } = yield* authorization.bot(botId, "bot.delete");
					// Deleting the bot deletes its default project and so its computer's
					// record, so its machine goes first, once the bot is free to delete; a
					// computer recorded meanwhile still keeps the bot, to try again.
					const destroyComputer = Effect.flatMap(defaultProjectOf(bot.id), (projectId) => {
						const defaultProject = { workspaceId: bot.workspaceId, projectId };
						return Effect.andThen(
							projectComputers.destroy(defaultProject),
							ProjectComputers.lockWithoutComputer(defaultProject),
						);
					});
					yield* bots.remove(bot.workspaceId, bot.id, actor.personId, destroyComputer);
				}),
			),

		systemBots: (input) =>
			operation(
				"systemBots",
				Effect.flatMap(
					authorization.workspace(input.workspace, "workspace.read"),
					({ workspaceId }) => systemBots(workspaceId),
				),
			),

		setSystemBotModel: ({ workspace, key, model }) =>
			operation(
				"setSystemBotModel",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(
						workspace,
						"workspace.systemModel.choose",
					);
					yield* holdingModel(workspaceId, model, bots.setSystemBotModel(workspaceId, key, model));
					const updated = (yield* systemBots(workspaceId)).find(
						(candidate) => candidate.key === key,
					);
					if (!updated) {
						return yield* new BotStore.SystemBotMissing({ key });
					}
					return updated;
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([
		Authorization.layer,
		BotStore.layer,
		ModelProviderStore.layer,
		ProjectComputers.layer,
		PersonalAssistants.layer,
	]),
);

/** What a Personal Assistant's person may change of it: its name and its look. */
const ASSISTANT_LOOK: ReadonlySet<keyof BotUpdate> = new Set(["name", "color", "eyes", "shape"]);

/**
 * Refuses `changes` to a Personal Assistant that change more than its look:
 * Sugabots manages the rest of it. Its connectors are changed apart.
 */
const requireAssistantAvatarOnly = (changes: BotUpdate) =>
	Effect.gen(function* () {
		const changed = (Object.keys(changes) as (keyof BotUpdate)[]).filter(
			(field) => changes[field] !== undefined,
		);
		// A Personal Assistant is always its person's alone.
		if (changed.includes("visibility")) return yield* new AssistantStaysPrivate();
		// What a Personal Assistant is told is Sugabots', not its person's.
		if (changed.includes("prompt")) return yield* new AssistantInstructionsManaged();
		if (changed.some((field) => !ASSISTANT_LOOK.has(field))) return yield* new AssistantManaged();
	});

/** A bot update that names nothing to change. */
export class EmptyBotUpdate extends Data.TaggedError("EmptyBotUpdate") implements UserFacing {
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/** A Personal Assistant's instructions are written and kept by Sugabots. */
export class AssistantInstructionsManaged
	extends Data.TaggedError("AssistantInstructionsManaged")
	implements UserFacing
{
	get userMessage() {
		return userText`A Personal Assistant's instructions are kept by Sugabots, so they can't be changed`;
	}
}

/** Sugabots manages a Personal Assistant: its person changes only its name, its look and its connectors. */
export class AssistantManaged extends Data.TaggedError("AssistantManaged") implements UserFacing {
	get userMessage() {
		return userText`Only a Personal Assistant's name, look and connectors can be changed`;
	}
}

/** A Personal Assistant is only ever its person's, so it can't be made public. */
export class AssistantStaysPrivate
	extends Data.TaggedError("AssistantStaysPrivate")
	implements UserFacing
{
	get userMessage() {
		return userText`A Personal Assistant is only ever yours`;
	}
}
