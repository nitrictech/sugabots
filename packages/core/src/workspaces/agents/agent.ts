import type { Agent } from "@sugabots/contracts";
import type * as schema from "../../database/schema.ts";
import type { DeviceLinks } from "../../devices/device-links.ts";

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

/**
 * The row as the API returns it: timestamps as ISO strings, no internals. An
 * agent on somebody's computer is online while `lends` says that computer is
 * connected and lends it.
 */
export function toAgent(row: CrewAgentRow, lends: DeviceLinks.Interface["lends"]): Agent {
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
		shape: row.shape,
		model: row.model,
		prompt: row.prompt,
		disabledTools: row.disabledTools,
		usesSandbox: row.usesSandbox,
		a2a:
			row.a2aUrl === null
				? null
				: {
						url: row.a2aUrl,
						secretHeader: row.a2aSecretHeader,
						hasSecret: row.a2aSecretEncrypted !== null,
						deviceId: row.a2aDeviceId,
						online: row.a2aDeviceId === null ? null : lends(row.a2aDeviceId, row.a2aUrl),
					},
		createdAt: row.createdAt.toISOString(),
	};
}

/** An A2A agent's endpoint as stored, its secret already sealed. */
export interface SealedA2AEndpoint {
	a2aUrl: string;
	a2aSecretHeader: string | null;
	a2aSecretEncrypted: string | null;
	a2aDeviceId: string | null;
}

/** The columns that make an agent one of ours, running on its model. */
export const NOT_A2A: { [K in keyof SealedA2AEndpoint]: null } = {
	a2aUrl: null,
	a2aSecretHeader: null,
	a2aSecretEncrypted: null,
	a2aDeviceId: null,
};
