import type { WorkspaceRoutine } from "@sugabots/contracts";
import { DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Authorization } from "../../authorization/authorization.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { agent, pod, routine, routineExecution, thread } from "../../database/schema.ts";
import type { UserFacing } from "../../user-message.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/agent.ts";
import { decodeCursor, earlierThan, encodeCursor } from "../cursor.ts";
import { crewOf } from "../threads/participants.ts";
import { toRoutineExecution } from "./execution.ts";
import {
	inScope,
	RoutineNotFound,
	routineWithTriggers,
	scopeOf,
	toRoutine,
	triggersOf,
} from "./routine.ts";
import type { Routines } from "./routines.ts";

/** What the routine screens show: the view half of `Routines.Service`. */
export const makeView = Effect.gen(function* () {
	const operation = yield* serviceOperations<ViewMethods>("Routines");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;

	return {
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
					const triggers = yield* triggersOf(rows.map((row) => row.routine.id));
					return rows.flatMap((row): WorkspaceRoutine[] => {
						const crew = crewAgentRow(row.agent);
						const routineTriggers = triggers.get(row.routine.id) ?? [];
						return crew
							? [
									{
										routine: toRoutine(row.routine, routineTriggers),
										agent: toAgent(crew),
										pod: row.pod,
									},
								]
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
					const triggers = yield* triggersOf(rows.map((row) => row.id));
					return rows.map((row) => toRoutine(row, triggers.get(row.id) ?? []));
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
					return yield* routineWithTriggers(row);
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
							.select({ run: routineExecution, conversationId: thread.conversationId })
							.from(routineExecution)
							.innerJoin(thread, eq(thread.id, routineExecution.threadId))
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
					const oldest = items.at(-1)?.run;
					return {
						items: items.map(({ run, conversationId }) => {
							if (!conversationId) throw new Error(`Routine run ${run.id} is in no conversation`);
							return toRoutineExecution(run, conversationId);
						}),
						nextCursor:
							rows.length > page.limit && oldest
								? encodeCursor({ at: oldest.acceptedAt, id: oldest.id })
								: null,
					};
				}),
			),
	} satisfies ViewMethods;
});

type ViewMethods = Pick<Routines.Interface, "listInWorkspace" | "list" | "get" | "listExecutions">;

export class InvalidRoutineExecutionCursor
	extends Data.TaggedError("InvalidRoutineExecutionCursor")
	implements UserFacing
{
	get userMessage() {
		return userText`That Routine execution cursor is invalid`;
	}
}

const executionCursor = (cursor: string) => {
	const point = decodeCursor(cursor);
	return point ? Effect.succeed(point) : Effect.fail(new InvalidRoutineExecutionCursor());
};
