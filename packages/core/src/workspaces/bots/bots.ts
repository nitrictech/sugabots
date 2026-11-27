export * as Bots from "./bots.ts";

import type {
	Bot,
	BotMember,
	BotUpdate,
	NewBot,
	SystemBot,
	SystemBotKey,
} from "@sugabots/contracts";
import {
	AdministratorInEveryPrivateBot,
	AssistantHandleFixed,
	AssistantInstructionsManaged,
	type BotGone,
	type BotHandleReserved,
	type BotNameTaken,
	CreatorInOwnPrivateBot,
	EmptyBotUpdate,
	NotBotMember,
	PersonalVisibilityFixed,
	type SystemBotImmutable,
	SystemBotMissing,
} from "@sugabots/contracts/errors/bots";
import type { ComputerMadeMeanwhile } from "@sugabots/contracts/errors/computers";
import { type LeadsProjects, NotInWorkspace } from "@sugabots/contracts/errors/projects";
import { ActionForbidden, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { ModelNotEnabled } from "@sugabots/contracts/errors/providers";
import { Context, Effect, Layer } from "effect";
import type { Actor } from "../../authorization/permissions.ts";
import { holdTurnOf, type FenceRefusal } from "../../chats/turns/turns.ts";
import { ProjectComputers } from "../../computers/project-computers.ts";
import { serviceOperations, Transaction, transaction } from "../../database/database.ts";
import { EventOutbox } from "../../database/events/outbox.ts";
import type { ActsForMember } from "../../proofs/acts-for-member.ts";
import type { Approved } from "../../proofs/approved.ts";
import type {
	CanChangeBotMembers,
	CanChangeBotReach,
	CanDeleteBot,
} from "../../proofs/bot-permissions.ts";
import type { CanManageBot } from "../../proofs/can-manage-bot.ts";
import type { ProjectDeletionStarted } from "../../proofs/deletion-started.ts";
import type { IsMember } from "../../proofs/is-member.ts";
import type { Named } from "../../proofs/proof.ts";
import type { ReachesBot } from "../../proofs/reaches-bot.ts";
import type {
	CanCreateBots,
	CanManageWorkspace,
	CanReadWorkspace,
} from "../../proofs/workspace-permissions.ts";
import { holdingModel } from "../../providers/model-providers/held-models.ts";
import { ModelProviderStore } from "../../providers/model-providers/model-provider-store.ts";
import { reachChanged, reachNarrowed } from "../../streams/reach-changes.ts";
import { processLayer, Tier } from "../../tiers.ts";
import { refuseWhileLeading } from "../projects/project-leads.ts";
import { defaultProjectOf } from "../projects/project-reads.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { changesPersonal } from "./bot.ts";
import { botMembers, memberFacingBot, systemBots, visibleMemberFacingBots } from "./bot-reads.ts";
import { BotStore } from "./bot-store.ts";
import { PersonalAssistants } from "./personal-assistants.ts";

/**
 * A workspace's bots, for operations that have proved what each call needs:
 * those members make, each member's Personal Assistants, and the system bots
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
	 * Changes the bot. A Personal Assistant's member changes all but its
	 * instructions, handle and visibility; a bot managing itself in its own chats, only its instructions and
	 * description, which its interview writes. Changes to visibility and
	 * computer use require `authority` to be a `CanChangeBotReach`, proved under
	 * its workspace's lock. Made private, it leaves every public project,
	 * refused while it leads one.
	 */
	readonly update: <P, B>(
		authority: CanManageBot<P, B> | CanChangeBotReach<P, B>,
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
		| PersonalVisibilityFixed
		| AssistantInstructionsManaged
		| AssistantHandleFixed
		| LeadsProjects
		| ResourceHidden
	>;
	/**
	 * Replaces the instructions and description of the bot `canManage` is
	 * about, which is all a bot changes of itself, in its own chats and once
	 * its asker approves. A Personal Assistant's instructions are Sugabots'.
	 */
	readonly saveInstructions: <P, B, X>(
		canManage: CanManageBot<P, B>,
		approved: Approved<P, X, [B], "bots.saveInstructions">,
	) => Effect.Effect<
		Bot,
		AssistantInstructionsManaged | BotGone | ResourceHidden | FenceRefusal
	>;
	/** The members of the bot, by name: a private bot's, and none of any other. */
	readonly members: <P, B>(reach: ReachesBot<P, B>) => Effect.Effect<BotMember[]>;
	/** Adds `member` to the private bot. Adding somebody already one of its members changes nothing. */
	readonly addMember: <P, B, U>(
		canChange: CanChangeBotMembers<P, B>,
		member: Named<U, string>,
	) => Effect.Effect<void, NotInWorkspace, Transaction>;
	/**
	 * Takes `member` out of the private bot. Refuses an administrator, who
	 * belongs to every one, and its creator, who stays in their own.
	 */
	readonly removeMember: <P, B, U>(
		canChange: CanChangeBotMembers<P, B>,
		member: Named<U, string>,
	) => Effect.Effect<
		void,
		AdministratorInEveryPrivateBot | CreatorInOwnPrivateBot | NotBotMember,
		Transaction
	>;
	/** Records a deletion after ensuring the bot is free to delete. */
	readonly beginRemoval: <P, B>(
		canDelete: CanDeleteBot<P, B>,
	) => Effect.Effect<string, SystemBotImmutable | LeadsProjects, Transaction>;
	readonly remove: <W, J>(
		started: ProjectDeletionStarted<W, J, "bot">,
	) => Effect.Effect<void, ComputerMadeMeanwhile, Transaction>;
	/** Pins the bot to the sidebar of the member `forMember` names, or takes it off. */
	readonly setPinned: <P, B, X>(
		forMember: ActsForMember<P>,
		reach: ReachesBot<P, B>,
		pinned: boolean,
		approved: Approved<P, X, [B], "bots.pin" | "bots.unpin">,
	) => Effect.Effect<Bot, ResourceHidden | FenceRefusal>;
	/**
	 * Another Personal Assistant for the member, whatever their role, on the
	 * workspace's default model. Joining a workspace gives them their first; this
	 * is the only other way one is made.
	 */
	readonly createAssistant: <P, W>(
		isMember: IsMember<P>,
		canRead: CanReadWorkspace<P, W>,
	) => Effect.Effect<Bot, ResourceHidden>;
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
	const projects = yield* ProjectStore.Service;
	const personalAssistants = yield* PersonalAssistants.Service;
	const outbox = yield* EventOutbox.Service;

	/**
	 * Takes the bot out of every public project as it is made private, once it
	 * leads none, and returns those projects' ids.
	 */
	const leavePublicProjects = (workspaceId: string, botId: string, viewerId: string) =>
		Effect.gen(function* () {
			yield* refuseWhileLeading(botId, { viewerId, onlyPublic: true });
			return yield* projects.removeBotFromPublicProjects(workspaceId, botId);
		});

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

		update: (authority, changes) =>
			operation(
				"update",
				Effect.gen(function* () {
					const canManage = authority.kind === "CanChangeBotReach" ? authority.manage : authority;
					const { workspace, facts, actor } = canManage;
					const changed = changedFields(changes);
					if (changed.length === 0) return yield* new EmptyBotUpdate();
					const changesReach =
						changes.visibility !== undefined || changes.usesComputer !== undefined;
					if (changesReach && authority.kind !== "CanChangeBotReach") {
						return yield* Effect.die(new Error("Bot reach changes require the workspace lock"));
					}
					if (
						canManage.inOwnChats &&
						changed.some((field) => !INTERVIEW_WRITTEN_FIELDS.has(field))
					) {
						return yield* new ActionForbidden({ proof: "CanManageBot" });
					}
					if (changesPersonal(facts.visibility, changes.visibility)) {
						return yield* new PersonalVisibilityFixed();
					}
					if (facts.assistantOf !== null) yield* refuseAssistantsFixedFields(changes);
					// A cleared model names none to check.
					if (changes.model != null) {
						yield* modelProviders.requireEnabled(workspace, changes.model);
					}
					const updated = yield* transaction(
						Effect.gen(function* () {
							// A private bot is only in private projects.
							const left =
								facts.visibility === "public" && changes.visibility === "private"
									? yield* leavePublicProjects(workspace, facts.id, actor.memberId)
									: [];
							const row = yield* store.update(workspace, facts.id, changes);
							// Who reaches a bot, and whether its desktop may stay open, follow its
							// visibility and computer use, so streams and desktop viewers prove again.
							if (changesReach) {
								yield* outbox.publish([
									row.visibility === "private" && facts.visibility !== "private"
										? reachNarrowed(workspace)
										: reachChanged(workspace, { kind: "bot", botId: row.id }),
									...left.map((projectId) =>
										reachChanged(workspace, { kind: "project", projectId }),
									),
								]);
							}
							return row;
						}),
					);
					return yield* shown(updated.id, actor);
				}),
			),

		members: (reach) => operation("members", botMembers(reach.bot.value)),

		addMember: (canChange, member) =>
			operation(
				"addMember",
				Effect.gen(function* () {
					yield* Transaction;
					const { workspace, bot } = canChange.reach;
					if (!(yield* store.addMember(workspace, bot.value, member.value))) {
						return yield* new NotInWorkspace();
					}
					yield* outbox.publish([reachChanged(workspace, { kind: "bot", botId: bot.value })]);
				}),
			),

		removeMember: (canChange, member) =>
			operation(
				"removeMember",
				Effect.gen(function* () {
					yield* Transaction;
					const { workspace, bot } = canChange.reach;
					const outcome = yield* store.removeMember(workspace, bot.value, member.value);
					switch (outcome) {
						case "removed":
							return yield* outbox.publish([reachNarrowed(workspace)]);
						case "administrator":
							return yield* new AdministratorInEveryPrivateBot();
						case "creator":
							return yield* new CreatorInOwnPrivateBot();
						case "not_a_member":
							return yield* new NotBotMember();
					}
				}),
			),

		beginRemoval: ({ workspace, bot, actor }) =>
			operation(
				"beginRemoval",
				Effect.gen(function* () {
					yield* Transaction;
					yield* BotStore.lockForRemoval(workspace, bot.value, actor.memberId);
					const projectId = yield* defaultProjectOf(bot.value);
					if (yield* projects.markDeleting(workspace, projectId)) {
						yield* outbox.publish([reachChanged(workspace, { kind: "bot", botId: bot.value })]);
					}
					return projectId;
				}),
			),

		remove: ({ workspace, project, targetId: botId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const workspaceId = workspace.value;
					const projectId = project.value;
					yield* Transaction;
					yield* ProjectComputers.lockWithoutComputer({ workspaceId, projectId });
					yield* store.remove(workspaceId, botId).pipe(Effect.orDie);
					yield* outbox.publish([reachChanged(workspaceId, { kind: "bot", botId })]);
				}),
			),

		saveInstructions: (canManage, approved) =>
			operation(
				"saveInstructions",
				Effect.gen(function* () {
					const { workspace, facts, actor } = canManage;
					if (facts.assistantOf !== null) return yield* new AssistantInstructionsManaged();
					const saved = yield* transaction(
						Effect.gen(function* () {
							// Its asker must still manage the bot as the write commits.
							yield* holdTurnOf(approved.principal.value);
							return yield* store.update(workspace, facts.id, {
								instructions: approved.input.instructions,
								description: approved.input.description,
							});
						}),
					).pipe(
						// Only a change of name, handle or visibility refuses these.
						Effect.catchTags({
							BotNameTaken: Effect.die,
							BotHandleReserved: Effect.die,
							SystemBotImmutable: Effect.die,
							PersonalVisibilityFixed: Effect.die,
						}),
					);
					return yield* shown(saved.id, actor);
				}),
			),

		setPinned: (forMember, reach, pinned, approved) =>
			operation(
				"setPinned",
				Effect.gen(function* () {
					const botId = reach.bot.value;
					yield* transaction(
						Effect.gen(function* () {
							yield* holdTurnOf(approved.principal.value);
							yield* store.setPinned({
								workspaceId: reach.workspace,
								memberId: forMember.member,
								botId,
								pinned,
							});
						}),
					);
					return yield* shown(botId, viewerOf(reach));
				}),
			),

		createAssistant: (isMember, canRead) =>
			operation(
				"createAssistant",
				transaction(
					Effect.gen(function* () {
						const workspaceId = canRead.inWorkspace.workspace.value;
						const assistant = yield* personalAssistants.add({
							workspaceId,
							memberId: isMember.member,
						});
						yield* outbox.publish([
							reachChanged(workspaceId, { kind: "bot", botId: assistant.id }),
						]);
						return yield* shown(assistant.id, canRead.actor);
					}),
				),
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
		ProjectStore.layer,
		PersonalAssistants.layer,
	]),
);

/** What a bot's interview writes, which is all it changes of itself in its own chats. */
const INTERVIEW_WRITTEN_FIELDS: ReadonlySet<keyof BotUpdate> = new Set([
	"instructions",
	"description",
]);

/** The fields `changes` sets. */
function changedFields(changes: BotUpdate): (keyof BotUpdate)[] {
	return (Object.keys(changes) as (keyof BotUpdate)[]).filter(
		(field) => changes[field] !== undefined,
	);
}

/**
 * Refuses `changes` to what a Personal Assistant keeps whoever manages it: its
 * instructions, which are Sugabots', and its handle, which tells it apart from
 * its member's others. That it is personal, as every bot that is, never changes.
 */
const refuseAssistantsFixedFields = (changes: BotUpdate) =>
	Effect.gen(function* () {
		const changed = changedFields(changes);
		if (changed.includes("instructions")) return yield* new AssistantInstructionsManaged();
		if (changed.includes("handle")) return yield* new AssistantHandleFixed();
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
