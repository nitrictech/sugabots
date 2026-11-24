export * as Bots from "./bots.ts";

import type { Bot, BotUpdate, NewBot, SystemBot, SystemBotKey } from "@sugabots/contracts";
import {
	AssistantInstructionsManaged,
	AssistantManaged,
	AssistantVisibilityFixed,
	type BotGone,
	type BotHandleReserved,
	type BotNameTaken,
	EmptyBotUpdate,
	type SystemBotImmutable,
	SystemBotMissing,
} from "@sugabots/contracts/errors/bots";
import {
	type ComputerMadeMeanwhile,
	ComputerUnavailable,
} from "@sugabots/contracts/errors/computers";
import type { LeadsProjects } from "@sugabots/contracts/errors/projects";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { ModelNotEnabled } from "@sugabots/contracts/errors/providers";
import { Context, Effect, Layer } from "effect";
import type { Actor } from "../../authorization/permissions.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { serviceOperations } from "../../database/database.ts";
import type { CanDeleteBot } from "../../proofs/bot-permissions.ts";
import type { CanManageBot } from "../../proofs/can-manage-bot.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { ReachesBot } from "../../proofs/reaches-bot.ts";
import type {
	CanCreateBots,
	CanManageWorkspace,
	CanReadWorkspace,
} from "../../proofs/workspace-permissions.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";
import { memberFacingBot, systemBots, visibleMemberFacingBots } from "./bot-reads.ts";
import { BotStore } from "./bot-store.ts";
import { PersonalAssistants } from "./personal-assistants.ts";

/**
 * A workspace's bots, for operations that have proved what each call needs:
 * those members make, each member's Personal Assistant, and the system bots
 * it sets up once. Each method takes the workspace and the bot from its
 * proofs, and returns bots as the member acting sees them, permissions and
 * all. Whatever a bot runs on has to be a model the workspace offers.
 */
