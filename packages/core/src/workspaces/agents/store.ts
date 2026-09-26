import {
	type Agent,
	type AgentUpdate,
	colorFromText,
	handleFromName,
	type NewAgent,
} from "@sugabots/contracts";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, queryCatching, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type * as schema from "../../database/schema.ts";
import { agent, pod } from "../../database/schema.ts";
import { reachesPod } from "../access.ts";

/**
 * Reading and writing agents.
 *
 * Separate from `Authorization` on purpose: this answers "what is there",
 * `Authorization` answers "may you have it". Keeping them apart is what lets
 * the routes be tested with a fake store and a real policy, or the other way
 * round.
 *
 * An interface for the same reason the pod store is one — the HTTP tests run
 * without Postgres.
 */

export interface AgentStore {
	/**
	 * The agents this person can see in a workspace, by name.
	 *
	 * An agent is seen through its pod, on exactly the terms `reachesPod`
	 * states: the pods they have joined, plus every shared pod when their role
	 * reaches those, and never somebody else's Personal pod. System agents are
	 * in no pod and are not here; they are read through the system agent store.
	 */
	listVisible(workspaceId: string, userId: string): Effect.Effect<Agent[], never, Database>;
	/** One agent, or nothing when the id names a system agent instead. */
	get(agentId: string): Effect.Effect<Agent | undefined, never, Database>;
	/** The API shape of a row already in hand, or nothing when it is a system agent. */
	fromRow(row: schema.AgentRow): Effect.Effect<Agent | undefined, never, Database>;
	/** Creates an agent inside its required pod. */
	create(
		workspaceId: string,
		createdById: string,
		input: NewAgent,
	): Effect.Effect<Agent, NameTaken | PodOutsideWorkspace, Database>;
	update(
		workspaceId: string,
		agentId: string,
		input: AgentUpdate,
	): Effect.Effect<Agent, NameTaken | AgentGone | SystemAgentImmutable, Database>;
	remove(workspaceId: string, agentId: string): Effect.Effect<void, SystemAgentImmutable, Database>;
}

/** A name is taken in the workspace. The route makes it a `conflict`. */
export class NameTaken extends Data.TaggedError("NameTaken")<{ readonly agentName: string }> {
	override get message() {
		return `An agent called "${this.agentName}" already exists in this workspace`;
	}
}

/** A write names an agent that is no longer there. `not_found`. */
export class AgentGone extends Data.TaggedError("AgentGone")<{ readonly agentId: string }> {
	override get message() {
		return `No agent with the id "${this.agentId}"`;
	}
}

/** A placement names a pod in another workspace. */
export class PodOutsideWorkspace extends Data.TaggedError("PodOutsideWorkspace") {
	override get message() {
		return "That is not a pod in this workspace";
	}
}

/**
 * System agents are shipped by the product and belong to the workspace, not to
 * a pod. The one thing about one that changes — its model — is written through
 * the system agent store.
 */
export class SystemAgentImmutable extends Data.TaggedError("SystemAgentImmutable") {
	override get message() {
		return "A system agent is configured for the workspace, not in a pod";
	}
}

const create: AgentStore["create"] = (workspaceId, createdById, input) =>
	transaction(
		Effect.gen(function* () {
			const [owningPod] = yield* query((db) =>
				db
					.select({ id: pod.id })
					.from(pod)
					.where(and(eq(pod.workspaceId, workspaceId), eq(pod.id, input.podId)))
					.limit(1),
			);
			if (!owningPod) {
				return yield* new PodOutsideWorkspace();
			}

			const [row] = yield* query((db) =>
				db
					.insert(agent)
					.values({
						workspaceId,
						podId: input.podId,
						createdById,
						name: input.name,
						handle: input.handle ?? handleFromName(input.name),
						description: input.description ?? null,
						color: input.color ?? colorFromText(input.name),
						face: input.face ?? "pill",
						model: input.model,
						prompt: input.prompt ?? "",
						disabledTools: input.disabledTools ?? [],
					})
					.onConflictDoNothing({ target: [agent.podId, agent.name] })
					.returning(),
			);

			if (!row) {
				return yield* new NameTaken({ agentName: input.name });
			}

			// The pod is the one just written, which is what makes this a crew row
			// without asking the database to confirm it.
			return toAgent({ ...row, podId: input.podId });
		}),
	);

const update: AgentStore["update"] = (workspaceId, agentId, input) =>
	Effect.gen(function* () {
		const current = yield* systemAgentKeyOf(workspaceId, agentId);
		// Nothing about a system agent changes here. The one thing that does —
		// its model — belongs to the workspace, and is written through the system
		// agent store instead.
		if (current?.systemAgentKey) {
			return yield* new SystemAgentImmutable();
		}

		// An UPDATE has no `on conflict`, so a taken name arrives as a
		// Postgres unique violation and is translated here rather than
		// escaping as a 500.
		const [row] = yield* queryCatching(
			(db) =>
				db
					.update(agent)
					.set(input)
					.where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId)))
					.returning(),
			(rejection) =>
				isUniqueViolation(rejection) ? new NameTaken({ agentName: input.name ?? "" }) : undefined,
		);

		// Authorisation already found this agent, so no row means it was
		// deleted in between — not that anything conflicted.
		if (!row) {
			return yield* new AgentGone({ agentId });
		}
		const crew = crewAgentRow(row);
		if (!crew) {
			return yield* new AgentGone({ agentId });
		}
		return toAgent(crew);
	});

const remove: AgentStore["remove"] = (workspaceId, agentId) =>
	Effect.gen(function* () {
		const current = yield* systemAgentKeyOf(workspaceId, agentId);
		if (current?.systemAgentKey) {
			return yield* new SystemAgentImmutable();
		}
		yield* query((db) =>
			db.delete(agent).where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId))),
		);
	});

/** Which system agent an agent is, if any, which decides whether it may change. */
function systemAgentKeyOf(workspaceId: string, agentId: string) {
	return query((db) =>
		db
			.select({ systemAgentKey: agent.systemAgentKey })
			.from(agent)
			.where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId)))
			.limit(1)
			.pipe(Effect.map(([row]) => row)),
	);
}

export const agentStore: AgentStore = {
	listVisible: (workspaceId, userId) =>
		query((db) =>
			db
				.select({ agent })
				.from(agent)
				// `reachesPod` already answers false for a system agent's null pod,
				// but saying so is what keeps the exclusion from being a side effect
				// of how NULL propagates inside that subquery.
				.where(
					and(
						eq(agent.workspaceId, workspaceId),
						isNotNull(agent.podId),
						reachesPod(agent.podId, userId),
					),
				)
				.orderBy(asc(agent.name)),
		).pipe(
			Effect.map((rows) =>
				rows.flatMap((row) => {
					const crew = crewAgentRow(row.agent);
					return crew ? [toAgent(crew)] : [];
				}),
			),
		),

	get: (agentId) =>
		Effect.gen(function* () {
			const [row] = yield* query((db) =>
				db.select().from(agent).where(eq(agent.id, agentId)).limit(1),
			);
			const crew = row && crewAgentRow(row);
			return crew ? toAgent(crew) : undefined;
		}),

	fromRow: (row) => {
		const crew = crewAgentRow(row);
		return Effect.succeed(crew ? toAgent(crew) : undefined);
	},
	create,
	update,
	remove,
};

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
