import type { ToolApprovers, WorkspaceRole } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, eq, getColumns, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import type { Executor } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import {
	bot,
	membership,
	placedChat,
	project,
	projectMember,
	workspace,
} from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import {
	type Actor,
	type BotFacts,
	type BotPermission,
	mayInProject,
	mayOnBot,
	type ProjectFacts,
	type ProjectPermission,
	rolesGrantedInProject,
	type WorkspacePermission,
} from "./permissions.ts";

/**
 * The facts every decision about who may do what is made from: the caller's
 * workspace role, and either the project a resource is in and whether a
 * `project_member` row puts them in it, or the bot it belongs to.
 * `Authorization` and `Visibility` load them here and decide with the pure
 * grants in `permissions.ts`; nothing else loads them or turns them into a
 * decision. Standings are only built in this module, so a caller cannot pair
 * a project with somebody else's membership.
 *
 * **Reach** is a stored `project_member` row for a project members made;
 * administrators are put in every one by the triggers described on
 * `projectMember`. A bot is reached by everyone in the workspace when it is
 * public, by its creator alone when it is personal, and by its member alone when
 * it is a Personal Assistant. A bot's default project, where its own chats
 * are, has no members: it is reached through its bot. An automation's feed
 * and its runs are reached as its project is. A system bot's chat is
 * reached by nobody.
 *
 * **Hidden** and **forbidden** are different refusals. A resource the caller
 * cannot reach is hidden, so an id cannot be probed for; a resource they can
 * reach but may not change is forbidden.
 */

/** The caller's standing in a workspace they belong to, so their role is known. */
export interface WorkspaceStanding {
	workspaceId: string;
	actor: Actor & { workspaceRole: WorkspaceRole };
}

/** The caller's standing towards a project. */
export interface ProjectStanding {
	project: schema.ProjectRow;
	actor: Actor;
	/** What the decision was made from, including whether a `project_member` row exists. */
	facts: ProjectFacts;
	/** Whether the caller may also take `permission` on this same project. */
	may(permission: ProjectPermission): boolean;
}

/** The caller's standing towards a bot. */
export interface BotStanding {
	bot: schema.BotRow;
	actor: Actor;
	facts: BotFacts;
	/** Whether the caller may take `permission` on this bot. */
	may(permission: BotPermission): boolean;
}

/**
 * The caller's standing towards a chat they reach: their standing in
 * its project (a chat's, an automation's feed's or a run's).
 */
export interface ChatStanding {
	chat: schema.PlacedChatRow;
	standing: ProjectStanding;
}

/**
 * The resource is not there, or the caller may not know that it is. Answered
 * as `not_found` over HTTP: telling the two apart lets a stranger enumerate
 * ids.
 */
export class ResourceHidden
	extends Data.TaggedError("ResourceHidden")<{
		readonly resource:
			| "workspace"
			| "project"
			| "bot"
			| "chat"
			| "automation"
			| "message"
			| "membership"
			| "invitation"
			| "file";
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`No such ${this.resource}`;
	}
}

/** The caller can see the resource and may not take this action on it. */
export class ActionForbidden
	extends Data.TaggedError("ActionForbidden")<{
		readonly permission: WorkspacePermission | ProjectPermission | BotPermission;
	}>
	implements UserFacing
{
	override get message() {
		return `Lacks the ${this.permission} permission`;
	}
	get userMessage() {
		return userText`You are not allowed to do that`;
	}
}

export type AuthorizationDenied = ResourceHidden | ActionForbidden;

/**
 * The standing, when there is one and its caller reaches the project or bot;
 * otherwise `resource` is hidden, so a refusal never confirms an id.
 */
export function requireReach<Standing extends ProjectStanding | BotStanding>(
	standing: Standing | undefined,
	resource: ResourceHidden["resource"],
): Effect.Effect<Standing, ResourceHidden> {
	const reached =
		standing !== undefined &&
		("project" in standing ? standing.may("project.read") : standing.may("bot.read"));
	return reached ? Effect.succeed(standing) : Effect.fail(new ResourceHidden({ resource }));
}

/**
 * The standing of `actor` towards `row`, a project they have just been put
 * in, by creating it or joining it: they are its member.
 */
export function joinedStanding(row: schema.ProjectRow, actor: Actor): ProjectStanding {
	return projectStanding(row, actor, true, null);
}

/**
 * One member's standing towards one project, from facts already in hand:
 * `defaultOf` is the bot whose default project it is, and must be when it is one.
 */
