import type { Agent } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";

/**
 * An agent row that is a crew agent: one that lives in a pod.
 *
 * `agent_placement_check` makes "has a pod" and "is not a system agent" the
 * same thing in the database, but the row type cannot say so, so the API's
 * shape is reached through {@link crewAgentRow} rather than by asserting it.
 */
export type CrewAgentRow = schema.AgentRow & { podId: string };

/** The row when it is a crew agent, or nothing when it is a system agent. */
export function crewAgentRow(row: schema.AgentRow): CrewAgentRow | undefined {
	return row.podId === null ? undefined : { ...row, podId: row.podId };
}

/** The row as the API returns it: timestamps as ISO strings, no internals. */
export function toAgent(row: CrewAgentRow): Agent {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		podId: row.podId,
		name: row.name,
		handle: row.handle,
		systemAgentKey: row.systemAgentKey,
		description: row.description,
		color: row.color,
		face: row.face,
		model: row.model,
		prompt: row.prompt,
		disabledTools: row.disabledTools,
		createdAt: row.createdAt.toISOString(),
	};
}