export interface Interface {
	/** The bots the reader sees, by name: those they reach, and every personal one for an admin. */
	readonly list: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<Bot[]>;
	/** A bot made by the member who may make one, and pinned for them. */
	readonly create: <P, W>(
		canCreate: CanCreateBots<P, W>,
		bot: NewBot,
	) => Effect.Effect<Bot, ModelNotEnabled | BotNameTaken | BotHandleReserved | ResourceHidden>;
	/**
	 * Changes the bot. A Personal Assistant's member changes only its name and
	 * avatar; a bot managing itself in its own chats, only its instructions and
	 * description, which its interview writes.
	 */
	readonly update: <P, B>(
		canManage: CanManageBot<P, B>,
		changes: BotUpdate,
	) => Effect.Effect<
		Bot,
		| ActionForbidden
		| EmptyBotUpdate
		| ModelNotEnabled
		| BotNameTaken
		| BotHandleReserved
		| BotGone
		| SystemBotImmutable
		| LeadsProjects
		| AssistantVisibilityFixed
		| AssistantInstructionsManaged
		| AssistantManaged
		| ResourceHidden
	>;
	/**
	 * Deletes the bot, with its default project. Its computer is destroyed at
	 * its provider first, once the bot is free to delete: when the provider
	 * can't be reached, or a computer is made meanwhile, the bot is kept, to
	 * try again.
	 */
	readonly remove: <P, B>(
		canDelete: CanDeleteBot<P, B>,
	) => Effect.Effect<
		void,
		SystemBotImmutable | LeadsProjects | ComputerUnavailable | ComputerMadeMeanwhile
	>;
	/** Pins the bot to the member's sidebar, or takes it off. */
	readonly setPinned: <P, B>(
		isMember: IsMember<P>,
		reach: ReachesBot<P, B>,
		pinned: boolean,
	) => Effect.Effect<Bot, ResourceHidden>;
	/**
	 * The member's Personal Assistant, made on `model` when they have none. An
	 * existing one moves onto `model` when it has no model or runs on one the
	 * workspace no longer offers, so a model its member chose stays. Without
	 * `model`, one with no model is given the workspace's default.
	 */
	readonly ensureAssistant: <P, W>(
		isMember: IsMember<P>,
		canRead: CanReadWorkspace<P, W>,
		model: string | undefined,
	) => Effect.Effect<Bot, ModelNotEnabled | ResourceHidden>;
	/** The workspace's system bots, with the model each runs on. */
	readonly systemBots: <P, W>(canRead: CanReadWorkspace<P, W>) => Effect.Effect<SystemBot[]>;
	/** Points a system bot at a model the workspace offers. */
	readonly setSystemBotModel: <P, W>(
		canManage: CanManageWorkspace<P, W>,
		key: SystemBotKey,
		model: string,
	) => Effect.Effect<SystemBot, ModelNotEnabled | SystemBotMissing>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Bots") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Bots");
	const store = yield* BotStore.Service;
	const modelProviders = yield* ModelProviderStore.Service;
	const projectComputers = yield* ProjectComputers.Service;
	const personalAssistants = yield* PersonalAssistants.Service;

	/** The bot `botId` as `actor` is shown it, with whether they pinned it. */
	const shown = (botId: string, actor: Actor) =>
		Effect.flatMap(memberFacingBot(botId, actor), (bot) =>
			bot ? Effect.succeed(bot) : Effect.fail(new ResourceHidden({ resource: "bot" })),
		);

	return Service.of({
		list: (canRead) =>
			operation(
				"list",
				visibleMemberFacingBots(canRead.inWorkspace.workspace.value, canRead.actor),
			),

		create: (canCreate, bot) =>
			operation(
				"create",
				Effect.gen(function* () {
					const workspaceId = canCreate.inWorkspace.workspace.value;
					yield* modelProviders.requireEnabled(workspaceId, bot.model);
					const made = yield* store.create(workspaceId, {
						createdById: canCreate.actor.memberId,
						bot,
					});
					return yield* shown(made.id, canCreate.actor);
				}),
			),

		update: (canManage, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const { workspace, facts, actor } = canManage;
					const changed = changedFields(changes);
					if (changed.length === 0) return yield* new EmptyBotUpdate();
					if (
						canManage.inOwnChats &&
						changed.some((field) => !INTERVIEW_WRITTEN_FIELDS.has(field))
					) {
						return yield* new ActionForbidden({ proof: "CanManageBot" });
					}
					if (facts.assistantOf !== null) yield* requireAssistantAvatarOnly(changes);
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(workspace, changes.model);
					}
					const updated = yield* store.update(workspace, facts.id, changes, actor.memberId);
					return yield* shown(updated.id, actor);
				}),
			),

		remove: (canDelete) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { workspace, actor } = canDelete;
					const botId = canDelete.bot.value;
					// Deleting the bot deletes its default project and so its computer's
					// record, so its machine goes first, once the bot is free to delete; a
					// computer recorded meanwhile still keeps the bot, to try again.
					const destroyComputer = Effect.flatMap(defaultProjectOf(botId), (projectId) => {
						const defaultProject = { workspaceId: workspace, projectId };
						return Effect.andThen(
							projectComputers.destroy(defaultProject).pipe(
								Effect.catchTag("ComputerUnavailable", (failure) =>
									Effect.fail(
										new ComputerUnavailable({
											provider: failure.provider,
											reason: failure.reason,
											cause: failure.cause,
										}),
									),
								),
							),
							ProjectComputers.lockWithoutComputer(defaultProject),
						);
					});
					yield* store.remove(workspace, botId, actor.memberId, destroyComputer);
				}),
			),

		setPinned: (isMember, reach, pinned) =>
			operation(
				"setPinned",
				Effect.gen(function* () {
					const botId = reach.bot.value;
					yield* store.setPinned({
						workspaceId: reach.workspace,
						memberId: isMember.member,
						botId,
						pinned,
					});
					return yield* shown(botId, viewerOf(reach));
				}),
			),

		ensureAssistant: (isMember, canRead, model) =>
			operation(
				"ensureAssistant",
				Effect.gen(function* () {
					const member = {
						workspaceId: canRead.inWorkspace.workspace.value,
						memberId: isMember.member,
					};
					const assistant =
						model === undefined
							? yield* personalAssistants.provision(member)
							: yield* personalAssistants.provisionWithModel({ ...member, model });
					return yield* shown(assistant.id, canRead.actor);
				}),
			),

		systemBots: (canRead) =>
			operation("systemBots", systemBots(canRead.inWorkspace.workspace.value)),

		setSystemBotModel: (canManage, key, model) =>
			operation(
				"setSystemBotModel",
				Effect.gen(function* () {
					const workspaceId = canManage.inWorkspace.workspace.value;
					yield* holdingModel(workspaceId, model, store.setSystemBotModel(workspaceId, key, model));
					const updated = (yield* systemBots(workspaceId)).find(
						(candidate) => candidate.key === key,
					);
					if (!updated) return yield* new SystemBotMissing({ key });
					return updated;
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([
		BotStore.layer,
		ModelProviderStore.layer,
		ProjectComputers.layer,
		PersonalAssistants.layer,
	]),
);

/** What a bot's interview writes, which is all it changes of itself in its own chats. */
const INTERVIEW_WRITTEN_FIELDS: ReadonlySet<keyof BotUpdate> = new Set([
	"instructions",
	"description",
]);

/** What a Personal Assistant's member may change of it: its name and its avatar. */
const ASSISTANT_NAME_AND_AVATAR_FIELDS: ReadonlySet<keyof BotUpdate> = new Set([
	"name",
	"color",
	"eyes",
	"shape",
]);

/** The fields `changes` sets. */
function changedFields(changes: BotUpdate): (keyof BotUpdate)[] {
	return (Object.keys(changes) as (keyof BotUpdate)[]).filter(
		(field) => changes[field] !== undefined,
	);
}

/**
 * Refuses `changes` to a Personal Assistant that change more than its name and avatar:
 * Sugabots manages the rest of it. Its connectors are changed apart.
 */
export const requireAssistantAvatarOnly = (changes: BotUpdate) =>
	Effect.gen(function* () {
		const changed = changedFields(changes);
		// A Personal Assistant is always its member's alone.
		if (changed.includes("visibility")) return yield* new AssistantVisibilityFixed();
		// What a Personal Assistant is told is Sugabots', not its member's.
		if (changed.includes("instructions")) return yield* new AssistantInstructionsManaged();
		if (changed.some((field) => !ASSISTANT_NAME_AND_AVATAR_FIELDS.has(field)))
			return yield* new AssistantManaged();
	});

/**
 * Who a bot reached is shown to, with what they may do: the member acting,
 * or for a principal acting for no member, nobody, who may do nothing and
 * has pinned nothing.
 */
function viewerOf<P, B>(reach: ReachesBot<P, B>): Actor {
	return reach.viewer ?? NOBODY;
}

/** A viewer with no role, whose id is no member's. */
const NOBODY: Actor = {
	memberId: "00000000-0000-0000-0000-000000000000",
	workspaceRole: undefined,
};
