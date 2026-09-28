export * as RoutineView from "./routine-view.ts";

import type {
	Routine,
	RoutineExecutionPage,
	RoutineExecutionPageQuery,
	WorkspaceRoutine,
} from "@sugabots/contracts";
import { DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT } from "@sugabots/contracts";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, pod, routine, routineExecution } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/agent.ts";
import { decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { crewOf } from "../threads/participants.ts";
import { toRoutineExecution } from "./execution.ts";
import { inScope, type Scope, toRoutine } from "./routine.ts";

/** What the routine screens show: the routines, and each one's runs. */
export interface Interface {
	/** Every routine on a crew agent in a pod the person reaches, by name, with its agent and pod. */
	readonly listInWorkspace: (
		workspaceId: string,
		userId: string,
	) => Effect.Effect<WorkspaceRoutine[]>;
	/** The agent's routines, by name. */
	readonly list: (agent: { workspaceId: string; agentId: string }) => Effect.Effect<Routine[]>;
	readonly get: (scope: Scope) => Effect.Effect<Routine | undefined>;
	/**
	 * A page of the routine's runs, newest first. `undefined` when there is no
	 * such routine, removed ones included, so a removed routine keeps its history.
	 */
	readonly listExecutions: (
		scope: Scope,
		page?: RoutineExecutionPageQuery,
	) => Effect.Effect<RoutineExecutionPage | undefined, InvalidRoutineExecutionCursor>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/RoutineView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineView");
	return Service.of({
		listInWorkspace: (workspaceId, userId) =>
			operation(
				"listInWorkspace",
				Effect.map(
					query((db) =>
						db
							.select({ routine, agent, pod: { id: pod.id, slug: pod.slug } })
							.from(routine)
							.innerJoin(agent, eq(agent.id, routine.agentId))
							.innerJoin(pod, crewOf(pod.id))
							.where(
								and(
									eq(routine.workspaceId, workspaceId),
									isNull(routine.deletedAt),
									reachesPod(pod.id, userId),
								),
							)
							.orderBy(asc(routine.name), asc(routine.id)),
					),
					(rows) =>
						rows.flatMap((row): WorkspaceRoutine[] => {
							const crew = crewAgentRow(row.agent);
							return crew
								? [{ routine: toRoutine(row.routine), agent: toAgent(crew), pod: row.pod }]
								: [];
						}),
				),
			),

		list: (owner) =>
			operation(
				"list",
				Effect.map(
					query((db) =>
						db
							.select()
							.from(routine)
							.where(
								and(
									eq(routine.workspaceId, owner.workspaceId),
									eq(routine.agentId, owner.agentId),
									isNull(routine.deletedAt),
								),
							)
							.orderBy(asc(routine.name)),
					),
					(rows) => rows.map(toRoutine),
				),
			),

		get: (scope) =>
			operation(
				"get",
				Effect.map(
					query((db) => db.select().from(routine).where(inScope(scope)).limit(1)),
					([row]) => (row ? toRoutine(row) : undefined),
				),
			),

		listExecutions: (scope, page = { limit: DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT }) =>
			operation(
				"listExecutions",
				Effect.gen(function* () {
					const before = page.cursor ? yield* executionCursor(page.cursor) : undefined;
					const [definition] = yield* query((db) =>
						db
							.select({ id: routine.id })
							.from(routine)
							.where(
								and(
									eq(routine.id, scope.routineId),
									eq(routine.workspaceId, scope.workspaceId),
									eq(routine.agentId, scope.agentId),
								),
							)
							.limit(1),
					);
					if (!definition) return undefined;
					const rows = yield* query((db) =>
						db
							.select()
							.from(routineExecution)
							.where(
								and(
									eq(routineExecution.routineId, scope.routineId),
									before
										? earlierThan(routineExecution.acceptedAt, routineExecution.id, before)
										: undefined,
								),
							)
							.orderBy(desc(routineExecution.acceptedAt), desc(routineExecution.id))
							.limit(page.limit + 1),
					);
					const items = rows.slice(0, page.limit);
					const oldest = items.at(-1);
					return {
						items: items.map(toRoutineExecution),
						nextCursor:
							rows.length > page.limit && oldest
								? encodeCursor({ at: oldest.acceptedAt, id: oldest.id })
								: null,
					};
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

export class InvalidRoutineExecutionCursor
	extends Data.TaggedError("InvalidRoutineExecutionCursor")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That Routine execution cursor is invalid`;
	}
}

const executionCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidRoutineExecutionCursor());
};