function projectStanding(
	row: schema.ProjectRow,
	actor: Actor,
	isMember: boolean,
	defaultOf: schema.BotRow | null,
): ProjectStanding {
	const facts: ProjectFacts = { isMember, defaultOf: defaultOf && botFactsOf(defaultOf) };
	return {
		project: row,
		actor,
		facts,
		may: (permission) => mayInProject(actor, permission, facts),
	};
}

function botFactsOf(row: schema.BotRow): BotFacts {
	return { visibility: row.visibility, createdById: row.createdById, assistantOf: row.assistantOf };
}

/** One member's standing towards one bot, from facts already in hand. */
function botStanding(row: schema.BotRow, actor: Actor): BotStanding {
	const facts = botFactsOf(row);
	return { bot: row, actor, facts, may: (permission) => mayOnBot(actor, permission, facts) };
}

/** The bot whose default project a project is, joined beside it. */
const defaultOfBot = alias(bot, "default_of_bot");
const defaultOfBotOfProject = eq(defaultOfBot.id, project.defaultOfBotId);

/**
 * What a project standing is built from, for a query that has `project`: the
 * columns to select, and the joins onto the caller's membership of the
 * workspace and of the project, and onto the bot whose default project it is.
 * Left joins, so a project the caller has no part in is still found, with a
 * standing that permits nothing.
 */
const standingColumns = {
	project,
	role: membership.role,
	projectMemberId: projectMember.id,
	defaultOfBot,
};

const membershipOf = (memberId: string) =>
	and(eq(membership.workspaceId, project.workspaceId), eq(membership.memberId, memberId));

const projectMembershipOf = (memberId: string) =>
	and(eq(projectMember.projectId, project.id), eq(projectMember.memberId, memberId));

type StandingRow = {
	project: schema.ProjectRow;
	role: WorkspaceRole | null;
	projectMemberId: string | null;
	defaultOfBot: schema.BotRow | null;
};

function standingFromRow(row: StandingRow, memberId: string): ProjectStanding {
	return projectStanding(
		row.project,
		{ memberId, workspaceRole: row.role ?? undefined },
		row.projectMemberId !== null,
		row.defaultOfBot,
	);
}

/** `memberId`'s standing in each project `where` picks, whether or not they reach it. */
const standingsWhere = Effect.fn("Access.standingsWhere")(function* (
	db: Executor,
	memberId: string,
	where: SQL | undefined,
) {
	const rows = yield* db
		.select(standingColumns)
		.from(project)
		.leftJoin(membership, membershipOf(memberId))
		.leftJoin(projectMember, projectMembershipOf(memberId))
		.leftJoin(defaultOfBot, defaultOfBotOfProject)
		.where(where);
	return rows.map((row) => standingFromRow(row, memberId));
});

/**
 * The workspace `workspaceRef` names, by its id or its slug, and `memberId`'s
 * role in it. `undefined` when there is no such workspace or they are not in
 * it, which are answered alike.
 */
export const workspaceStandingFor = Effect.fn("Access.workspaceStandingFor")(function* (
	db: Executor,
	workspaceRef: string,
	memberId: string,
) {
	// A uuid is compared as an id, and anything else as a slug, so a malformed
	// id is never handed to Postgres as a uuid.
	const named = isUuid(workspaceRef)
		? eq(workspace.id, workspaceRef)
		: eq(workspace.slug, workspaceRef);
	const [row] = yield* db
		.select({ workspaceId: workspace.id, role: membership.role })
		.from(membership)
		.innerJoin(workspace, eq(workspace.id, membership.workspaceId))
		.where(and(named, eq(membership.memberId, memberId)))
		.limit(1);
	return row
		? { workspaceId: row.workspaceId, actor: { memberId, workspaceRole: row.role } }
		: undefined;
});

/**
 * Everything a decision about one project needs, in one query: the project,
 * the caller's workspace role and whether a `project_member` row puts them in it.
 *
 * `undefined` only when there is no such project. Somebody outside the
 * workspace gets a standing that permits nothing.
 */
export const projectStandingFor = Effect.fn("Access.projectStandingFor")(function* (
	db: Executor,
	projectId: string,
	memberId: string,
) {
	if (!isUuid(projectId)) return undefined;
	const [standing] = yield* standingsWhere(db, memberId, eq(project.id, projectId));
	return standing;
});

/**
 * A bot and `memberId`'s standing towards it, in one query. `undefined` when
 * there is no such bot, or it is a system bot, which nobody addresses.
 */
