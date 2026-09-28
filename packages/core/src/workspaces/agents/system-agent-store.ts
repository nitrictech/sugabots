import type { SystemAgent, SystemAgentKey } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../../database/database.ts";
import { agent, pod } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { FACILITATE_SYSTEM_AGENT, listSystemAgents } from "./system-agents.ts";

/**
 * Reading the workspace's system agents and choosing the models they run on.
 *
 * Separate from the agent store because these are not pod resources: there is
 * one of each per workspace, they are addressed by key rather than by id, and
 * the only thing anybody may change about one is its model.
 */
export interface SystemAgentStore {
	list(workspaceId: string): Effect.Effect<SystemAgent[], never, Database>;
	/**
	 * Points a system agent at a model, which is how it is set up, or at `null`,
	 * which turns it off.
	 *
	 * Turning the Facilitator off also stops every pod routing through it: a pod
	 * pointed at an agent that cannot run is a setting that says one thing and
	 * does another, and the pod store refuses to switch it back on until a model
	 * is chosen. The two happen together or not at all.
	 */
	setModel(
		workspaceId: string,
		key: SystemAgentKey,
		model: string | null,
	): Effect.Effect<SystemAgent, SystemAgentMissing, Database>;
}

/**
 * The workspace has no row for this system agent. A defect rather than a
 * refusal: every workspace is given one when it is created. The route answers
 * `not_found` so a caller is not told to retry something that will not change.
 */
export class SystemAgentMissing
	extends Data.TaggedError("SystemAgentMissing")<{ readonly key: SystemAgentKey }>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This workspace has no ${this.key} agent`;
	}
}

/** Pods whose routing currently hands the floor to the Facilitator. */
const facilitatorRouting = sql`${pod.routing} ->> 'facilitator' = 'true'`;

export const systemAgentStore: SystemAgentStore = {
	list: (workspaceId) => query((db) => listSystemAgents(db, workspaceId)),

	setModel: (workspaceId, key, model) =>
		transaction(
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.update(agent)
						.set({ model })
						.where(and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, key)))
						.returning({ id: agent.id }),
				);
				if (!row) {
					return yield* new SystemAgentMissing({ key });
				}
				if (key === FACILITATE_SYSTEM_AGENT && model === null) {
					yield* query((db) =>
						db
							.update(pod)
							.set({ routing: { facilitator: false } })
							.where(and(eq(pod.workspaceId, workspaceId), facilitatorRouting)),
					);
				}
				const agents = yield* query((db) => listSystemAgents(db, workspaceId));
				const updated = agents.find((candidate) => candidate.key === key);
				if (!updated) {
					return yield* new SystemAgentMissing({ key });
				}
				return updated;
			}),
		),
};

/**
 * Whether the workspace's Facilitator can route: it exists and a model has been
 * chosen for it.
 *
 * Lives here rather than in the pod store so the rule that a pod may not switch
 * routing on, and the screen that says why, read the same fact.
 */
export function facilitatorIsSetUp(workspaceId: string): Effect.Effect<boolean, never, Database> {
	return query((db) =>
		db
			.select({ model: agent.model })
			.from(agent)
			.where(
				and(eq(agent.workspaceId, workspaceId), eq(agent.systemAgentKey, FACILITATE_SYSTEM_AGENT)),
			)
			.limit(1),
	).pipe(Effect.map(([row]) => row?.model != null));
}
