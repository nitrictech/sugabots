/**
 * What the provers decide from: a project with its workspace, and the places
 * in it of the member and the bot a principal stands for, loaded in one
 * query; and the rules that turn those facts into reach and permissions.
 *
 * The rules come from the grant tables in `authorization/permissions.ts`,
 * except where the architecture docs differ from them, which each rule here
 * says. Nothing in this file makes a proof: each prover's own file does. What
 * the API tells a member they may do is decided by these rules too
 * (`shown-permissions.ts`).
 */

import type { ProjectVisibility, WorkspaceRole } from "@sugabots/contracts";
import { and, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { askerOf, type TurnFacts } from "../authentication/turn-facts.ts";
import { botMemberIds } from "../authorization/access.ts";
import {
	type Actor,
	type BotFacts,
	managesEveryBot,
	mayInProject,
	mayOnBot,
	type ProjectPermission,
	personalBotCreator,
	reachesBot,
} from "../authorization/permissions.ts";
import type { Executor } from "../database/database.ts";
import {
	bot,
	membership,
	project,
	projectBot,
	projectMember,
	workspace,
} from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import { isUuid } from "../ids/ids.ts";
import type { Principal, TurnBounds } from "../principal.ts";

/** A project as reach is decided: its workspace and lead bot, and on a bot's default project, that bot. */
export interface ProjectFacts {
	readonly id: string;
	readonly workspace: string;
	readonly leadBot: string;
	/** Whether anyone in the workspace may find and join it, or only those invited. */
	readonly visibility: ProjectVisibility;
	readonly defaultOf: (BotFacts & { readonly id: string }) | null;
}

/** A member's role in a project's workspace, if they are in it, and whether they are in the project. */
export interface MemberPlace {
	readonly actor: Actor;
	readonly inProject: boolean;
}

/** A bot's place: its workspace, whether the project has it, and who it is for if it is personal. */
export interface BotPlace extends BotFacts {
	readonly id: string;
	readonly workspace: string;
	readonly inProject: boolean;
	readonly usesComputer: boolean;
	readonly deleting: boolean;
}

export interface ReachFacts {
	readonly project: ProjectFacts;
	readonly member: MemberPlace | undefined;
	readonly bot: BotPlace | undefined;
}

const defaultOfBot = alias(bot, "reach_default_of_bot");
const actingBot = alias(bot, "reach_acting_bot");

/**
 * A project, which `projectId` names as an id or a subquery, with the places
 * in it of `who.member` and `who.bot`, in one query. `undefined` when there is
 * no such project.
 */
export const reachFacts = (
	db: Executor,
	projectId: string | SQL,
	who: { readonly member?: string; readonly bot?: string },
	forDeletion = false,
	contains?: SQL,
) =>
	Effect.gen(function* () {
		if (typeof projectId === "string" && !isUuid(projectId)) return undefined;
		const [facts] = yield* reachFactsWhere(
			db,
			and(
				eq(project.id, projectId),
				forDeletion ? undefined : eq(project.deleting, false),
				contains,
			),
			who,
			1,
		);
		return facts;
	});

/**
 * Every project of the workspace `workspaceId`, bots' default projects
 * included, with the places in each of `who.member` and `who.bot`, in one
 * query: what a list decides each project's rules from.
 */
export const reachFactsIn = (
	db: Executor,
	workspaceId: string,
	who: { readonly member?: string; readonly bot?: string },
) =>
	isUuid(workspaceId)
		? reachFactsWhere(db, eq(project.workspaceId, workspaceId), who)
		: Effect.succeed([]);

/** The projects `where` picks, each with the places in it of `who.member` and `who.bot`. */
const reachFactsWhere = (
	db: Executor,
	where: SQL | undefined,
	who: { readonly member?: string; readonly bot?: string },
	limit?: number,
) =>
	Effect.gen(function* () {
		const memberId = who.member && isUuid(who.member) ? who.member : null;
		const botId = who.bot && isUuid(who.bot) ? who.bot : null;
		const selected = db
			.select({
				id: project.id,
				workspace: project.workspaceId,
				leadBot: project.leadBotId,
				visibility: project.visibility,
				defaultOfId: defaultOfBot.id,
				defaultOfVisibility: defaultOfBot.visibility,
				defaultOfCreatedBy: defaultOfBot.createdById,
				defaultOfAssistantOf: defaultOfBot.assistantOf,
				defaultOfMemberIds: botMemberIds(defaultOfBot.id),
				role: membership.role,
				projectMemberId: projectMember.id,
				botWorkspace: actingBot.workspaceId,
				botVisibility: actingBot.visibility,
				botCreatedBy: actingBot.createdById,
				botAssistantOf: actingBot.assistantOf,
				botMemberIds: botMemberIds(actingBot.id),
				botUsesComputer: actingBot.usesComputer,
				botDeleting: botRemovalStarted(actingBot.id),
				botInProject: sql<boolean>`exists (
					select 1 from ${projectBot}
					where ${projectBot.projectId} = ${project.id} and ${projectBot.botId} = ${botId}::uuid
				)`,
			})
			.from(project)
			.innerJoin(
				workspace,
				and(eq(workspace.id, project.workspaceId), eq(workspace.deleting, false)),
			)
			.leftJoin(defaultOfBot, eq(defaultOfBot.id, project.defaultOfBotId))
			.leftJoin(
				membership,
				and(
					eq(membership.workspaceId, project.workspaceId),
					eq(membership.leaving, false),
					eq(membership.memberId, sql`${memberId}::uuid`),
				),
			)
			.leftJoin(
				projectMember,
				and(
					eq(projectMember.projectId, project.id),
					eq(projectMember.memberId, sql`${memberId}::uuid`),
				),
			)
			.leftJoin(actingBot, eq(actingBot.id, sql`${botId}::uuid`))
			.where(where)
			.$dynamic();
		const rows = yield* limit === undefined ? selected : selected.limit(limit);
		return rows.map(
			(row): ReachFacts => ({
				project: {
					id: row.id,
					workspace: row.workspace,
					leadBot: row.leadBot,
					visibility: row.visibility,
					defaultOf:
						row.defaultOfId && row.defaultOfVisibility
							? {
									id: row.defaultOfId,
									visibility: row.defaultOfVisibility,
									createdById: row.defaultOfCreatedBy,
									assistantOf: row.defaultOfAssistantOf,
									memberIds: row.defaultOfMemberIds,
								}
							: null,
				},
				member: memberId
					? {
							actor: { memberId, workspaceRole: row.role ?? undefined },
							inProject: row.projectMemberId !== null,
						}
					: undefined,
				bot:
					botId && row.botWorkspace && row.botVisibility
						? {
								id: botId,
								workspace: row.botWorkspace,
								inProject: row.botInProject,
								visibility: row.botVisibility,
								createdById: row.botCreatedBy,
								assistantOf: row.botAssistantOf,
								memberIds: row.botMemberIds,
								usesComputer: row.botUsesComputer ?? false,
								deleting: row.botDeleting,
							}
						: undefined,
			}),
		);
	});

/** `memberId`'s role in `workspaceId`, or `undefined` when they aren't in it. */
export const roleIn = (db: Executor, workspaceId: string, memberId: string) =>
	Effect.gen(function* () {
		if (!isUuid(workspaceId) || !isUuid(memberId)) return undefined;
		const [row] = yield* db
			.select({ role: membership.role })
			.from(membership)
			.where(
				and(
					eq(membership.workspaceId, workspaceId),
					eq(membership.memberId, memberId),
					eq(membership.leaving, false),
				),
			)
			.limit(1);
		return row?.role;
	});

/** A bot as its managers and reachers are decided, with its workspace. */
export interface BotRecord extends BotFacts {
	readonly id: string;
	readonly workspace: string;
	readonly systemBot: boolean;
	readonly defaultProject: string | null;
	readonly deleting: boolean;
}

/** The bot `botId`, or `undefined` when there is none. */
export const botRecord = (db: Executor, botId: string) =>
	Effect.gen(function* () {
		if (!isUuid(botId)) return undefined;
		const [row] = yield* db
			.select({
				id: bot.id,
				workspace: bot.workspaceId,
				visibility: bot.visibility,
				createdById: bot.createdById,
				assistantOf: bot.assistantOf,
				memberIds: botMemberIds(bot.id),
				systemBotKey: bot.systemBotKey,
				defaultProject: project.id,
				deleting: project.deleting,
			})
			.from(bot)
			.leftJoin(
				project,
				and(eq(project.defaultOfBotId, bot.id), eq(project.workspaceId, bot.workspaceId)),
			)
			.where(eq(bot.id, botId))
			.limit(1);
		if (!row) return undefined;
		const record: BotRecord = {
			id: row.id,
			workspace: row.workspace,
			visibility: row.visibility,
			createdById: row.createdById,
			assistantOf: row.assistantOf,
			memberIds: row.memberIds,
			systemBot: row.systemBotKey !== null,
			defaultProject: row.defaultProject,
			deleting: row.deleting ?? false,
		};
		return record;
	});

/**
 * Whether the bot `botId` is one the project `projectId` has: its lead, one
 * of its bots, or on a default project its own bot.
 */
export const projectHasBot = (db: Executor, projectId: string, botId: string) =>
	Effect.gen(function* () {
		if (!isUuid(projectId) || !isUuid(botId)) return false;
		const [row] = yield* db
			.select({
				has: sql<boolean>`${project.leadBotId} = ${botId}::uuid
					or ${project.defaultOfBotId} = ${botId}::uuid
					or exists (
						select 1 from ${projectBot}
						where ${projectBot.projectId} = ${outerColumn(project.id)} and ${projectBot.botId} = ${botId}::uuid
					)`,
			})
			.from(project)
			.where(eq(project.id, projectId))
			.limit(1);
		return row?.has ?? false;
	});

/** Whether `place`'s member reaches the project: as `project.read` decides, by role and place. */
export function memberReaches(place: MemberPlace | undefined, project: ProjectFacts): boolean {
	return place !== undefined && mayInProjectAs(place, project, "project.read");
}

/** Whether `place`'s member may take `permission` in the project, by the grant tables. */
export function mayInProjectAs(
	place: MemberPlace,
	project: ProjectFacts,
	permission: ProjectPermission,
): boolean {
	return mayInProject(place.actor, permission, {
		isMember: place.inProject,
		defaultOf: project.defaultOf,
	});
}

/**
 * Whether the bot reaches the project: one it is in or leads, and its own
 * default project. A personal bot reaches what its creator reaches, so only
 * acting for them.
 */
function botReaches(
	place: BotPlace | undefined,
	project: ProjectFacts,
	asker: MemberPlace | undefined,
): boolean {
	if (!place || place.deleting || place.workspace !== project.workspace) return false;
	if (place.visibility === "personal") {
		const creator = personalBotCreator(place);
		return creator !== null && creator === asker?.actor.memberId && memberReaches(asker, project);
	}
	return project.defaultOf?.id === place.id || place.inProject || project.leadBot === place.id;
}

/**
 * Whether `actor` is one of the bot's managers: its creator, while they reach
 * it, unless they are now a viewer and it isn't their Personal Assistant, and
 * an admin, for a bot that isn't personal. The grant tables' `bot.update` also
 * lets an admin manage a personal bot; the docs leave an admin only
 * restricting one, which `CanRestrictBot` proves.
 */
export function managesBot(actor: Actor, bot: BotFacts): boolean {
	const updates = mayOnBot(actor, "bot.update", bot);
	if (bot.visibility !== "personal") return updates;
	return updates && bot.createdById === actor.memberId;
}

/**
 * Whether `place`'s member manages the project: in a project members made, by
 * `project.update`, the owner and admins; in a bot's default project, the
 * bot's managers.
 */
export function managesProject(place: MemberPlace, project: ProjectFacts): boolean {
	return project.defaultOf
		? managesBot(place.actor, project.defaultOf)
		: mayInProjectAs(place, project, "project.update");
}

/** Whether `actor` is one of the workspace's administrators: its owner or an admin. */
export function administers(actor: Actor): boolean {
	return managesEveryBot(actor);
}

/** Whether `actor` may see and talk to the bot. Nobody reaches a system bot. */
export function memberReachesBot(
	actor: Actor,
	bot: BotFacts & { readonly systemBot: boolean },
): boolean {
	return !bot.systemBot && reachesBot(actor, bot);
}

/**
 * Whether `actor` may restrict the bot: delete it or switch off its
 * automations and connectors, without reaching it, as an admin does another
 * member's personal bot, a Personal Assistant included. A system bot can't be
 * restricted.
 */
export function restrictsBot(actor: Actor, bot: { readonly systemBot: boolean }): boolean {
	return administers(actor) && !bot.systemBot;
}

/** The actor `memberId` is, with `role` in the workspace. */
export function actorOf(memberId: string, role: WorkspaceRole | undefined): Actor {
	return { memberId, workspaceRole: role };
}

/**
 * Whose permissions a principal has where it reaches, which the permissions
 * proved from a reach are decided from.
 *
 * - `member`: a member signed in, with their role and place.
 * - `asker`: a bot acting for its asker, within its bounds, with the asker's
 *   role and place.
 * - `run`: a bot in an automation's run, which may do what its bot reaches
 *   there but manage nothing.
 * - `webhook` and `systemWork`: what signed the call, or the stored work,
 *   which reach only what they name and hold no permission there.
 */
export type ReachedAs =
	| { readonly kind: "member"; readonly place: MemberPlace }
	| {
			readonly kind: "asker";
			readonly place: MemberPlace;
			readonly bot: string;
			readonly turn: string;
			readonly bounds: TurnBounds;
	  }
	| { readonly kind: "run"; readonly bot: string; readonly turn: string }
	| { readonly kind: "webhook" }
	| { readonly kind: "systemWork" };

/** Whether a principal reaches a project or a chat in it, and as whom. */
type ReachDecision =
	| { readonly kind: "reaches"; readonly as: ReachedAs }
	| { readonly kind: "hidden" }
	| { readonly kind: "botCannotReach" };

const hidden: ReachDecision = { kind: "hidden" };

/**
 * Whether `principal` reaches the project `facts` describe, or `chat` in it:
 * bounds first, then the asker, then the bot, so anything outside a turn's
 * bounds is hidden whatever its asker reaches, and the bot falling short
 * arises only inside them. Every principal must be of the project's workspace.
 */
export function decideReach(
	principal: Principal,
	facts: ReachFacts,
	chat: string | undefined,
): ReachDecision {
	const { project } = facts;
	switch (principal._tag) {
		case "MemberSession":
			return facts.member && memberReaches(facts.member, project)
				? { kind: "reaches", as: { kind: "member", place: facts.member } }
				: hidden;
		case "BotForAsker": {
			if (principal.workspace !== project.workspace) return hidden;
			if (principal.bounds.kind === "chat" && principal.bounds.project !== project.id)
				return hidden;
			if (!facts.member || !memberReaches(facts.member, project)) return hidden;
			if (!botReaches(facts.bot, project, facts.member)) return { kind: "botCannotReach" };
			return {
				kind: "reaches",
				as: {
					kind: "asker",
					place: facts.member,
					bot: principal.bot,
					turn: principal.turn,
					bounds: principal.bounds,
				},
			};
		}
		case "AutomationRun":
			if (principal.workspace !== project.workspace) return hidden;
			if (principal.bounds.project !== project.id) return hidden;
			if (!botReaches(facts.bot, project, undefined)) return { kind: "botCannotReach" };
			return { kind: "reaches", as: { kind: "run", bot: principal.bot, turn: principal.turn } };
		case "WebhookCall":
			return hidden;
		case "SystemWork":
			return principal.workspace === project.workspace &&
				principal.work.kind === "compaction" &&
				principal.work.chat === chat
				? { kind: "reaches", as: { kind: "systemWork" } }
				: hidden;
		case "PageAddress":
			return hidden;
	}
}

/** The member and bot a principal stands for, whose places a reach query loads. */
export function whoActs(principal: Principal): { readonly member?: string; readonly bot?: string } {
	switch (principal._tag) {
		case "MemberSession":
			return { member: principal.member };
		case "BotForAsker":
			return { member: principal.asker, bot: principal.bot };
		case "AutomationRun":
			return { bot: principal.bot };
		default:
			return {};
	}
}

/**
 * The member whose permissions apply where a principal reaches, if any: a
 * member signed in, or a bot's asker. A run, a webhook and system work act for
 * no member.
 */
export function memberActing(as: ReachedAs): MemberPlace | undefined {
	return as.kind === "member" || as.kind === "asker" ? as.place : undefined;
}

/** Bot removal starts by marking its default project for deletion. */
export const botRemovalStarted = (botId: SQLWrapper) =>
	sql<boolean>`exists (
		select 1 from ${project} as removing_bot_project
		where removing_bot_project.default_of_bot_id = ${outerColumn(botId)}
			and removing_bot_project.deleting
	)`;

/** Whether the turn's bot and the member it acts for can still use its chat. */
export const turnReachesChat = (db: Executor, facts: TurnFacts) =>
	Effect.gen(function* () {
		if (!facts.project) return false;
		const asker = askerOf(facts);
		if (asker === undefined && (facts.askedBy.kind !== "automation" || !facts.run)) return false;
		const place = yield* reachFacts(db, facts.project, {
			...(asker && { member: asker }),
			bot: facts.bot,
		});
		return (
			place !== undefined &&
			(asker === undefined || memberReaches(place.member, place.project)) &&
			botReaches(place.bot, place.project, place.member)
		);
	});
