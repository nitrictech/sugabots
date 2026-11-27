import type { Bot, BotVisibility, NamedMember } from "@sugabots/contracts";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Actor } from "../../authorization/permissions.ts";
import { memberJson } from "../../chats/store/participants.ts";
import type * as schema from "../../database/schema.ts";
import { member, membership, pinnedBot, project } from "../../database/schema.ts";
import { outerColumn } from "../../database/sql.ts";
import { botPermissionsShown } from "../../proofs/shown-permissions.ts";

/**
 * A bot row that is a bot members talk to: anything but a system bot, which
 * works behind the scenes and is shaped as a `SystemBot` instead. The row
 * type cannot say so, so the API's shape is reached through
 * {@link memberFacingBotRow} rather than by asserting it.
 */
export type MemberFacingBotRow = schema.BotRow & { systemBotKey: null };

/** The row when it is a bot members talk to, or nothing when it is a system bot. */
export function memberFacingBotRow(row: schema.BotRow): MemberFacingBotRow | undefined {
	return row.systemBotKey === null ? { ...row, systemBotKey: null } : undefined;
}

/**
 * SQL for the id of the default project of the bot `botId` names, to select
 * beside it for {@link toBot}. Every bot but a system bot has one. The
 * projects are read under a name of their own, so `botId` may be a column of
 * an outer query over projects.
 */
/**
 * Whether setting a bot that is `from` to `to` would make it personal, or stop
 * it being personal, which never happens: whether a bot is personal is chosen
 * when it is made. Public and private bots may switch between each other.
 */
export function changesPersonal(from: BotVisibility, to: BotVisibility | undefined): boolean {
	return to !== undefined && to !== from && (from === "personal" || to === "personal");
}

export function defaultProjectIdOf(botId: SQLWrapper): SQL<string> {
	return sql<string>`(select owned.id from ${project} as owned where owned.default_of_bot_id = ${outerColumn(botId)})`;
}

/** SQL for whether the member `memberId` pinned the bot `botId` names, to select beside it for {@link toBot}. */
export function pinnedBy(botId: SQLWrapper, memberId: string): SQL<boolean> {
	return sql<boolean>`exists (select 1 from ${pinnedBot} where ${pinnedBot.botId} = ${botId} and ${pinnedBot.memberId} = ${memberId})`;
}

/**
 * SQL for the member who added the bot whose `createdById` and `workspaceId`
 * columns are given, by name, to select beside it for {@link toBot}: null when
 * nobody did, or they are no longer in the workspace.
 */
export function creatorOf(bot: {
	createdById: SQLWrapper;
	workspaceId: SQLWrapper;
}): SQL<NamedMember | null> {
	return sql<NamedMember | null>`(select ${memberJson} from ${membership} inner join ${member} on ${member.id} = ${membership.memberId} where ${membership.workspaceId} = ${bot.workspaceId} and ${membership.memberId} = ${bot.createdById} and not ${membership.leaving})`;
}

/**
 * The row as the API returns it to `viewer`: timestamps as ISO strings, what
 * they may do with it, and whether they pinned it. `defaultProjectId` is its
 * default project's, whose routes hold its computer, connectors and
 * automations; `createdBy` is {@link creatorOf} its `createdById`.
 */
export function toBot(
	row: MemberFacingBotRow & {
		memberIds: readonly string[];
		defaultProjectId: string;
		createdBy: NamedMember | null;
	},
	viewer: { actor: Actor; pinned: boolean },
): Bot {
	const permissions = botPermissionsShown(viewer.actor, row, row.defaultProjectId);
	const identity = {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		handle: row.handle,
		color: row.color,
		eyes: row.eyes,
		shape: row.shape,
		createdBy: row.createdBy,
		visibility: row.visibility,
		assistant: row.assistantOf !== null,
		pinned: viewer.pinned,
		defaultProjectId: row.defaultProjectId,
		permissions,
	};
	if (!permissions.talk) return identity;
	return {
		...identity,
		description: row.description,
		model: row.model,
		instructions: row.instructions,
		disabledTools: row.disabledTools,
		usesComputer: row.usesComputer,
		naturalBrowsing: row.naturalBrowsing,
		createdAt: row.createdAt.toISOString(),
	};
}
