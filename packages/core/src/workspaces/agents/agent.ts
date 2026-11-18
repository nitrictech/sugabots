import type { Agent } from "@sugabots/contracts";
import { type Actor, agentPermissions } from "../../authorization/permissions.ts";
import type * as schema from "../../database/schema.ts";

/**
 * An agent row that is a bot people talk to: anything but a system bot, which
 * works behind the scenes and is shaped as a `SystemAgent` instead. The row
 * type cannot say so, so the API's shape is reached through
 * {@link crewAgentRow} rather than by asserting it.
 */
export type CrewAgentRow = schema.AgentRow & { systemAgentKey: null };

/** The row when it is a bot people talk to, or nothing when it is a system bot. */
export function crewAgentRow(row: schema.AgentRow): CrewAgentRow | undefined {
	return row.systemAgentKey === null ? { ...row, systemAgentKey: null } : undefined;
}

/**
 * The row as the API returns it to `viewer`: timestamps as ISO strings, what
 * they may do with it, and whether they pinned it.
 */
export function toAgent(row: CrewAgentRow, viewer: { actor: Actor; pinned?: boolean }): Agent {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		name: row.name,
		handle: row.handle,
		systemAgentKey: row.systemAgentKey,
		description: row.description,
		color: row.color,
		face: row.face,
		shape: row.shape,
		model: row.model,
		prompt: row.prompt,
		disabledTools: row.disabledTools,
		usesSandbox: row.usesSandbox,
		naturalBrowsing: row.naturalBrowsing,
		createdById: row.createdById,
		visibility: row.visibility,
		assistant: row.assistantOf !== null,
		pinned: viewer.pinned ?? false,
		permissions: agentPermissions(viewer.actor, {
			visibility: row.visibility,
			createdById: row.createdById,
			assistantOf: row.assistantOf,
		}),
		createdAt: row.createdAt.toISOString(),
	};
}
