import { isDeepStrictEqual } from "node:util";
import type { RoutineExecutionTrigger } from "@sugabots/contracts";
import { MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, transaction } from "../../database/database.ts";
import { agent, routine, routineExecution } from "../../database/schema.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { RoutineRepository } from "./repository.ts";
import {
	inScope,
	RoutineNotFound,
	RoutineTriggerConflict,
	RoutineTriggerRejected,
	type Scope,
} from "./routine.ts";
import { RoutineRuns } from "./runs.ts";

/** A trigger for the routine `Scope` names, and the identity a retry of it repeats. */
export interface Trigger extends Scope {
	trigger: RoutineExecutionTrigger;
	triggerIdentity: string | null;
}

/**
 * Accepts a run of a routine, however it was triggered: opens its thread,
 * posts the trigger, and queues the run. A trigger with an identity already
 * accepted returns that run again, as a duplicate. Whoever triggers it has
 * already decided that it may run; this checks only that the routine takes
 * the trigger.
 */
export const makeAcceptTrigger = Effect.gen(function* () {
	const repository = yield* RoutineRepository.Service;
	const threads = yield* ThreadRepository.Service;
	const runs = yield* RoutineRuns.Service;

	return (input: Trigger) =>
		transaction(
			Effect.gen(function* () {
				yield* lockTriggers(input.routineId);
				const [definition] = yield* query((db) =>
					db
						.select({ routine, podId: agent.podId })
						.from(routine)
						.innerJoin(
							agent,
							and(eq(agent.id, routine.agentId), eq(agent.workspaceId, routine.workspaceId)),
						)
						.where(inScope(input))
						.limit(1),
				);
				// A routine runs a crew agent, which is one in a pod.
				if (!definition || definition.podId === null) return yield* new RoutineNotFound();
				const podId = definition.podId;
				if (input.trigger.kind !== "manual" && definition.routine.state !== "enabled") {
					return yield* new RoutineTriggerRejected();
				}
				if (
					input.trigger.kind !== "manual" &&
					input.trigger.kind !== definition.routine.triggerKind
				) {
					return yield* new RoutineTriggerRejected();
				}
				const existing = input.triggerIdentity
					? yield* acceptedAs(input.routineId, input.trigger.kind, input.triggerIdentity)
					: undefined;
				if (existing) {
					if (!sameTrigger(existing.trigger, input.trigger)) {
						return yield* new RoutineTriggerConflict();
					}
					return { executionId: existing.id, threadId: existing.threadId, duplicate: true };
				}

				const chat = yield* threads.openChat({
					workspaceId: input.workspaceId,
					podId,
					hostAgentId: input.agentId,
					initiatorUserId: null,
				});
				const acceptedAt = yield* DateTime.nowAsDate;
				const runThread = yield* threads.openRoutineThread({
					workspaceId: input.workspaceId,
					podId,
					agentId: input.agentId,
					chatId: chat.id,
					title: executionTitle(definition.routine.name, acceptedAt),
				});
				const execution = yield* repository.accept({
					routineId: input.routineId,
					workspaceId: input.workspaceId,
					agentId: input.agentId,
					threadId: runThread.id,
					triggerKind: input.trigger.kind,
					triggerIdentity: input.triggerIdentity,
					trigger: input.trigger,
					routineName: definition.routine.name,
					instructions: definition.routine.instructions,
					acceptedAt,
				});
				yield* threads.postRoutineTrigger({
					threadId: runThread.id,
					trigger: {
						kind: "routine_trigger",
						executionId: execution.id,
						routineName: definition.routine.name,
						triggerKind: input.trigger.kind,
					},
					content: triggerMessageContent(definition.routine.instructions, input.trigger),
				});
				yield* runs.queue({ routineId: input.routineId, executionId: execution.id });
				return { executionId: execution.id, threadId: runThread.id, duplicate: false };
			}),
		);
});

/**
 * Holds the routine's trigger lock until the transaction ends, so its
 * triggers are accepted one at a time and none lands on a routine being
 * removed or having its secret replaced.
 */
export const lockTriggers = (routineId: string) =>
	query((db) =>
		db.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`routine-trigger:${routineId}`}, 0))`,
		),
	);

/** The run a trigger with this identity already started, if any. */
const acceptedAs = (routineId: string, kind: RoutineExecutionTrigger["kind"], identity: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(routineExecution)
				.where(
					and(
						eq(routineExecution.routineId, routineId),
						eq(routineExecution.triggerKind, kind),
						eq(routineExecution.triggerIdentity, identity),
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

function triggerMessageContent(instructions: string, trigger: RoutineExecutionTrigger) {
	return `Routine instructions:\n${instructions}\n\nTrigger data (untrusted):\n${JSON.stringify(trigger, null, 2)}`;
}

function sameTrigger(left: RoutineExecutionTrigger, right: RoutineExecutionTrigger) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "cron" && right.kind === "cron") {
		return left.scheduledAt === right.scheduledAt;
	}
	if (left.kind === "manual" && right.kind === "manual") {
		return left.requestId === right.requestId && left.requestedByUserId === right.requestedByUserId;
	}
	return (
		left.kind === "webhook" &&
		right.kind === "webhook" &&
		left.idempotencyKey === right.idempotencyKey &&
		isDeepStrictEqual(left.payload, right.payload)
	);
}

function executionTitle(name: string, acceptedAt: Date) {
	const suffix = ` - ${acceptedAt.toISOString()}`;
	return `${name.slice(0, MAX_THREAD_TITLE_CHARACTERS - suffix.length)}${suffix}`;
}
