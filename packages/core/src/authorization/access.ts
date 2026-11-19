import type { ToolApprovalDeciders, WorkspaceRole } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import {
	and,
	asc,
	eq,
	getColumns,
	inArray,
	isNull,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import type { Executor } from "../database/database.ts";
import type * as schema from "../database/schema.ts";
import {
	bot,
	directMessageMember,
	placedConversation,
	project,
	projectMember,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import { isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";
import { defaultProjectIdOf } from "../workspaces/bots/bot.ts";
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
 * **Reach** is a stored `project_member` row for a project people made;
 * administrators are put in every one by the triggers described on
 * `projectMember`. A bot is reached by everyone in the workspace when it is
 * public, by its creator alone when it is private, and by its person alone when
 * it is a Personal Assistant. A bot's default project, where its own threads
 * are, has no members: it is reached through its bot. An automation's feed
 * and its runs are reached as its project is. A collaboration is reached as the conversation it was opened from,
 * whichever bot was asked, so asking a private bot shows its answer to the
 * people of that conversation and nobody else. A direct message between people
 * is reached through a `direct_message_member` row while its person is in the
 * workspace, whatever their role. A system bot's conversation is reached by nobody.
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
 * The caller's standing towards a conversation they reach: a conversation in
 * a project (a thread, an automation's feed or a run) by their standing in the
 * project, and a direct message, being in which permits only reading it and
 * writing in it. A collaboration's standing is the one towards the
 * conversation it was opened from, not towards the bot that was asked.
 */
export type ConversationStanding =
	| { kind: "project"; conversation: schema.PlacedConversationRow; standing: ProjectStanding }
	| { kind: "direct_message"; conversation: schema.PlacedConversationRow };

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
			| "conversation"
			| "automation"
			| "message"
			| "turn"
			| "member"
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
 * One person's standing towards one project, from facts already in hand:
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

/** One person's standing towards one bot, from facts already in hand. */
function botStanding(row: schema.BotRow, actor: Actor): BotStanding {
	const facts = botFactsOf(row);
	return { bot: row, actor, facts, may: (permission) => mayOnBot(actor, permission, facts) };
}

/** The bot whose default project a project is, joined beside it. */
const defaultBot = alias(bot, "default_bot");
const defaultBotOfProject = eq(defaultBot.id, project.defaultOfBotId);

/**
 * What a project standing is built from, for a query that has `project`: the
 * columns to select, and the joins onto the caller's membership of the
 * workspace and of the project, and onto the bot whose default project it is.
 * Left joins, so a project the caller has no part in is still found, with a
 * standing that permits nothing.
 */
const standingColumns = {
	project,
	role: workspaceMember.role,
	membershipId: projectMember.id,
	defaultBot,
};

const workspaceMembershipOf = (userId: string) =>
	and(eq(workspaceMember.workspaceId, project.workspaceId), eq(workspaceMember.userId, userId));

const projectMembershipOf = (userId: string) =>
	and(eq(projectMember.projectId, project.id), eq(projectMember.userId, userId));

type StandingRow = {
	project: schema.ProjectRow;
	role: WorkspaceRole | null;
	membershipId: string | null;
	defaultBot: schema.BotRow | null;
};

function standingFromRow(row: StandingRow, userId: string): ProjectStanding {
	return projectStanding(
		row.project,
		{ userId, workspaceRole: row.role ?? undefined },
		row.membershipId !== null,
		row.defaultBot,
	);
}

/** `userId`'s standing in each project `where` picks, whether or not they reach it. */
const standingsWhere = Effect.fn("Access.standingsWhere")(function* (
	db: Executor,
	userId: string,
	where: SQL | undefined,
) {
	const rows = yield* db
		.select(standingColumns)
		.from(project)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(projectMember, projectMembershipOf(userId))
		.leftJoin(defaultBot, defaultBotOfProject)
		.where(where);
	return rows.map((row) => standingFromRow(row, userId));
});

/**
 * The workspace `workspaceRef` names, by its id or its slug, and `userId`'s
 * role in it. `undefined` when there is no such workspace or they are not in
 * it, which are answered alike.
 */
export const workspaceStandingFor = Effect.fn("Access.workspaceStandingFor")(function* (
	db: Executor,
	workspaceRef: string,
	userId: string,
) {
	// A uuid is compared as an id, and anything else as a slug, so a malformed
	// id is never handed to Postgres as a uuid.
	const named = isUuid(workspaceRef)
		? eq(workspace.id, workspaceRef)
		: eq(workspace.slug, workspaceRef);
	const [row] = yield* db
		.select({ workspaceId: workspace.id, role: workspaceMember.role })
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(and(named, eq(workspaceMember.userId, userId)))
		.limit(1);
	return row
		? { workspaceId: row.workspaceId, actor: { userId, workspaceRole: row.role } }
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
	userId: string,
) {
	if (!isUuid(projectId)) return undefined;
	const [standing] = yield* standingsWhere(db, userId, eq(project.id, projectId));
	return standing;
});

/**
 * `userId`'s standing in each of the projects `projectIds`, whether or not
 * they reach it, as `projectStandingFor` gives one, in one query.
 */
export const projectStandingsOf = Effect.fn("Access.projectStandingsOf")(function* (
	db: Executor,
	projectIds: readonly string[],
	userId: string,
) {
	const ids = projectIds.filter(isUuid);
	if (ids.length === 0) return [];
	return yield* standingsWhere(db, userId, inArray(project.id, ids));
});

/**
 * A bot and `userId`'s standing towards it, in one query. `undefined` when
 * there is no such bot, or it is a system bot, which nobody addresses.
 */
export const botStandingFor = Effect.fn("Access.botStandingFor")(function* (
	db: Executor,
	botId: string,
	userId: string,
) {
	if (!isUuid(botId)) return undefined;
	const [row] = yield* db
		.select({ bot, role: workspaceMember.role })
		.from(bot)
		.leftJoin(
			workspaceMember,
			and(eq(workspaceMember.workspaceId, bot.workspaceId), eq(workspaceMember.userId, userId)),
		)
		.where(and(eq(bot.id, botId), isNull(bot.systemBotKey)))
		.limit(1);
	return row ? botStanding(row.bot, { userId, workspaceRole: row.role ?? undefined }) : undefined;
});

/**
 * A conversation `userId` reaches, with their standing towards it, in one
 * query. `undefined` when there is no such conversation or they do not reach
 * it, which are answered alike.
 */
export const conversationStandingFor = Effect.fn("Access.conversationStandingFor")(function* (
	db: Executor,
	conversationId: string,
	userId: string,
) {
	if (!isUuid(conversationId)) return undefined;
	// A collaboration is reached through the conversation it was opened from,
	// so its project is that conversation's.
	const reachedThrough = alias(placedConversation, "reached_through");
	const reachProjectId = sql<
		string | null
	>`coalesce(${reachedThrough.projectId}, ${placedConversation.projectId})`;
	const [row] = yield* db
		.select({
			conversation: getColumns(placedConversation),
			project,
			defaultBot,
			role: workspaceMember.role,
			membershipId: projectMember.id,
			inDirectMessage: reachesDirectMessageFor(placedConversation, userId),
		})
		.from(placedConversation)
		.leftJoin(
			reachedThrough,
			and(
				eq(placedConversation.kind, "collaboration"),
				eq(reachedThrough.id, placedConversation.rootConversationId),
			),
		)
		.leftJoin(project, eq(project.id, reachProjectId))
		.leftJoin(defaultBot, defaultBotOfProject)
		.leftJoin(
			workspaceMember,
			and(
				eq(workspaceMember.workspaceId, placedConversation.workspaceId),
				eq(workspaceMember.userId, userId),
			),
		)
		.leftJoin(projectMember, projectMembershipOf(userId))
		.where(eq(placedConversation.id, conversationId))
		.limit(1);
	if (!row) return undefined;
	const actor: Actor = { userId, workspaceRole: row.role ?? undefined };
	if (row.project) {
		const inProject: ConversationStanding = {
			kind: "project",
			conversation: row.conversation,
			standing: projectStanding(row.project, actor, row.membershipId !== null, row.defaultBot),
		};
		return inProject.standing.may("project.read") ? inProject : undefined;
	}
	if (row.conversation.kind !== "direct_message") return undefined;
	const direct: ConversationStanding = { kind: "direct_message", conversation: row.conversation };
	return row.inDirectMessage ? direct : undefined;
});

/**
 * `userId`'s standing in the project whose computer a turn of `turnBotId` in
 * the conversation `conversationId` works on (see `computerProjectIdOf`), which
 * decides that turn's requests to change the computer. `undefined` when there
 * is no such conversation or project.
 */
export const computerProjectStandingFor = Effect.fn("Access.computerProjectStandingFor")(function* (
	db: Executor,
	conversationId: string,
	turnBotId: string,
	userId: string,
) {
	if (!isUuid(conversationId) || !isUuid(turnBotId)) return undefined;
	const [row] = yield* db
		.select({ projectId: computerProjectIdOf(placedConversation, sql`${turnBotId}::uuid`) })
		.from(placedConversation)
		.where(eq(placedConversation.id, conversationId))
		.limit(1);
	return row?.projectId ? yield* projectStandingFor(db, row.projectId, userId) : undefined;
});

/**
 * Every project in a workspace that `userId` reaches, bots' default projects
 * included, each with their standing in it, in one query.
 */
export const projectStandingsFor = Effect.fn("Access.projectStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	return yield* standingsWhere(
		db,
		userId,
		and(eq(project.workspaceId, workspaceId), reachesProjectFor(project.id, userId)),
	);
});

/**
 * The projects of a workspace `userId` is in or could join, by name, each with
 * their standing in it, in one query: the public ones, and the private ones
 * they are in. Bots' default projects are never listed.
 */
export const listedProjectStandingsFor = Effect.fn("Access.listedProjectStandingsFor")(function* (
	db: Executor,
	workspaceId: string,
	userId: string,
) {
	const rows = yield* db
		.select({ project, role: workspaceMember.role, membershipId: projectMember.id })
		.from(project)
		.leftJoin(workspaceMember, workspaceMembershipOf(userId))
		.leftJoin(projectMember, projectMembershipOf(userId))
		.where(
			and(
				eq(project.workspaceId, workspaceId),
				isNull(project.defaultOfBotId),
				sql`(${project.visibility} = 'public' or ${projectMember.id} is not null)`,
			),
		)
		.orderBy(asc(project.name));
	return rows.map((row) => standingFromRow({ ...row, defaultBot: null }, userId));
});

/**
 * Whether the caller, who reaches the conversation a tool call was raised in, may
 * decide it. A request to change a computer is decided by those who manage
 * the computer's project, wherever it was raised: `computerProject` is the
 * caller's standing in the project whose computer the asking turn used (see
 * `computerProjectIdOf`), if they have one. Any other call is decided by the
 * conversation's people: those holding `approval.decide` in its project, and
 * `approval.automation.decide` as well for a call raised while an automation
 * runs. For a collaboration that is the project of the conversation it was
 * opened from, whichever bot asked.
 *
 * A bot brings its own connections into the projects it works in, and their
 * calls are decided there too: only a public bot is in a project people
 * made, and whoever decides there may use it.
 *
 * `reached` is the caller's standing towards the conversation, which a
 * `ConversationStanding` is; undefined when they have none.
 */
export function mayDecideToolCall(
	reached: DecidingStanding | undefined,
	computerProject: ProjectStanding | undefined,
	inAutomation: boolean,
	deciders: ToolApprovalDeciders,
): boolean {
	if (deciders === "computer-managers") {
		return computerProject?.may("computer.request.decide") ?? false;
	}
	if (reached?.kind !== "project") return false;
	const needed = inAutomation
		? (["approval.decide", "approval.automation.decide"] as const)
		: (["approval.decide"] as const);
	return needed.every((permission) => reached.standing.may(permission));
}

/** What `mayDecideToolCall` reads of a caller's standing towards a conversation. */
type DecidingStanding = { kind: "project"; standing: ProjectStanding } | { kind: "direct_message" };

/**
 * SQL for the project whose computer a turn of `turnBotId` in the conversation
 * `row` works on: the conversation's project, or in a collaboration the bot's
 * own default project, as a turn's `projectId` is chosen.
 */
export function computerProjectIdOf(
	row: { kind: SQLWrapper; projectId: SQLWrapper },
	turnBotId: SQLWrapper,
): SQL<string | null> {
	return sql<string | null>`case when ${row.kind} = 'collaboration'
		then ${defaultProjectIdOf(turnBotId)}
		else ${row.projectId} end`;
}

/**
 * SQL for "`userId` reaches the project `projectId` names", `userId` being an
 * id or the column holding one: what `mayInProject(actor, "project.read", …)`
 * decides for one project, written again as a `where` clause. In a project
 * people made, a member whose role reads projects; in a bot's default project,
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
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${project} as reach_project
		inner join ${workspaceMember} as reach_workspace_member
			on reach_workspace_member.workspace_id = reach_project.workspace_id
			and reach_workspace_member.user_id = ${outerColumn(userId)}
		where reach_project.id = ${outerColumn(projectId)}
			and case when reach_project.default_of_bot_id is null
				then ${roleIsOneOf(ROLES_READING_PROJECTS)} and exists (
					select 1
					from ${projectMember} as reach_project_member
					where reach_project_member.project_id = reach_project.id
						and reach_project_member.user_id = ${outerColumn(userId)}
				)
				else ${reachesBotFor(sql`reach_project.default_of_bot_id`, userId)}
			end
	)`;
}

/**
 * SQL for "`userId` reaches the bot `botId` names": what `reachesBot`
 * decides for one bot, written again as a `where` clause, so a change to it
 * must be made here too. System bots are reached by nobody.
 */
export function reachesBotFor(botId: SQLWrapper, userId: string | SQLWrapper): SQL<boolean> {
	return sql`exists (
		select 1
		from ${bot} as reach_bot
		inner join ${workspaceMember} as reach_bot_workspace_member
			on reach_bot_workspace_member.workspace_id = reach_bot.workspace_id
			and reach_bot_workspace_member.user_id = ${outerColumn(userId)}
		where reach_bot.id = ${outerColumn(botId)}
			and reach_bot.system_bot_key is null
			and case
				when reach_bot.assistant_of is not null then reach_bot.assistant_of = ${outerColumn(userId)}
				when reach_bot.visibility = 'private' then reach_bot.created_by_id = ${outerColumn(userId)}
				else true
			end
	)`;
}

/**
 * The columns of a placed conversation, or an alias of it, that whether
 * somebody reaches it is decided from.
 */
export interface ConversationReachColumns {
	id: SQLWrapper;
	workspaceId: SQLWrapper;
	kind: SQLWrapper;
	rootConversationId: SQLWrapper;
	projectId: SQLWrapper;
}

/**
 * SQL for "`userId` reaches the conversation `row`": the project rule for a
 * project's thread, an automation feed and a run, a bot's default project
 * included; the rule of the conversation it was opened from for a
 * collaboration; and membership of the direct message for one between
 * people. A system bot's conversation is in no project, so nobody reaches it. Written as SQL for lists, as
 * `conversationStandingFor` decides it for one conversation.
 */
export function reachesConversationFor(
	row: ConversationReachColumns,
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`(case when ${row.kind} = 'collaboration' then exists (
		select 1
		from ${placedConversation} as reach_opened_from
		where reach_opened_from.id = ${outerColumn(row.rootConversationId)}
			and ${reachesProjectFor(sql`reach_opened_from.project_id`, userId)}
	) else (${reachesProjectFor(row.projectId, userId)} or ${reachesDirectMessageFor(row, userId)}) end)`;
}

/**
 * SQL for "`userId` is in the direct message `row` and still in its
 * workspace". False for every other conversation, which has no
 * `direct_message_member` rows.
 */
function reachesDirectMessageFor(
	row: { id: SQLWrapper; workspaceId: SQLWrapper },
	userId: string | SQLWrapper,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${directMessageMember} as reach_direct_member
		inner join ${workspaceMember} as reach_direct_workspace_member
			on reach_direct_workspace_member.user_id = reach_direct_member.user_id
			and reach_direct_workspace_member.workspace_id = ${outerColumn(row.workspaceId)}
		where reach_direct_member.conversation_id = ${outerColumn(row.id)}
			and reach_direct_member.user_id = ${outerColumn(userId)}
	)`;
}

/** Roles that reach a project once they have been added to it. */
const ROLES_READING_PROJECTS = rolesGrantedInProject("project.read");

/** `false` rather than an empty `in ()`, which is not valid SQL. */
function roleIsOneOf(roles: readonly WorkspaceRole[]): SQL {
	if (roles.length === 0) return sql`false`;
	return sql`reach_workspace_member.role in (${sql.join(
		roles.map((role) => sql`${role}`),
		sql`, `,
	)})`;
}
