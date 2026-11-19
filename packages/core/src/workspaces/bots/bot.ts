import type { Bot } from "@sugabots/contracts";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { type Actor, botPermissions } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";
import { pinnedBot, project } from "../../database/schema.ts";

/**
 * A bot row that is a bot people talk to: anything but a system bot, which
 * works behind the scenes and is shaped as a `SystemBot` instead. The row
 * type cannot say so, so the API's shape is reached through
 * {@link personFacingBotRow} rather than by asserting it.
 */
export type PersonFacingBotRow = schema.BotRow & { systemBotKey: null };

/** The row when it is a bot people talk to, or nothing when it is a system bot. */
export function personFacingBotRow(row: schema.BotRow): PersonFacingBotRow | undefined {
	return row.systemBotKey === null ? { ...row, systemBotKey: null } : undefined;
}

/**
 * SQL for the id of the default project of the bot `botId` names, to select
 * beside it for {@link toBot}. Every bot but a system bot has one.
 */
export function defaultProjectIdOf(botId: SQLWrapper): SQL<string> {
	return sql<string>`(select default_project.id from ${project} as default_project where default_project.default_of_bot_id = ${botId})`;
}

/** SQL for whether the person `userId` pinned the bot `botId` names, to select beside it for {@link toBot}. */
export function pinnedBy(botId: SQLWrapper, userId: string): SQL<boolean> {
	return sql<boolean>`exists (select 1 from ${pinnedBot} where ${pinnedBot.botId} = ${botId} and ${pinnedBot.userId} = ${userId})`;
}

/**
 * The row as the API returns it to `viewer`: timestamps as ISO strings, what
 * they may do with it, and whether they pinned it. `defaultProjectId` is its
 * default project's, whose routes hold its computer, connections and
 * automations.
 */
export function toBot(
	row: PersonFacingBotRow & { defaultProjectId: string },
	viewer: { actor: Actor; pinned: boolean },
): Bot {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		handle: row.handle,
		description: row.description,
		color: row.color,
		face: row.face,
		shape: row.shape,
		model: row.model,
		prompt: row.prompt,
		disabledTools: row.disabledTools,
		usesComputer: row.usesComputer,
		naturalBrowsing: row.naturalBrowsing,
		createdById: row.createdById,
		visibility: row.visibility,
		assistant: row.assistantOf !== null,
		pinned: viewer.pinned,
		defaultProjectId: row.defaultProjectId,
		permissions: botPermissions(viewer.actor, row),
		createdAt: row.createdAt.toISOString(),
	};
}
