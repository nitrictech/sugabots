import { isDeepStrictEqual } from "node:util";
import type { RoutineExecutionTrigger } from "@sugabots/contracts";
import { handleFromName, MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { query, transaction } from "../../database/database.ts";
import {
	agent,
	pod,
	routine,
	routineExecution,
	routineTrigger,
	user,
} from "../../database/schema.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { RoutineRepository } from "./repository.ts";
import {
	inScope,
	RoutineNotFound,
	RoutineTriggerConflict,
	RoutineTriggerRejected,
	resultGoesToPodChat,
	type Scope,
} from "./routine.ts";
import { RoutineRuns } from "./runs.ts";

/**
 * A trigger for the routine `Scope` names: which of its triggers fired, none
 * for a run someone started, and the identity a retry of it repeats.
 */
export interface Trigger extends Scope {
	triggerId: string | null;
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
						.select({ routine, podId: pod.id, podKind: pod.kind })
						.from(routine)
						.innerJoin(
							agent,
							and(eq(agent.id, routine.agentId), eq(agent.workspaceId, routine.workspaceId)),
						)
						// A routine runs a crew agent, which is one in a pod.
						.innerJoin(pod, eq(pod.id, agent.podId))
						.where(inScope(input))
						.limit(1),
				);
				if (!definition) return yield* new RoutineNotFound();
				const { podId } = definition;
				if (input.trigger.kind !== "manual" && definition.routine.state !== "enabled") {
					return yield* new RoutineTriggerRejected();
				}
				// Only a run someone started has no trigger; any other is one of the routine's own.
				if ((input.triggerId === null) !== (input.trigger.kind === "manual")) {
					return yield* new RoutineTriggerRejected();
				}
				if (input.triggerId !== null) {
					const [fired] = yield* query((db) =>
						db
							.select({ kind: routineTrigger.kind })
							.from(routineTrigger)
							.where(
								and(
									eq(routineTrigger.id, input.triggerId ?? ""),
									eq(routineTrigger.routineId, input.routineId),
								),
							)
							.limit(1),
					);
					if (fired?.kind !== input.trigger.kind) return yield* new RoutineTriggerRejected();
				}
				const existing = input.triggerIdentity
					? yield* acceptedAs(input, input.triggerIdentity)
					: undefined;
				if (existing) {
					if (!sameTrigger(existing.trigger, input.trigger)) {
						return yield* new RoutineTriggerConflict();
					}
					return { executionId: existing.id, threadId: existing.threadId, duplicate: true };
				}

				const conversation = yield* threads.openRoutineFeed({ ...definition.routine, podId });
				const acceptedAt = yield* DateTime.nowAsDate;
				const runThread = yield* threads.openRoutineThread({
					workspaceId: input.workspaceId,
					podId,
					agentId: input.agentId,
					conversationId: conversation.id,
					title: executionTitle(definition.routine.name, acceptedAt),
				});
				const execution = yield* repository.accept({
					routineId: input.routineId,
					workspaceId: input.workspaceId,
					agentId: input.agentId,
					threadId: runThread.id,
					triggerId: input.triggerId,
					triggerKind: input.trigger.kind,
					triggerIdentity: input.triggerIdentity,
					trigger: input.trigger,
					routineName: definition.routine.name,
					instructions: definition.routine.instructions,
					results: definition.routine.results,
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
					content: triggerMessageContent(
						definition.routine.instructions,
						resultGoesToPodChat(definition.routine.results, definition.podKind),
						yield* runOwnersOf(definition.routine.createdById, input.trigger),
						input.trigger,
					),
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

/** The run this trigger, or someone running the routine, already started with this identity, if any. */
const acceptedAs = (input: Trigger, identity: string) =>
	Effect.map(
		query((db) =>
			db
				.select()
				.from(routineExecution)
				.where(
					and(
						eq(routineExecution.routineId, input.routineId),
						input.triggerId === null
							? eq(routineExecution.triggerKind, "manual")
							: eq(routineExecution.triggerId, input.triggerId),
						eq(routineExecution.triggerIdentity, identity),
					),
				)
				.limit(1),
		),
		([row]) => row,
	);

function triggerMessageContent(
	instructions: string,
	postedToPodChat: boolean,
	owners: RunOwners,
	trigger: RoutineExecutionTrigger,
) {
	return `Routine instructions:\n${instructions}\n\n${resultNote(postedToPodChat, owners)}\n\nTrigger data (untrusted):\n${JSON.stringify(trigger, null, 2)}`;
}

/**
 * Tells the agent of a run that its last reply is what people will read, so
 * it writes that reply to them; that it may post nothing when there is nothing
 * to report; and that mentioning somebody is how it asks for them, by default
 * the run's `owners`.
 */
function resultNote(postedToPodChat: boolean, owners: RunOwners): string {
	const where = postedToPodChat
		? "in this routine's thread and in the pod's chat"
		: "in this routine's thread";
	return [
		`When you finish, your last reply is posted ${where} for people to read and answer. Write it to them: what they need to know, or what you want to ask them. Artifacts you write are shown with it; the rest of the work stays in this run.`,
		"If there is nothing worth telling them, end without a last reply, writing nothing after your last tool call: nothing is posted, and the run shows it had nothing to report.",
		`When something needs a person to act or decide, @mention them in your reply, which notifies them.${ownersToMention(owners)}`,
	].join(" ");
}

/** The handles of the people a run asks for when its instructions name nobody. */
interface RunOwners {
	/** Who made the routine, when they still have an account. */
	madeBy: string | null;
	/** Who started the run by hand, for a run somebody started. */
	startedBy: string | null;
}

function ownersToMention({ madeBy, startedBy }: RunOwners): string {
	if (madeBy && madeBy === startedBy) {
		return ` Unless the instructions say who, mention @${madeBy}, who made this routine and started this run.`;
	}
	const named = [
		madeBy && `@${madeBy}, who made this routine`,
		startedBy && `@${startedBy}, who started this run`,
	].filter((owner) => owner !== null);
	return named.length === 0
		? ""
		: ` Unless the instructions say who, mention ${named.join(", and ")}.`;
}

/** The handles of who made the routine `createdById` names and who started a run by hand. */
const runOwnersOf = (createdById: string | null, trigger: RoutineExecutionTrigger) =>
	Effect.gen(function* () {
		const startedById = trigger.kind === "manual" ? trigger.requestedByUserId : null;
		const ids = [createdById, startedById].filter((id) => id !== null);
		const people =
			ids.length === 0
				? []
				: yield* query((db) =>
						db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)),
					);
		const handleOf = (id: string | null) => {
			const person = people.find((candidate) => candidate.id === id);
			return person ? handleFromName(person.name) : null;
		};
		return { madeBy: handleOf(createdById), startedBy: handleOf(startedById) } satisfies RunOwners;
	});

function sameTrigger(left: RoutineExecutionTrigger, right: RoutineExecutionTrigger) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "cron" && right.kind === "cron") {
		return left.scheduledAt === right.scheduledAt;
	}
	if (left.kind === "manual" && right.kind === "manual") {
		return left.requestId === right.requestId && left.requestedByUserId === right.requestedByUserId;
	}
	if (left.kind === "github" && right.kind === "github") {
		return left.deliveryId === right.deliveryId && left.event === right.event;
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