export const botStandingFor = Effect.fn("Access.botStandingFor")(function* (
	db: Executor,
	botId: string,
	memberId: string,
) {
	if (!isUuid(botId)) return undefined;
	const [row] = yield* db
		.select({ bot, role: membership.role })
		.from(bot)
		.leftJoin(
			membership,
			and(eq(membership.workspaceId, bot.workspaceId), eq(membership.memberId, memberId)),
		)
		.where(and(eq(bot.id, botId), isNull(bot.systemBotKey)))
		.limit(1);
	return row ? botStanding(row.bot, { memberId, workspaceRole: row.role ?? undefined }) : undefined;
});

/**
 * A chat `memberId` reaches, with their standing towards it, in one
 * query. `undefined` when there is no such chat or they do not reach
 * it, which are answered alike.
 */
export const chatStandingFor = Effect.fn("Access.chatStandingFor")(function* (
	db: Executor,
	chatId: string,
	memberId: string,
) {
	if (!isUuid(chatId)) return undefined;
	const [row] = yield* db
		.select({
			chat: getColumns(placedChat),
			project,
			defaultOfBot,
			role: membership.role,
			projectMemberId: projectMember.id,
		})
		.from(placedChat)
		.leftJoin(project, eq(project.id, placedChat.projectId))
		.leftJoin(defaultOfBot, defaultOfBotOfProject)
		.leftJoin(
			membership,
			and(eq(membership.workspaceId, placedChat.workspaceId), eq(membership.memberId, memberId)),
		)
		.leftJoin(projectMember, projectMembershipOf(memberId))
		.where(eq(placedChat.id, chatId))
		.limit(1);
	if (!row) return undefined;
	const actor: Actor = { memberId, workspaceRole: row.role ?? undefined };
	if (!row.project) return undefined;
	const inProject: ChatStanding = {
		chat: row.chat,
		standing: projectStanding(row.project, actor, row.projectMemberId !== null, row.defaultOfBot),
	};
	return inProject.standing.may("project.read") ? inProject : undefined;
});

/**
 * Every project in a workspace that `memberId` reaches, bots' default projects
 * included, each with their standing in it, in one query.
 */
export const projectStandingsFor = Effect.fn("Access.projectStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	memberId: string,
) {
	return yield* standingsWhere(
		db,
		memberId,
		and(eq(project.workspaceId, workspaceId), reachesProjectFor(project.id, memberId)),
	);
});

/**
 * The projects of a workspace `memberId` is in or could join, by name, each with
 * their standing in it, in one query: the public ones, and the private ones
 * they are in. Bots' default projects are never listed.
 */
export const listedProjectStandingsFor = Effect.fn("Access.listedProjectStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	memberId: string,
) {
	const rows = yield* db
		.select({ project, role: membership.role, projectMemberId: projectMember.id })
		.from(project)
		.leftJoin(membership, membershipOf(memberId))
		.leftJoin(projectMember, projectMembershipOf(memberId))
		.where(
			and(
				eq(project.workspaceId, workspaceId),
				isNull(project.defaultOfBotId),
				sql`(${project.visibility} = 'public' or ${projectMember.id} is not null)`,
			),
		)
		.orderBy(asc(project.name));
	return rows.map((row) => standingFromRow({ ...row, defaultOfBot: null }, memberId));
});

/**
 * Whether the caller, who reaches the chat a tool call was raised in, may
 * decide it: the glossary's Approver. A request to change a computer is
 * decided by those who manage the computer's project, the chat's, where the
 * asking turn worked. Any other call is decided by those who reach the chat
 * and hold `approval.decide` in its project, whichever bot asked: a helper's
 * call as any other turn's in the chat.
 *
 * A call raised in an automation's run is decided only by those of them
 * who also manage `runBot`, the bot doing the run (`approval.automation.decide`
 * on it): administrators and the bot's creator, or for a Personal
 * Assistant its member alone. That bot is the default project's own bot for
 * a bot's own automations, and the lead bot when the run started for a
 * project's. Viewers manage no bot, so decide no run's calls.
 *
 * A bot brings its own connectors into the projects it works in, and their
 * calls are decided there too: only a public bot is in a project members
 * made, and whoever decides there may use it.
 *
 * `chatProject` is the caller's standing in the chat's project; undefined
 * when they do not reach the chat. `runBot` is undefined outside a run.
 *
 * The Approvals page and the attention counts select the calls a member
 * may decide in SQL, from the projects and runs' bots this decides for (see
 * `approversIn` in `chats/chats/chat-view.ts`), so a new fact this rule
 * reads must be added to what they select.
 */
