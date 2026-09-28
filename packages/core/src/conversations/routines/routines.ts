export * as Routines from "./routines.ts";

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineExecutionTrigger,
	RoutineUpdate,
} from "@sugabots/contracts";
import { MAX_THREAD_TITLE_CHARACTERS } from "@sugabots/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Context, Data, DateTime, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { agent, message, routine, routineExecution } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { TurnRequests } from "../turns/requests.ts";
import { RoutineRepository } from "./repository.ts";
import type { RoutineRun } from "./routine.workflow.ts";
import { toRoutine } from "./routine-view.ts";
import { RoutineRuns } from "./runs.ts";
import {
	type InvalidRoutineSchedule,
	latestMissedAndNextOccurrence,
	nextOccurrence,
} from "./schedule.ts";

/**
 * What a crew agent does on a schedule, on a webhook, or when asked: the
 * routines people define, the triggers that start a run of one, and the runs
 * themselves, each in its own thread in the agent's chat.
 *
 * A run is started by its workflow, one at a time per routine, and ended by
 * `RoutineSettlement`.
 */
export interface Interface {
	/**
	 * Defines a routine on a crew agent. A webhook routine's secret is
	 * returned once, here, and never again.
	 */
	readonly create: (
		owner: { workspaceId: string; agentId: string; createdById: string },
		input: NewRoutine,
	) => Effect.Effect<
		Defined,
		RoutineRepository.RoutineNameTaken | RoutineRequiresCrewAgent | InvalidRoutineSchedule
	>;
	/** Changes a routine. Switching it to a webhook returns its new secret. */
	readonly update: (
		scope: RoutineRepository.Scope,
		input: RoutineUpdate,
	) => Effect.Effect<
		Defined,
		RoutineNotFound | RoutineRepository.RoutineNameTaken | InvalidRoutineSchedule
	>;
	readonly remove: (scope: RoutineRepository.Scope) => Effect.Effect<void, RoutineNotFound>;
	/** A new secret for a webhook routine, replacing the old one. */
	readonly rotateSecret: (
		scope: RoutineRepository.Scope,
	) => Effect.Effect<string, RoutineNotFound | RoutineTriggerRejected>;
	/**
	 * Accepts a run of the routine: opens its thread, posts the trigger, and
	 * queues the run. A trigger with an identity already accepted returns that
	 * run again, as a duplicate.
	 */
	readonly acceptTrigger: (
		input: RoutineRepository.Scope & {
			trigger: RoutineExecutionTrigger;
			triggerIdentity: string | null;
		},
	) => Effect.Effect<
		AcceptedRoutineExecution,
		RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected
	>;
	/**
	 * Accepts a webhook's run, if `secret` is the routine's. `undefined` when
	 * it is not, or there is no such enabled webhook routine: the caller is
	 * told the same either way.
	 */
	readonly acceptWebhook: (
		routineId: string,
		secret: string,
		trigger: Extract<RoutineExecutionTrigger, { kind: "webhook" }>,
	) => Effect.Effect<
		AcceptedRoutineExecution | undefined,
		RoutineTriggerConflict | RoutineTriggerRejected
	>;
	/**
	 * Accepts the run of the cron routine due soonest, if one is due at `now`
	 * (by default, the current time), and schedules its next.
	 */
	readonly processNextDue: (
		now?: Date,
	) => Effect.Effect<
		AcceptedRoutineExecution | undefined,
		InvalidRoutineSchedule | RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected
	>;
	/** Marks a queued run started and asks for its turn. Does nothing once the run has ended. */
	readonly startRun: (run: RoutineRun) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Routines") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Routines");
	const records = yield* RoutineRepository.Service;
	const threads = yield* ThreadRepository.Service;
	const requests = yield* TurnRequests.Service;
	const runs = yield* RoutineRuns.Service;

	const acceptTrigger = (input: Parameters<Interface["acceptTrigger"]>[0]) =>
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
						.where(RoutineRepository.inScope(input))
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
				const execution = yield* records.accept({
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
					chatId: chat.id,
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

	return Service.of({
		create: (owner, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const state = input.state ?? "enabled";
					const schedule =
						input.trigger.kind === "cron" && state === "enabled"
							? yield* nextOccurrence(input.trigger.expression, input.trigger.timezone)
							: null;
					const secret = input.trigger.kind === "webhook" ? generateSecret() : null;
					return yield* transaction(
						Effect.gen(function* () {
							const [owning] = yield* query((db) =>
								db
									.select({ podId: agent.podId })
									.from(agent)
									.where(and(eq(agent.id, owner.agentId), eq(agent.workspaceId, owner.workspaceId)))
									.limit(1),
							);
							if (!owning?.podId) return yield* new RoutineRequiresCrewAgent();
							const row = yield* records.create({
								...owner,
								name: input.name,
								instructions: input.instructions,
								triggerKind: input.trigger.kind,
								cronExpression: input.trigger.kind === "cron" ? input.trigger.expression : null,
								cronTimezone: input.trigger.kind === "cron" ? input.trigger.timezone : null,
								nextScheduledAt: schedule,
								webhookSecretDigest: secret ? hashSecret(secret) : null,
								state,
							});
							return { routine: toRoutine(row), secret };
						}),
					);
				}),
			),

		update: (scope, input) =>
			operation(
				"update",
				transaction(
					Effect.gen(function* () {
						const [current] = yield* query((db) =>
							db.select().from(routine).where(RoutineRepository.inScope(scope)).limit(1),
						);
						if (!current) return yield* new RoutineNotFound();
						const trigger = input.trigger ?? toRoutine(current).trigger;
						const state = input.state ?? current.state;
						const scheduleChanged = input.trigger?.kind === "cron";
						const reenabled = input.state === "enabled" && current.state === "paused";
						const schedule =
							trigger.kind !== "cron" || state === "paused"
								? null
								: scheduleChanged || reenabled
									? yield* nextOccurrence(trigger.expression, trigger.timezone)
									: current.nextScheduledAt;
						const switchedToWebhook =
							input.trigger?.kind === "webhook" && current.triggerKind !== "webhook";
						const secret = switchedToWebhook ? generateSecret() : null;
						const row = yield* records.update(scope, {
							name: input.name ?? current.name,
							instructions: input.instructions ?? current.instructions,
							state,
							triggerKind: trigger.kind,
							cronExpression: trigger.kind === "cron" ? trigger.expression : null,
							cronTimezone: trigger.kind === "cron" ? trigger.timezone : null,
							nextScheduledAt: schedule,
							webhookSecretDigest:
								trigger.kind !== "webhook"
									? null
									: secret
										? hashSecret(secret)
										: current.webhookSecretDigest,
						});
						if (!row) return yield* new RoutineNotFound();
						return { routine: toRoutine(row), secret };
					}),
				),
			),

		remove: (scope) =>
			operation(
				"remove",
				transaction(
					Effect.gen(function* () {
						yield* lockTriggers(scope.routineId);
						if (!(yield* records.remove(scope))) return yield* new RoutineNotFound();
					}),
				),
			),

		rotateSecret: (scope) =>
			operation(
				"rotateSecret",
				transaction(
					Effect.gen(function* () {
						const secret = generateSecret();
						yield* lockTriggers(scope.routineId);
						if (yield* records.replaceWebhookSecret(scope, hashSecret(secret))) return secret;
						const [exists] = yield* query((db) =>
							db.select({ id: routine.id }).from(routine).where(RoutineRepository.inScope(scope)),
						);
						if (!exists) return yield* new RoutineNotFound();
						return yield* new RoutineTriggerRejected();
					}),
				),
			),

		acceptTrigger: (input) => operation("acceptTrigger", acceptTrigger(input)),

		acceptWebhook: (routineId, secret, trigger) =>
			operation(
				"acceptWebhook",
				transaction(
					Effect.gen(function* () {
						yield* lockTriggers(routineId);
						const found = isUuid(routineId) ? yield* enabledWebhook(routineId) : undefined;
						const valid = yield* Effect.promise(() =>
							verifySecret(secret, found?.digest ?? DUMMY_SECRET_DIGEST),
						);
						if (!valid || !found) return undefined;
						return yield* acceptTrigger({
							workspaceId: found.workspaceId,
							agentId: found.agentId,
							routineId,
							triggerIdentity: trigger.idempotencyKey,
							trigger,
						}).pipe(Effect.catchTag("RoutineNotFound", () => Effect.undefined));
					}),
				),
			),

		processNextDue: (now) =>
			operation(
				"processNextDue",
				transaction(
					Effect.gen(function* () {
						const at = now ?? (yield* DateTime.nowAsDate);
						const due = yield* records.lockNextDue(at);
						if (!due) return undefined;
						if (!due.cronExpression || !due.cronTimezone) {
							return yield* Effect.die(new Error("Cron Routine has incomplete schedule data"));
						}
						const occurrence = yield* latestMissedAndNextOccurrence(
							due.cronExpression,
							due.cronTimezone,
							at,
						);
						const scheduledAt = occurrence.latest.toISOString();
						const accepted = yield* acceptTrigger({
							workspaceId: due.workspaceId,
							agentId: due.agentId,
							routineId: due.id,
							triggerIdentity: scheduledAt,
							trigger: { kind: "cron", scheduledAt, acceptedAt: at.toISOString() },
						});
						yield* records.scheduleNext(due.id, occurrence.next);
						return accepted;
					}),
				),
			),

		startRun: (run) =>
			operation(
				"startRun",
				transaction(
					Effect.gen(function* () {
						const execution = yield* records.start(run.executionId);
						if (!execution) return;
						const [triggerMessage] = yield* query((db) =>
							db
								.select({ id: message.id })
								.from(message)
								.where(
									and(
										eq(message.threadId, execution.threadId),
										sql`${message.routineTrigger} is not null`,
									),
								)
								.limit(1),
						);
						if (!triggerMessage) {
							return yield* Effect.die(new Error("Routine trigger message is missing"));
						}
						// Asking again for a turn already asked for joins it, so a start
						// repeated after a crash does not run the turn twice.
						yield* requests.queueTurn({
							threadId: execution.threadId,
							agentId: execution.agentId,
							triggerMessageId: triggerMessage.id,
							reason: "routine",
						});
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([RoutineRepository.layer, ThreadRepository.layer]),
);

/** A routine as defined, with the webhook secret made for it, if one was. */
export interface Defined {
	routine: Routine;
	secret: string | null;
}

export class RoutineNotFound extends Data.TaggedError("RoutineNotFound") implements UserFacing {
	get userMessage() {
		return UserMessage.of`No such Routine`;
	}
}

export class RoutineRequiresCrewAgent
	extends Data.TaggedError("RoutineRequiresCrewAgent")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`Only crew agents can own Routines`;
	}
}

export class RoutineTriggerConflict
	extends Data.TaggedError("RoutineTriggerConflict")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That trigger identity was already used with different data`;
	}
}

export class RoutineTriggerRejected
	extends Data.TaggedError("RoutineTriggerRejected")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That Routine cannot accept this trigger`;
	}
}

/**
 * Holds the routine's trigger lock until the transaction ends, so its
 * triggers are accepted one at a time and none lands on a routine being
 * removed.
 */
const lockTriggers = (routineId: string) =>
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

const enabledWebhook = (routineId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({
					digest: routine.webhookSecretDigest,
					workspaceId: routine.workspaceId,
					agentId: routine.agentId,
				})
				.from(routine)
				.where(
					and(
						eq(routine.id, routineId),
						eq(routine.triggerKind, "webhook"),
						eq(routine.state, "enabled"),
						isNull(routine.deletedAt),
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

const deriveKey = promisify(scrypt);

function generateSecret() {
	return randomBytes(32).toString("base64url");
}

function hashSecret(secret: string) {
	const salt = randomBytes(16);
	const digest = scryptSync(secret, salt, 32);
	return `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

const DUMMY_SECRET_DIGEST = hashSecret("not-a-routine-secret");

async function verifySecret(secret: string, encoded: string) {
	const [algorithm, saltText, digestText] = encoded.split(":");
	if (algorithm !== "scrypt" || !saltText || !digestText) return false;
	try {
		const expected = Buffer.from(digestText, "base64url");
		const actual = Buffer.from(
			(await deriveKey(secret, Buffer.from(saltText, "base64url"), expected.length)) as ArrayBuffer,
		);
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}
