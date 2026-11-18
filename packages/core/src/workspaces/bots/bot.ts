import type { Bot } from "@sugabots/contracts";
import { type Actor, botPermissions } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";

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
 * The row as the API returns it to `viewer`: timestamps as ISO strings, what
 * they may do with it, and whether they pinned it.
 */
export function toBot(row: PersonFacingBotRow, viewer: { actor: Actor; pinned?: boolean }): Bot {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		handle: row.handle,
		systemBotKey: row.systemBotKey,
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
		pinned: viewer.pinned ?? false,
		permissions: botPermissions(viewer.actor, {
			visibility: row.visibility,
			createdById: row.createdById,
			assistantOf: row.assistantOf,
		}),
		createdAt: row.createdAt.toISOString(),
	};
}
