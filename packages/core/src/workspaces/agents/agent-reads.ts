import type { Agent, SystemAgent } from "@sugabots/contracts";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { reachesAgentFor } from "../../authorization/access.ts";
import { type Actor, managesEveryAgent } from "../../authorization/permissions.ts";
import { query } from "../../database/database.ts";
import { agent, pinnedAgent } from "../../database/schema.ts";
import { crewAgentRow, toAgent } from "./agent.ts";
import { SYSTEM_AGENTS } from "./system-agents.ts";

/**
 * The bots in a workspace that `actor` sees, by name: those they reach, and,
 * for an administrator, every private bot too, which they see listed but
 * can't open. Each says whether `actor` pinned it. System bots are not here.
 */
export const visibleCrewAgents = (workspaceId: string, actor: Actor) =>
	query((db) =>
		db
			.select({ agent, pinnedAt: pinnedAgent.createdAt })
			.from(agent)
			.leftJoin(
				pinnedAgent,
				and(eq(pinnedAgent.agentId, agent.id), eq(pinnedAgent.userId, actor.userId)),
			)
			.where(
				and(
					eq(agent.workspaceId, workspaceId),
					isNull(agent.systemAgentKey),
					managesEveryAgent(actor)
						? or(isNull(agent.assistantOf), eq(agent.assistantOf, actor.userId))
						: reachesAgentFor(agent.id, actor.userId),
				),
			)
			.orderBy(asc(agent.name)),
	).pipe(
		Effect.map((rows): Agent[] =>
			rows.flatMap((row) => {
				const crew = crewAgentRow(row.agent);
				return crew ? [toAgent(crew, { actor, pinned: row.pinnedAt !== null })] : [];
			}),
		),
	);

/**
 * Every system agent the product defines, with the model the workspace chose
 * for it. The name, face and order come from the definitions; a workspace
 * missing a row reads as one that has not set that agent up.
 */
export const systemAgents = (workspaceId: string) =>
	query((db) =>
		db
			.select({ key: agent.systemAgentKey, model: agent.model })
			.from(agent)
			.where(and(eq(agent.workspaceId, workspaceId), isNotNull(agent.systemAgentKey))),
	).pipe(
		Effect.map((rows): SystemAgent[] => {
			const modelOf = new Map(rows.map((row) => [row.key, row.model]));
			return SYSTEM_AGENTS.map((definition) => ({
				key: definition.key,
				name: definition.name,
				description: definition.description,
				color: definition.color,
				face: definition.face,
				shape: definition.shape,
				model: modelOf.get(definition.key) ?? null,
			}));
		}),
	);
