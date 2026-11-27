import type { WorkspaceRole } from "@sugabots/contracts";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { bot, botMember, membership, project, projectMember } from "../database/schema.ts";
import { outerColumn } from "../database/sql.ts";
import { rolesGrantedInProject } from "./permissions.ts";

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
		inner join workspace as reach_workspace
			on reach_workspace.id = reach_project.workspace_id and not reach_workspace.deleting
		inner join ${membership} as reach_membership
			on reach_membership.workspace_id = reach_project.workspace_id
			and reach_membership.member_id = ${outerColumn(memberId)}
			and not reach_membership.leaving
		where reach_project.id = ${outerColumn(projectId)}
			and not reach_project.deleting
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
	return sql`select candidate.member_id
		from ${project} as reached_project
		left join ${bot} as reached_bot on reached_bot.id = reached_project.default_of_bot_id
		cross join lateral (
			select project_members.member_id
			from ${projectMember} as project_members
			where reached_project.default_of_bot_id is null and project_members.project_id = reached_project.id
			union all
			select bot_members.member_id
			from ${botMember} as bot_members
			where reached_bot.visibility = 'private' and bot_members.bot_id = reached_bot.id
			union all
			select reached_bot.created_by_id
			where reached_bot.visibility = 'personal' and reached_bot.created_by_id is not null
			union all
			select workspace_members.member_id
			from ${membership} as workspace_members
			where reached_bot.visibility = 'public' and workspace_members.workspace_id = reached_bot.workspace_id
		) as candidate
		where reached_project.id = ${outerColumn(projectId)}
			and ${reachesProjectFor(sql`reached_project.id`, sql`candidate.member_id`)}`;
}

/**
 * SQL for "`memberId` reaches the bot `botId` names": what `reachesBot`
 * decides for one bot, written again as a `where` clause, so a change to it
 * must be made here too. System bots are reached by nobody.
 */
export function reachesBotFor(botId: SQLWrapper, memberId: string | SQLWrapper): SQL<boolean> {
	return reachedBotFor(
		botId,
		memberId,
		sql`not exists (
				select 1
				from ${project} as reach_bot_default_project
				where reach_bot_default_project.default_of_bot_id = reach_bot.id
					and reach_bot_default_project.workspace_id = reach_bot.workspace_id
					and reach_bot_default_project.deleting
			)`,
	);
}

/**
 * SQL for "`memberId` reaches the bot `botId` names, or did until its deletion
 * began": who hears that it is going, so their lists drop it.
 */
export function reachedBotUntilDeletionFor(
	botId: SQLWrapper,
	memberId: string | SQLWrapper,
): SQL<boolean> {
	return reachedBotFor(botId, memberId, sql`true`);
}

/** The rule `reachesBotFor` and `reachedBotUntilDeletionFor` share, given what a deletion leaves. */
function reachedBotFor(
	botId: SQLWrapper,
	memberId: string | SQLWrapper,
	notBeingDeleted: SQL<boolean>,
): SQL<boolean> {
	return sql`exists (
		select 1
		from ${bot} as reach_bot
		inner join ${membership} as reach_bot_membership
			on reach_bot_membership.workspace_id = reach_bot.workspace_id
			and reach_bot_membership.member_id = ${outerColumn(memberId)}
			and not reach_bot_membership.leaving
		where reach_bot.id = ${outerColumn(botId)}
			and reach_bot.system_bot_key is null
			and ${notBeingDeleted}
			and case reach_bot.visibility
				when 'public' then true
				when 'private' then ${isBotMember(sql`reach_bot.id`, memberId)}
				when 'personal' then reach_bot.created_by_id = ${outerColumn(memberId)}
				else false
			end
	)`;
}

export function isBotMember(botId: SQLWrapper, memberId: string | SQLWrapper): SQL<boolean> {
	return sql<boolean>`exists (
		select 1 from ${botMember} as reach_bot_member
		where reach_bot_member.bot_id = ${outerColumn(botId)}
			and reach_bot_member.member_id = ${outerColumn(memberId)}
	)`;
}

/**
 * SQL for the ids of the members of the bot `botId` names, as
 * `BotFacts.memberIds` holds them: a private bot's members, and none for any
 * other bot, which has no `bot_member` rows.
 */
export function botMemberIds(botId: SQLWrapper): SQL<string[]> {
	return sql<string[]>`(
		select coalesce(json_agg(listed_bot_member.member_id), '[]'::json)
		from ${botMember} as listed_bot_member
		where listed_bot_member.bot_id = ${outerColumn(botId)}
	)`;
}

/**
 * The columns of a placed chat, or an alias of it, that whether
 * somebody reaches it is decided from.
 */
interface ChatReachColumns {
	projectId: SQLWrapper;
}

/**
 * SQL for "`memberId` reaches the chat `row`": the project rule for a
 * project's chat, an automation feed and a run, a bot's default project
 * included. A system bot's chat is in no project, so nobody reaches it.
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