export function mayDecideToolCall(
	chatProject: ProjectStanding | undefined,
	runBot: BotFacts | undefined,
	approvers: ToolApprovers,
): boolean {
	if (approvers === "computer-managers") {
		return chatProject?.may("computer.request.decide") ?? false;
	}
	if (!chatProject?.may("approval.decide")) return false;
	return runBot === undefined || mayOnBot(chatProject.actor, "approval.automation.decide", runBot);
}

/**
 * SQL for "`memberId` reaches the project `projectId` names", `memberId` being an
 * id or the column holding one: what `mayInProject(actor, "project.read", …)`
 * decides for one project, written again as a `where` clause. In a project
 * members made, a project member whose role reads projects; in a bot's default project,
 * whoever reaches the bot. The roles come from `rolesGrantedInProject`, but the
 * shape of the rule is repeated here, so a change to `mayInProject`'s shape
 * must be made here too.
 *
 * Aliased throughout, so it composes with a query that already joins any of
 * these tables, and it names the tables of the outer columns it is given, so
 * it can be selected from a query over one table.
 */
export function reachesProjectFor(
	projectId: SQLWrapper,
	memberId: string | SQLWrapper,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${project} as reach_project
		inner join ${membership} as reach_membership
			on reach_membership.workspace_id = reach_project.workspace_id
			and reach_membership.member_id = ${outerColumn(memberId)}
		where reach_project.id = ${outerColumn(projectId)}
			and case when reach_project.default_of_bot_id is null
				then ${roleIsOneOf(ROLES_READING_PROJECTS)} and exists (
					select 1
					from ${projectMember} as reach_project_member
					where reach_project_member.project_id = reach_project.id
						and reach_project_member.member_id = ${outerColumn(memberId)}
				)
				else ${reachesBotFor(sql`reach_project.default_of_bot_id`, memberId)}
			end
	)`;
}

/**
 * SQL selecting the ids of the members who reach the project `projectId`
 * names (see `reachesProjectFor`), one `member_id` column, for an `in (…)`: in a
 * project members made, its members; in a bot's default project, which has
 * none, the workspace's members who reach the bot.
 */
export function membersReachingProject(projectId: SQLWrapper): SQL<string> {
	return sql`select reaching_member.member_id
		from ${membership} as reaching_member
		inner join ${project} as reached_project
			on reached_project.workspace_id = reaching_member.workspace_id
		where reached_project.id = ${outerColumn(projectId)}
			and ${reachesProjectFor(sql`reached_project.id`, sql`reaching_member.member_id`)}`;
}

/**
 * SQL for "`memberId` reaches the bot `botId` names": what `reachesBot`
 * decides for one bot, written again as a `where` clause, so a change to it
 * must be made here too. System bots are reached by nobody.
 */
export function reachesBotFor(botId: SQLWrapper, memberId: string | SQLWrapper): SQL<boolean> {
	return sql`exists (
		select 1
		from ${bot} as reach_bot
		inner join ${membership} as reach_bot_membership
			on reach_bot_membership.workspace_id = reach_bot.workspace_id
			and reach_bot_membership.member_id = ${outerColumn(memberId)}
		where reach_bot.id = ${outerColumn(botId)}
			and reach_bot.system_bot_key is null
			and case
				when reach_bot.assistant_of is not null then reach_bot.assistant_of = ${outerColumn(memberId)}
				when reach_bot.visibility = 'personal' then reach_bot.created_by_id = ${outerColumn(memberId)}
				else true
			end
	)`;
}

/**
 * The columns of a placed chat, or an alias of it, that whether
 * somebody reaches it is decided from.
 */
export interface ChatReachColumns {
	projectId: SQLWrapper;
}

/**
 * SQL for "`memberId` reaches the chat `row`": the project rule for a
 * project's chat, an automation feed and a run, a bot's default project
 * included. A system bot's chat is in no project, so nobody reaches it.
 * Written as SQL for lists, as `chatStandingFor` decides it for one chat.
 */
export function reachesChatFor(row: ChatReachColumns, memberId: string | SQLWrapper): SQL<boolean> {
	return reachesProjectFor(row.projectId, memberId);
}

/** Roles that reach a project once they have been added to it. */
const ROLES_READING_PROJECTS = rolesGrantedInProject("project.read");

/** `false` rather than an empty `in ()`, which is not valid SQL. */
function roleIsOneOf(roles: readonly WorkspaceRole[]): SQL {
	if (roles.length === 0) return sql`false`;
	return sql`reach_membership.role in (${sql.join(
		roles.map((role) => sql`${role}`),
		sql`, `,
	)})`;
}
