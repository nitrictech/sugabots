import type { Agent, SystemAgent } from "@sugabots/contracts";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { query } from "../../database/database.ts";
import { agent } from "../../database/schema.ts";
import type { Visibility } from "../visibility.ts";
import { crewAgentRow, toAgent } from "./agent.ts";
import { SYSTEM_AGENTS } from "./system-agents.ts";

/**
 * The crew agents in a workspace's pods that `reachesPod`, `Visibility`'s
 * rule for somebody, says they reach, by name. System agents are in no pod
 * and are not here.
 */
export const visibleCrewAgents = (workspaceId: string, reachesPod: Visibility.ReachesPod) =>
	query((db) =>
		db
			.select()
			.from(agent)
			// `reachesPod` is already false for a null pod; the explicit check keeps
			// system agents out without relying on how NULL propagates in it.
			.where(
				and(eq(agent.workspaceId, workspaceId), isNotNull(agent.podId), reachesPod(agent.podId)),
			)
			.orderBy(asc(agent.name)),
	).pipe(
		Effect.map((rows): Agent[] =>
			rows.flatMap((row) => {
				const crew = crewAgentRow(row);
				return crew ? [toAgent(crew)] : [];
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
				model: modelOf.get(definition.key) ?? null,
			}));
		}),
	);
