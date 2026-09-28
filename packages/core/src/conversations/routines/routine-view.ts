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
import type { AuthorizationDenied } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import type { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, pod, routine, routineExecution } from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/agent.ts";
import { decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { crewOf } from "../threads/participants.ts";
import { toRoutineExecution } from "./execution.ts";
import { inScope, type OnAgent, RoutineNotFound, scopeOf, toRoutine } from "./routine.ts";

/**
 * What the routine screens show, of the routines the current actor may read:
 * the routines, and each one's runs.
 */
export interface Interface {
	/**
	 * Every routine on a crew agent in a pod the actor reaches, in a workspace
	 * named by its id or its slug, by name, with its agent and pod.
	 */
	readonly listInWorkspace: (
		workspace: string,
	) => Effect.Effect<WorkspaceRoutine[], AuthorizationDenied, CurrentActor.Service>;
	/** The agent's routines, by name. */
	readonly list: (owner: {
		agentId: string;
	}) => Effect.Effect<Routine[], AuthorizationDenied, CurrentActor.Service>;
	readonly get: (
		routine: OnAgent,
	) => Effect.Effect<Routine, AuthorizationDenied | RoutineNotFound, CurrentActor.Service>;
	/**
	 * A page of the routine's runs, newest first. A removed routine keeps its
	 * history, so this finds it as long as it was ever defined.
	 */
	readonly listExecutions: (
		routine: OnAgent,
		page?: RoutineExecutionPageQuery,
	) => Effect.Effect<
		RoutineExecutionPage,
		AuthorizationDenied | RoutineNotFound | InvalidRoutineExecutionCursor,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/RoutineView") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("RoutineView");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;

	return Service.of({
		listInWorkspace: (workspace) =>
			operation(
				"listInWorkspace",
				Effect.gen(function* () {
					const { workspaceId } = yield* authorization.workspace(workspace, "workspace.read");
					const reachesPod = yield* visibility.reachesPod;
					const rows = yield* query((db) =>
						db
							.select({ routine, agent, pod: { id: pod.id, slug: pod.slug } })
							.from(routine)
							.innerJoin(agent, eq(agent.id, routine.agentId))
							.innerJoin(pod, crewOf(pod.id))
							.where(
								and(
									eq(routine.workspaceId, workspaceId),
									isNull(routine.deletedAt),
									reachesPod(pod.id),
								),
							)
							.orderBy(asc(routine.name), asc(routine.id)),
					);
					return rows.flatMap((row): WorkspaceRoutine[] => {
						const crew = crewAgentRow(row.agent);
						return crew
							? [{ routine: toRoutine(row.routine), agent: toAgent(crew), pod: row.pod }]
							: [];
					});
				}),
			),

		list: ({ agentId }) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { agent: owner } = yield* authorization.agent(agentId, "routine.read");
					const rows = yield* query((db) =>
						db
							.select()
							.from(routine)
							.where(
								and(
									eq(routine.workspaceId, owner.workspaceId),
									eq(routine.agentId, owner.id),
									isNull(routine.deletedAt),
								),
							)
							.orderBy(asc(routine.name)),
					);
					return rows.map(toRoutine);
				}),
			),

		get: (addressed) =>
			operation(
				"get",
				Effect.gen(function* () {
					const scope = yield* scopeOf(authorization, addressed, "routine.read");
					const [row] = yield* query((db) =>
						db.select().from(routine).where(inScope(scope)).limit(1),
					);
					if (!row) return yield* new RoutineNotFound();
					return toRoutine(row);
				}),
			),

		listExecutions: (addressed, page = { limit: DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT }) =>
			operation(
				"listExecutions",
				Effect.gen(function* () {
					const scope = yield* scopeOf(authorization, addressed, "routine.history.read");
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
					if (!definition) return yield* new RoutineNotFound();
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

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

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
