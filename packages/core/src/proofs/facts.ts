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
import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import {
	askerOf,
	canWriteBrief,
	hasMemberBounds,
	type TurnFacts,
} from "../authentication/turn-facts.ts";
import { botMemberIds, isBotMember, reachesProjectFor } from "../authorization/access.ts";
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
import type { BotPrincipal, Principal, TurnAdmission, TurnBounds } from "../principal.ts";

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
export interface BotPlace extends Pick<BotFacts, "visibility" | "createdById"> {
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
		? reachFactsWhere(
				db,
				and(eq(project.workspaceId, workspaceId), eq(project.deleting, false)),
				who,
			)
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
				defaultOfHasMember: memberId ? isBotMember(defaultOfBot.id, memberId) : sql<boolean>`false`,
				role: membership.role,
				projectMemberId: projectMember.id,
				botWorkspace: actingBot.workspaceId,
				botVisibility: actingBot.visibility,
				botCreatedBy: actingBot.createdById,
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
									privateMemberId: row.defaultOfHasMember ? memberId : null,
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
export type BotRecord = BotFacts & {
	readonly name: string;
	readonly model: string | null;
	readonly id: string;
	readonly workspace: string;
	readonly systemBot: boolean;
	readonly defaultProject: string | null;
	readonly deleting: boolean;
};

/** The bot `botId`, or `undefined` when there is none. */
export const botRecord = (db: Executor, botId: string, who?: { readonly member?: string }) =>
	isUuid(botId) ? findBotRecord(db, eq(bot.id, botId), who) : Effect.succeed(undefined);

export const findBotRecord = (
	db: Executor,
	where: SQL | undefined,
	who?: { readonly member?: string },
) =>
	Effect.gen(function* () {
		const memberId = who?.member && isUuid(who.member) ? who.member : null;
		const [row] = yield* db
			.select({
				id: bot.id,
				name: bot.name,
				model: bot.model,
				workspace: bot.workspaceId,
				visibility: bot.visibility,
				createdById: bot.createdById,
				assistantOf: bot.assistantOf,
				memberIds: who ? sql<string[]>`'[]'::json` : botMemberIds(bot.id),
				hasMember: memberId ? isBotMember(bot.id, memberId) : sql<boolean>`false`,
				systemBotKey: bot.systemBotKey,
				defaultProject: project.id,
				deleting: project.deleting,
			})
			.from(bot)
			.innerJoin(workspace, and(eq(workspace.id, bot.workspaceId), eq(workspace.deleting, false)))
			.leftJoin(
				project,
				and(eq(project.defaultOfBotId, bot.id), eq(project.workspaceId, bot.workspaceId)),
			)
			.where(where)
			.limit(1);
		if (!row) return undefined;
		const record: BotRecord = {
			id: row.id,
			name: row.name,
			model: row.model,
			workspace: row.workspace,
			visibility: row.visibility,
			createdById: row.createdById,
			assistantOf: row.assistantOf,
			...(who
				? { privateMemberId: row.hasMember ? memberId : null }
				: { memberIds: row.memberIds }),
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
	const { project, member } = useTurnAdmission(principal, facts);
	switch (principal._tag) {
		case "MemberSession":
			return facts.member && memberReaches(facts.member, project)
				? { kind: "reaches", as: { kind: "member", place: facts.member } }
				: hidden;
		case "BotForAsker": {
			const reach = decideTurnProjectReach(principal, facts, member);
			if (!member || reach === "hidden") return hidden;
			if (reach === "botCannotReach") return { kind: reach };
			return {
				kind: "reaches",
				as: {
					kind: "asker",
					place: member,
					bot: principal.bot,
					turn: principal.turn,
					bounds: principal.bounds,
				},
			};
		}
		case "AutomationRun": {
			const reach = decideTurnProjectReach(principal, facts, undefined);
			if (reach !== "reaches") return { kind: reach };
			return { kind: "reaches", as: { kind: "run", bot: principal.bot, turn: principal.turn } };
		}
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

export function useTurnAdmission(principal: Principal, facts: ReachFacts): ReachFacts {
	if (
		principal._tag !== "BotForAsker" ||
		!principal.admission ||
		principal.workspace !== facts.project.workspace
	)
		return facts;
	const admitted = principal.admission.projects[facts.project.id];
	if (!admitted) return { ...facts, member: undefined };
	return {
		...facts,
		project: { ...facts.project, defaultOf: admitted.project.defaultOf },
		member: {
			actor: actorOf(principal.asker, principal.admission.role ?? undefined),
			inProject: admitted.inProject,
		},
	};
}

export function botAtAdmission(principal: Principal, record: BotRecord): BotRecord | undefined {
	if (
		principal._tag !== "BotForAsker" ||
		!principal.admission ||
		principal.workspace !== record.workspace
	)
		return record;
	const saved =
		record.defaultProject && principal.admission.projects[record.defaultProject]?.project.defaultOf;
	return saved ? { ...record, ...saved } : undefined;
}

function decideTurnProjectReach(
	principal: BotPrincipal,
	{ project, bot }: ReachFacts,
	member: MemberPlace | undefined,
): ReachDecision["kind"] {
	if (principal.workspace !== project.workspace) return "hidden";
	const admitted = admittedProjectReach(principal, project.id);
	if (admitted !== undefined) return admitted;
	if (principal.bounds.kind === "chat" && principal.bounds.project !== project.id) return "hidden";
	if (principal._tag === "BotForAsker" && !memberReaches(member, project)) return "hidden";
	return botReaches(bot, project, member) ? "reaches" : "botCannotReach";
}

export function admittedProjectReach(
	principal: BotPrincipal,
	projectId: string,
): ReachDecision["kind"] | undefined {
	if (!principal.admission) return undefined;
	if (principal.bounds.kind === "chat" && principal.bounds.project !== projectId) return "hidden";
	const admitted = principal.admission.projects[projectId];
	if (!admitted || (principal._tag === "BotForAsker" && !admitted.memberReaches)) return "hidden";
	return admitted.botReaches ? "reaches" : "botCannotReach";
}

export const captureTurnAdmission = (db: Executor, facts: TurnFacts) =>
	Effect.gen(function* () {
		const asker = askerOf(facts);
		if (
			!facts.project ||
			(asker === undefined && (facts.askedBy.kind !== "automation" || !facts.run))
		)
			return null;
		const who = { member: asker, bot: facts.bot };
		const home = yield* reachFacts(db, facts.project, who);
		if (!home || !botReaches(home.bot, home.project, home.member)) return null;
		if (asker !== undefined && !memberReaches(home.member, home.project)) return null;

		const memberBounds = hasMemberBounds(facts, asker);
		const mayBrief = facts.askedBy.kind === "member" && canWriteBrief(facts.reason);
		const placedBots = memberBounds
			? []
			: yield* db
					.select({ id: projectBot.botId })
					.from(projectBot)
					.where(eq(projectBot.projectId, facts.project));
		const chatProjectBotIds = memberBounds
			? []
			: [...new Set([facts.bot, home.project.leadBot, ...placedBots.map(({ id }) => id)])];

		// A brief may go to a bot's default project outside the turn's chat bounds.
		const projectScope = memberBounds
			? undefined
			: mayBrief
				? isNotNull(project.defaultOfBotId)
				: inArray(project.defaultOfBotId, chatProjectBotIds);
		const places =
			asker === undefined
				? []
				: yield* reachFactsWhere(
						db,
						and(
							eq(project.workspaceId, facts.workspace),
							eq(project.deleting, false),
							ne(project.id, facts.project),
							or(
								and(reachesProjectFor(project.id, asker), projectScope),
								// A member in these bounds can manage a bot they cannot talk to.
								memberBounds && home.member && administers(home.member.actor)
									? and(ne(defaultOfBot.visibility, "personal"), isNull(defaultOfBot.systemBotKey))
									: undefined,
							),
						),
						who,
					);
		const admission: TurnAdmission = {
			role: home.member?.actor.workspaceRole ?? null,
			chatProjectBotIds,
			projects: Object.fromEntries(
				[home, ...places].map(({ project, member, bot }) => [
					project.id,
					{
						project: { defaultOf: project.defaultOf },
						inProject: member?.inProject ?? false,
						memberReaches: memberReaches(member, project),
						botReaches: botReaches(bot, project, member),
					},
				]),
			),
		};
		return admission;
	});

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

/**
 * The places of the turn's asker and bot in its chat's project, while both can
 * still use its chat; undefined once either can't.
 */
export const turnChatPlace = (db: Executor, facts: TurnFacts) =>
	Effect.gen(function* () {
		if (!facts.project) return undefined;
		const asker = askerOf(facts);
		if (asker === undefined && (facts.askedBy.kind !== "automation" || !facts.run))
			return undefined;
		const place = yield* reachFacts(db, facts.project, {
			...(asker && !facts.admission && { member: asker }),
			bot: facts.bot,
		});
		if (!place) return undefined;
		const admitted = facts.admission?.projects[facts.project];
		if (facts.admission) {
			if (!admitted?.botReaches || (asker !== undefined && !admitted.memberReaches))
				return undefined;
			return {
				...place,
				project: { ...place.project, defaultOf: admitted.project.defaultOf },
				member:
					asker === undefined
						? undefined
						: {
								actor: actorOf(asker, facts.admission.role ?? undefined),
								inProject: admitted.inProject,
							},
			};
		}
		if (asker !== undefined && !memberReaches(place.member, place.project)) return undefined;
		return botReaches(place.bot, place.project, place.member) ? place : undefined;
	});
