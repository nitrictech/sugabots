import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual, promisify } from "node:util";
import type {
	AcceptedRoutineExecution,
	NewRoutine,
	Routine,
	RoutineExecutionPage,
	RoutineExecutionPageQuery,
	RoutineExecutionTrigger,
	RoutineUpdate,
	WorkspaceRoutine,
} from "@sugabots/contracts";
import {
	DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT,
	MAX_THREAD_TITLE_CHARACTERS,
	streamEvent,
	threadChannel,
	workspaceChannel,
} from "@sugabots/contracts";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, queryCatching, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type { PublishEvents } from "../../database/events/publish.ts";
import { isUuid } from "../../database/ids.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	chat,
	collaboration,
	message,
	pod,
	routine,
	routineExecution,
	thread,
	threadParticipant,
	toolCall,
	turn,
} from "../../database/schema.ts";
import { dropWaiting, laneBusy } from "../../workflows/lanes.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/store.ts";
import { Facilitate } from "../turns/facilitate.workflow.ts";
import type { QueueTurn } from "../turns/queue.ts";
import type { TurnSignals } from "../turns/signals.ts";
import { Turn } from "../turns/turn.workflow.ts";
import { routineSettlementLockKey, toRoutineExecution } from "./execution.ts";
import type { RoutineRun } from "./routine.workflow.ts";
import type { RoutineRuns } from "./runs.ts";
import {
	type InvalidRoutineSchedule,
	latestMissedAndNextOccurrence,
	nextOccurrence,
} from "./schedule.ts";

const deriveKey = promisify(scrypt);

/** What people are told about a run whose workflow failed; the cause goes only to the logs. */
const RUN_STOPPED_UNEXPECTEDLY = "The routine run stopped unexpectedly";

interface ExecutionCursor {
	acceptedAt: Date;
	id: string;
}

export class RoutineNotFound extends Data.TaggedError("RoutineNotFound") {}
export class RoutineNameTaken extends Data.TaggedError("RoutineNameTaken") {}
export class RoutineRequiresCrewAgent extends Data.TaggedError("RoutineRequiresCrewAgent") {}
export class RoutineTriggerConflict extends Data.TaggedError("RoutineTriggerConflict") {}
export class RoutineTriggerRejected extends Data.TaggedError("RoutineTriggerRejected") {}
export class InvalidRoutineExecutionCursor extends Data.TaggedError(
	"InvalidRoutineExecutionCursor",
) {
	override get message() {
		return "That Routine execution cursor is invalid";
	}
}

export interface CreatedRoutine {
	routine: Routine;
	secret: string | null;
}

export interface AcceptRoutineTriggerInput {
	workspaceId: string;
	agentId: string;
	routineId: string;
	trigger: RoutineExecutionTrigger;
	triggerIdentity: string | null;
}

export interface RoutineStore {
	/** Every routine on a crew bot in a pod the person reaches, by name, with its bot and pod. */
	listInWorkspace(
		workspaceId: string,
		userId: string,
	): Effect.Effect<WorkspaceRoutine[], never, Database>;
	list(workspaceId: string, agentId: string): Effect.Effect<Routine[], never, Database>;
	get(
		workspaceId: string,
		agentId: string,
		routineId: string,
	): Effect.Effect<Routine | undefined, never, Database>;
	create(
		workspaceId: string,
		agentId: string,
		createdById: string,
		input: NewRoutine,
	): Effect.Effect<
		CreatedRoutine,
		RoutineNameTaken | RoutineRequiresCrewAgent | InvalidRoutineSchedule,
		Database
	>;
	update(
		workspaceId: string,
		agentId: string,
		routineId: string,
		input: RoutineUpdate,
	): Effect.Effect<
		CreatedRoutine,
		RoutineNotFound | RoutineNameTaken | InvalidRoutineSchedule,
		Database
	>;
	remove(
		workspaceId: string,
		agentId: string,
		routineId: string,
	): Effect.Effect<void, RoutineNotFound, Database>;
	acceptTrigger(
		input: AcceptRoutineTriggerInput,
	): Effect.Effect<
		AcceptedRoutineExecution,
		RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected,
		Database
	>;
	listExecutions(
		workspaceId: string,
		agentId: string,
		routineId: string,
		page?: RoutineExecutionPageQuery,
	): Effect.Effect<RoutineExecutionPage | undefined, InvalidRoutineExecutionCursor, Database>;
	/** Marks a queued run started and asks for its turn. Does nothing once the run has ended. */
	startRun(run: RoutineRun): Effect.Effect<void, never, Database>;
	settleThread(
		threadId: string,
		outcome?: { state: "failed" | "cancelled"; error?: string },
	): Effect.Effect<boolean, never, Database>;
	/** Settles the run if its work is done. Returns whether it has ended. */
	settleRun(run: RoutineRun): Effect.Effect<boolean, never, Database>;
	/**
	 * Records a run that has not ended as failed, at once, and stops its work.
	 * People are told only that it stopped unexpectedly. Does nothing once the
	 * run has ended.
	 */
	failRun(run: RoutineRun): Effect.Effect<void, never, Database>;
	processNextDue(
		now?: Date,
	): Effect.Effect<
		AcceptedRoutineExecution | undefined,
		InvalidRoutineSchedule | RoutineNotFound | RoutineTriggerConflict | RoutineTriggerRejected,
		Database
	>;
	rotateSecret(
		workspaceId: string,
		agentId: string,
		routineId: string,
	): Effect.Effect<string, RoutineNotFound | RoutineTriggerRejected, Database>;
	acceptWebhook(
		routineId: string,
		secret: string,
		trigger: Extract<RoutineExecutionTrigger, { kind: "webhook" }>,
	): Effect.Effect<
		AcceptedRoutineExecution | undefined,
		RoutineTriggerConflict | RoutineTriggerRejected,
		Database
	>;
}

export function routineStore(
	publishEvents: PublishEvents,
	queueTurn: QueueTurn,
	signals: TurnSignals,
	runs: RoutineRuns,
): RoutineStore {
	const store: RoutineStore = {
		listInWorkspace: (workspaceId, userId) =>
			query((db) =>
				Effect.gen(function* () {
					const rows = yield* db
						.select({ routine, agent, pod: { id: pod.id, slug: pod.slug } })
						.from(routine)
						.innerJoin(agent, eq(agent.id, routine.agentId))
						.innerJoin(pod, eq(pod.id, agent.podId))
						.where(
							and(
								eq(routine.workspaceId, workspaceId),
								isNull(routine.deletedAt),
								isNull(agent.systemAgentKey),
								reachesPod(pod.id, userId),
							),
						)
						.orderBy(asc(routine.name), asc(routine.id));
					return rows.flatMap((row): WorkspaceRoutine[] => {
						const crew = crewAgentRow(row.agent);
						return crew
							? [{ routine: toRoutine(row.routine), agent: toAgent(crew), pod: row.pod }]
							: [];
					});
				}),
			),

		list: (workspaceId, agentId) =>
			query((db) =>
				Effect.gen(function* () {
					const rows = yield* db
						.select()
						.from(routine)
						.where(
							and(
								eq(routine.workspaceId, workspaceId),
								eq(routine.agentId, agentId),
								isNull(routine.deletedAt),
							),
						)
						.orderBy(asc(routine.name));
					return rows.map(toRoutine);
				}),
			),

		get: (workspaceId, agentId, routineId) =>
			query((db) =>
				Effect.gen(function* () {
					const [row] = yield* db
						.select()
						.from(routine)
						.where(routineScope(workspaceId, agentId, routineId))
						.limit(1);
					return row ? toRoutine(row) : undefined;
				}),
			),

		create: (workspaceId, agentId, createdById, input) =>
			Effect.gen(function* () {
				const schedule =
					input.trigger.kind === "cron" && (input.state ?? "enabled") === "enabled"
						? yield* nextOccurrence(input.trigger.expression, input.trigger.timezone)
						: null;
				const secret = input.trigger.kind === "webhook" ? generateSecret() : null;
				const digest = secret ? hashSecret(secret) : null;
				return yield* transaction(
					Effect.gen(function* () {
						const [owner] = yield* query((db) =>
							db
								.select({ systemAgentKey: agent.systemAgentKey })
								.from(agent)
								.where(and(eq(agent.id, agentId), eq(agent.workspaceId, workspaceId)))
								.limit(1),
						);
						if (!owner || owner.systemAgentKey) return yield* new RoutineRequiresCrewAgent();
						const [row] = yield* queryCatching(
							(db) =>
								db
									.insert(routine)
									.values({
										workspaceId,
										agentId,
										createdById,
										name: input.name,
										instructions: input.instructions,
										triggerKind: input.trigger.kind,
										cronExpression: input.trigger.kind === "cron" ? input.trigger.expression : null,
										cronTimezone: input.trigger.kind === "cron" ? input.trigger.timezone : null,
										nextScheduledAt: schedule,
										webhookSecretDigest: digest,
										state: input.state ?? "enabled",
									})
									.returning(),
							(rejection) => (isUniqueViolation(rejection) ? new RoutineNameTaken() : undefined),
						);
						if (!row) return yield* Effect.die(new Error("Routine insert returned no row"));
						return { routine: toRoutine(row), secret };
					}),
				);
			}),

		update: (workspaceId, agentId, routineId, input) =>
			transaction(
				Effect.gen(function* () {
					const [current] = yield* query((db) =>
						db
							.select()
							.from(routine)
							.where(routineScope(workspaceId, agentId, routineId))
							.limit(1),
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
					const [row] = yield* queryCatching(
						(db) =>
							db
								.update(routine)
								.set({
									name: input.name,
									instructions: input.instructions,
									state,
									triggerKind: trigger.kind,
									cronExpression: trigger.kind === "cron" ? trigger.expression : null,
									cronTimezone: trigger.kind === "cron" ? trigger.timezone : null,
									nextScheduledAt: schedule,
									webhookSecretDigest:
										trigger.kind === "webhook"
											? switchedToWebhook
												? hashSecret(secret ?? "")
												: current.webhookSecretDigest
											: null,
								})
								.where(routineScope(workspaceId, agentId, routineId))
								.returning(),
						(rejection) => (isUniqueViolation(rejection) ? new RoutineNameTaken() : undefined),
					);
					if (!row) return yield* new RoutineNotFound();
					return { routine: toRoutine(row), secret };
				}),
			),

		remove: (workspaceId, agentId, routineId) =>
			transaction(
				Effect.gen(function* () {
					yield* lock(`routine-trigger:${routineId}`);
					const now = new Date();
					const [removed] = yield* query((db) =>
						db
							.update(routine)
							.set({ deletedAt: now, state: "paused", nextScheduledAt: null })
							.where(routineScope(workspaceId, agentId, routineId))
							.returning({ id: routine.id }),
					);
					if (!removed) return yield* new RoutineNotFound();
					yield* query((db) =>
						db
							.update(routineExecution)
							.set({ state: "cancelled", finishedAt: now })
							.where(
								and(
									eq(routineExecution.routineId, routineId),
									eq(routineExecution.state, "queued"),
								),
							),
					);
				}),
			),

		acceptTrigger: (input) =>
			transaction(
				Effect.gen(function* () {
					const triggerIdentity = input.triggerIdentity;
					yield* lock(`routine-trigger:${input.routineId}`);
					const [definition] = yield* query((db) =>
						db
							.select({ routine, podId: agent.podId, systemAgentKey: agent.systemAgentKey })
							.from(routine)
							.innerJoin(
								agent,
								and(eq(agent.id, routine.agentId), eq(agent.workspaceId, routine.workspaceId)),
							)
							.where(routineScope(input.workspaceId, input.agentId, input.routineId))
							.limit(1),
					);
					// A routine runs a crew agent in a pod. A system agent has neither,
					// and `agent_placement_check` is what makes those one condition.
					if (!definition || definition.podId === null || definition.systemAgentKey) {
						return yield* new RoutineNotFound();
					}
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
					if (triggerIdentity) {
						const [existing] = yield* query((db) =>
							db
								.select()
								.from(routineExecution)
								.where(
									and(
										eq(routineExecution.routineId, input.routineId),
										eq(routineExecution.triggerKind, input.trigger.kind),
										eq(routineExecution.triggerIdentity, triggerIdentity),
									),
								)
								.limit(1),
						);
						if (existing) {
							if (!sameTrigger(existing.trigger, input.trigger)) {
								return yield* new RoutineTriggerConflict();
							}
							return { executionId: existing.id, threadId: existing.threadId, duplicate: true };
						}
					}

					const currentChat = yield* ensureAutomatedChat(input.workspaceId, podId, input.agentId);
					const acceptedAt = new Date();
					const [executionThread] = yield* query((db) =>
						db
							.insert(thread)
							.values({
								workspaceId: input.workspaceId,
								podId,
								hostAgentId: input.agentId,
								chatId: currentChat.id,
								type: "routine",
								title: executionTitle(definition.routine.name, acceptedAt),
								initiatorUserId: null,
							})
							.returning(),
					);
					if (!executionThread)
						return yield* Effect.die(new Error("Routine thread insert returned no row"));
					const [execution] = yield* query((db) =>
						db
							.insert(routineExecution)
							.values({
								routineId: input.routineId,
								workspaceId: input.workspaceId,
								agentId: input.agentId,
								threadId: executionThread.id,
								triggerKind: input.trigger.kind,
								triggerIdentity: input.triggerIdentity,
								trigger: input.trigger,
								routineName: definition.routine.name,
								instructions: definition.routine.instructions,
								acceptedAt,
							})
							.returning(),
					);
					if (!execution)
						return yield* Effect.die(new Error("Routine execution insert returned no row"));
					yield* query((db) =>
						db
							.insert(threadParticipant)
							.values({ threadId: executionThread.id, agentId: input.agentId }),
					);
					const content = triggerMessageContent(definition.routine.instructions, input.trigger);
					const [triggerMessage] = yield* query((db) =>
						db
							.insert(message)
							.values({
								threadId: executionThread.id,
								routineTrigger: {
									kind: "routine_trigger",
									executionId: execution.id,
									routineName: definition.routine.name,
									triggerKind: input.trigger.kind,
								},
								kind: "text",
								status: "complete",
								parts: [{ type: "text", text: content }],
								content,
							})
							.returning({ id: message.id }),
					);
					if (!triggerMessage)
						return yield* Effect.die(new Error("Routine message insert returned no row"));
					yield* runs.queue({ routineId: input.routineId, executionId: execution.id });
					yield* publishEvents([
						{
							channel: workspaceChannel(input.workspaceId),
							event: streamEvent("chat.thread_changed", {
								chatId: currentChat.id,
								threadId: executionThread.id,
								threadType: "routine",
							}),
						},
					]);
					return { executionId: execution.id, threadId: executionThread.id, duplicate: false };
				}),
			),

		listExecutions: (
			workspaceId,
			agentId,
			routineId,
			page = { limit: DEFAULT_ROUTINE_EXECUTION_PAGE_LIMIT },
		) =>
			Effect.gen(function* () {
				const before = page.cursor ? yield* decodeExecutionCursor(page.cursor) : undefined;
				return yield* query((db) =>
					Effect.gen(function* () {
						const [definition] = yield* db
							.select({ id: routine.id })
							.from(routine)
							.where(
								and(
									eq(routine.id, routineId),
									eq(routine.workspaceId, workspaceId),
									eq(routine.agentId, agentId),
								),
							)
							.limit(1);
						if (!definition) return undefined;
						const rows = yield* db
							.select()
							.from(routineExecution)
							.where(
								and(
									eq(routineExecution.routineId, routineId),
									before
										? or(
												lt(routineExecution.acceptedAt, before.acceptedAt),
												and(
													eq(routineExecution.acceptedAt, before.acceptedAt),
													lt(routineExecution.id, before.id),
												),
											)
										: undefined,
								),
							)
							.orderBy(desc(routineExecution.acceptedAt), desc(routineExecution.id))
							.limit(page.limit + 1);
						const items = rows.slice(0, page.limit);
						const oldest = items.at(-1);
						return {
							items: items.map(toRoutineExecution),
							nextCursor: rows.length > page.limit && oldest ? encodeExecutionCursor(oldest) : null,
						};
					}),
				);
			}),

		startRun: (run) =>
			transaction(
				Effect.gen(function* () {
					const [execution] = yield* query((db) =>
						db
							.select()
							.from(routineExecution)
							.where(eq(routineExecution.id, run.executionId))
							.limit(1)
							.for("update"),
					);
					if (execution?.state !== "queued" && execution?.state !== "running") return;
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
					if (!triggerMessage)
						return yield* Effect.die(new Error("Routine trigger message is missing"));
					if (execution.state === "queued") {
						yield* query((db) =>
							db
								.update(routineExecution)
								.set({ state: "running", startedAt: new Date() })
								.where(eq(routineExecution.id, execution.id)),
						);
					}
					// Asking again for a turn already asked for joins it, so a start
					// repeated after a crash does not run the turn twice.
					yield* queueTurn({
						threadId: execution.threadId,
						agentId: execution.agentId,
						triggerMessageId: triggerMessage.id,
						reason: "routine",
					});
				}),
			),

		settleThread: (threadId, outcome) =>
			settleRoutineThread(threadId, outcome, publishEvents, signals, runs),

		failRun: (run) =>
			transaction(
				Effect.gen(function* () {
					// The settlement lock comes before the execution row, in the order
					// settlement takes them.
					const lockKey = routineSettlementLockKey(run.executionId);
					yield* query((db) =>
						db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
					);
					const [execution] = yield* query((db) =>
						db
							.select()
							.from(routineExecution)
							.where(eq(routineExecution.id, run.executionId))
							.limit(1),
					);
					if (execution?.state === "running") {
						yield* settleRoutineThread(
							execution.threadId,
							{ state: "failed", error: RUN_STOPPED_UNEXPECTEDLY },
							publishEvents,
							signals,
							runs,
						);
					}
					// Settling waits for work that is still stopping, but the run ends
					// now: its routine's next run cannot start while it is running.
					const [failed] = yield* query((db) =>
						db
							.update(routineExecution)
							.set({
								state: "failed",
								error: RUN_STOPPED_UNEXPECTEDLY,
								finishedAt: new Date(),
								pendingTerminalState: null,
								pendingTerminalError: null,
							})
							.where(
								and(
									eq(routineExecution.id, run.executionId),
									inArray(routineExecution.state, ["queued", "running"]),
								),
							)
							.returning(),
					);
					if (failed) yield* announceRunEnded(publishEvents, failed);
				}),
			),

		settleRun: (run) =>
			Effect.gen(function* () {
				const [execution] = yield* query((db) =>
					db
						.select({ threadId: routineExecution.threadId })
						.from(routineExecution)
						.where(eq(routineExecution.id, run.executionId))
						.limit(1),
				);
				if (!execution) return true;
				yield* settleRoutineThread(execution.threadId, undefined, publishEvents, signals, runs);
				const [settled] = yield* query((db) =>
					db
						.select({ state: routineExecution.state })
						.from(routineExecution)
						.where(eq(routineExecution.id, run.executionId))
						.limit(1),
				);
				return settled?.state !== "running";
			}),

		processNextDue: (now = new Date()) =>
			transaction(
				Effect.gen(function* () {
					const [due] = yield* query((db) =>
						db
							.select()
							.from(routine)
							.where(
								and(
									eq(routine.triggerKind, "cron"),
									eq(routine.state, "enabled"),
									isNull(routine.deletedAt),
									sql`${routine.nextScheduledAt} <= ${now}`,
								),
							)
							.orderBy(asc(routine.nextScheduledAt), asc(routine.id))
							.limit(1)
							.for("update", { skipLocked: true }),
					);
					if (!due) return undefined;
					const expression = due.cronExpression;
					const timezone = due.cronTimezone;
					if (!expression || !timezone) {
						return yield* Effect.die(new Error("Cron Routine has incomplete schedule data"));
					}
					const occurrence = yield* latestMissedAndNextOccurrence(expression, timezone, now);
					const scheduledAt = occurrence.latest.toISOString();
					const accepted = yield* store.acceptTrigger({
						workspaceId: due.workspaceId,
						agentId: due.agentId,
						routineId: due.id,
						triggerIdentity: scheduledAt,
						trigger: { kind: "cron", scheduledAt, acceptedAt: now.toISOString() },
					});
					yield* query((db) =>
						db
							.update(routine)
							.set({ nextScheduledAt: occurrence.next })
							.where(eq(routine.id, due.id)),
					);
					return accepted;
				}),
			),

		rotateSecret: (workspaceId, agentId, routineId) => {
			const secret = generateSecret();
			return transaction(
				Effect.gen(function* () {
					yield* lock(`routine-trigger:${routineId}`);
					const [updated] = yield* query((db) =>
						db
							.update(routine)
							.set({ webhookSecretDigest: hashSecret(secret) })
							.where(
								and(
									routineScope(workspaceId, agentId, routineId),
									eq(routine.triggerKind, "webhook"),
								),
							)
							.returning({ id: routine.id }),
					);
					if (updated) return secret;
					const [exists] = yield* query((db) =>
						db
							.select({ id: routine.id })
							.from(routine)
							.where(routineScope(workspaceId, agentId, routineId)),
					);
					if (!exists) return yield* new RoutineNotFound();
					return yield* new RoutineTriggerRejected();
				}),
			);
		},

		acceptWebhook: (routineId, secret, trigger) =>
			transaction(
				Effect.gen(function* () {
					yield* lock(`routine-trigger:${routineId}`);
					const row = isUuid(routineId)
						? yield* query((db) =>
								Effect.gen(function* () {
									const [found] = yield* db
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
										.limit(1);
									return found;
								}),
							)
						: undefined;
					const valid = yield* Effect.promise(() =>
						verifySecret(secret, row?.digest ?? DUMMY_SECRET_DIGEST),
					);
					if (!valid || !row) return undefined;
					return yield* store
						.acceptTrigger({
							workspaceId: row.workspaceId,
							agentId: row.agentId,
							routineId,
							triggerIdentity: trigger.idempotencyKey,
							trigger,
						})
						.pipe(Effect.catchTag("RoutineNotFound", () => Effect.undefined));
				}),
			),
	};
	return store;
}

const routineScope = (workspaceId: string, agentId: string, routineId: string) =>
	and(
		eq(routine.id, routineId),
		eq(routine.workspaceId, workspaceId),
		eq(routine.agentId, agentId),
		isNull(routine.deletedAt),
	);

const lock = (key: string) =>
	query((db) => db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`));

function ensureAutomatedChat(workspaceId: string, podId: string, hostAgentId: string) {
	return Effect.gen(function* () {
		yield* lock(`chat:${podId}:${hostAgentId}`);
		const [existing] = yield* query((db) =>
			db
				.select()
				.from(chat)
				.where(and(eq(chat.podId, podId), eq(chat.hostAgentId, hostAgentId)))
				.limit(1),
		);
		if (existing) return existing;
		const [main] = yield* query((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId,
					type: "chat",
					title: "Chat",
					initiatorUserId: null,
				})
				.returning(),
		);
		if (!main) return yield* Effect.die(new Error("Automated chat thread insert returned no row"));
		const [created] = yield* query((db) =>
			db
				.insert(chat)
				.values({ workspaceId, podId, hostAgentId, mainThreadId: main.id, initiatorUserId: null })
				.returning(),
		);
		if (!created) return yield* Effect.die(new Error("Automated chat insert returned no row"));
		yield* query((db) =>
			db.update(thread).set({ chatId: created.id }).where(eq(thread.id, main.id)),
		);
		yield* query((db) =>
			db.insert(threadParticipant).values({ threadId: main.id, agentId: hostAgentId }),
		);
		return created;
	});
}

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

/**
 * The child threads of `tree` that belong to a routine run's work: its
 * collaborations. A system agent's thread (the Scribe's summaries) hangs off
 * the thread it serves but is not part of the run, so its turns neither keep
 * the run open nor decide how it ended.
 */
const workingChildThreads = sql`select child.id from ${thread} child join tree parent on child.parent_thread_id = parent.id and child.type <> 'system_agent'`;

function settleRoutineThread(
	threadId: string,
	outcome: { state: "failed" | "cancelled"; error?: string } | undefined,
	publishEvents: PublishEvents,
	signals: TurnSignals,
	runs: RoutineRuns,
) {
	return transaction(
		Effect.gen(function* () {
			const target = yield* query((db) =>
				Effect.gen(function* () {
					const rows = yield* db.execute<{ id: string }>(
						sql`
					with recursive ancestors as (
						select id, parent_thread_id from ${thread} where id = ${threadId}
						union all
						select parent.id, parent.parent_thread_id
						from ${thread} parent
						join ancestors child on child.parent_thread_id = parent.id
					)
					select execution.id
					from ${routineExecution} execution
					join ancestors on ancestors.id = execution.thread_id
					where execution.state = 'running'
					limit 1
				`,
						"objects",
					);
					return rows[0];
				}),
			);
			if (!target) return false;
			const settlementLockKey = routineSettlementLockKey(target.id);
			yield* query((db) =>
				db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${settlementLockKey}, 0))`),
			);
			const status = yield* query((db) =>
				Effect.gen(function* () {
					const rows = yield* db.execute<{
						id: string;
						routine_id: string;
						thread_id: string;
						workspace_id: string;
						active: boolean;
						last_turn_status: string | null;
						last_turn_error: string | null;
						pending_terminal_state: "failed" | "cancelled" | null;
						pending_terminal_error: string | null;
					}>(
						sql`
					with recursive tree as (
						select root.id
						from ${thread} root
						join ${routineExecution} root_execution on root_execution.thread_id = root.id
						where root_execution.id = ${target.id} and root_execution.state = 'running'
						union all
						${workingChildThreads}
					)
					select execution.id, execution.routine_id, execution.thread_id, execution.workspace_id,
						execution.pending_terminal_state, execution.pending_terminal_error,
							exists (
							select 1 from tree busy_thread
							where ${laneBusy(sql`busy_thread.id`, [Turn._tag, Facilitate._tag])}
						) or exists (
							select 1 from ${turn} active_turn
							join tree on tree.id = active_turn.thread_id
							where active_turn.status in ('running', 'waiting')
						) or exists (
							select 1 from ${collaboration} active_collaboration
							join tree on tree.id = active_collaboration.parent_thread_id
							where active_collaboration.status in ('waiting', 'pending')
						) as active,
						(
							select terminal_turn.status from ${turn} terminal_turn
							join tree on tree.id = terminal_turn.thread_id
							order by terminal_turn.finished_at desc nulls last, terminal_turn.id desc
							limit 1
						) as last_turn_status,
						(
							select terminal_turn.error from ${turn} terminal_turn
							join tree on tree.id = terminal_turn.thread_id
							order by terminal_turn.finished_at desc nulls last, terminal_turn.id desc
							limit 1
						) as last_turn_error
					from ${routineExecution} execution
					where execution.id = ${target.id} and execution.state = 'running'
				`,
						"objects",
					);
					return rows[0];
				}),
			);
			if (!status) return false;
			let pendingState = status.pending_terminal_state;
			let pendingError = status.pending_terminal_error;
			let active = status.active;
			if (outcome) {
				const affectedThreadIds = yield* query((db) =>
					Effect.gen(function* () {
						const rows = yield* db.execute<{ id: string }>(
							sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						)
						select id from tree
					`,
							"objects",
						);
						return rows.map(({ id }) => id);
					}),
				);
				if (pendingState !== "failed") {
					pendingState = outcome.state;
					pendingError = outcome.state === "failed" ? (outcome.error ?? null) : null;
					yield* query((db) =>
						db
							.update(routineExecution)
							.set({
								pendingTerminalState: pendingState,
								pendingTerminalError: pendingError,
							})
							.where(
								and(eq(routineExecution.id, status.id), eq(routineExecution.state, "running")),
							),
					);
				}
				yield* query((db) =>
					db.execute(sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						)
						update ${collaboration}
						set status = 'failed', updated_at = now()
						where ${collaboration.id} in (
							select active_collaboration.id
							from ${collaboration} active_collaboration
							join tree on active_collaboration.parent_thread_id = tree.id
							where active_collaboration.status in ('waiting', 'pending')
							for update of active_collaboration skip locked
						)
					`),
				);
				// Each waiting turn's owner is told to stop first: a workflow records
				// the cancellation itself, which finds the turn already cancelled here.
				const waitingOwners = yield* query((db) =>
					db.execute<{ owner: string | null }>(
						sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							select child.id from ${thread} child join tree parent on child.parent_thread_id = parent.id
						)
						select ${turn.owner} as owner from ${turn}
						where ${turn.threadId} in (select id from tree) and ${turn.status} = 'waiting'
					`,
						"objects",
					),
				);
				yield* Effect.forEach(waitingOwners, ({ owner }) =>
					owner ? signals.cancel(owner) : Effect.void,
				);
				yield* query((db) =>
					db.execute(sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						), cancelled_turns as (
							update ${turn}
							set status = 'cancelled', cancel_requested = true, checkpoint = null,
								finished_at = now(), updated_at = now()
							where ${turn.threadId} in (select id from tree) and ${turn.status} = 'waiting'
							returning id
						)
						update ${toolCall}
						set status = 'failed', approval_status = case
								when approval_status = 'pending' then 'denied'
								else approval_status
							end,
							error = 'Routine execution ended', finished_at = now(), updated_at = now()
						where ${toolCall.turnId} in (select id from cancelled_turns)
							and ${toolCall.status} in ('running', 'awaiting_approval')
					`),
				);
				yield* query((db) =>
					db.execute(sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						)
						update ${message}
						set status = 'cancelled'
						where ${message.turnId} in (
							select cancelled.id from ${turn} cancelled
							join tree on tree.id = cancelled.thread_id
							where cancelled.status = 'cancelled' and cancelled.cancel_requested = true
						)
							and ${message.status} = 'streaming'
					`),
				);
				yield* query((db) =>
					db.execute(sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						)
						update ${turn}
						set cancel_requested = true, updated_at = now()
						where ${turn.id} in (
							select active_turn.id
							from ${turn} active_turn
							join tree on active_turn.thread_id = tree.id
							where active_turn.status = 'running'
							for update of active_turn skip locked
						)
					`),
				);
				// Turns and facilitations asked for but not yet started never start.
				yield* query((db) =>
					db.execute(sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						)
						${dropWaiting(sql`select id from tree`, [Turn._tag, Facilitate._tag])}
					`),
				);
				active = yield* query((db) =>
					Effect.gen(function* () {
						const rows = yield* db.execute<{ active: boolean }>(
							sql`
						with recursive tree as (
							select id from ${thread} where id = ${status.thread_id}
							union all
							${workingChildThreads}
						)
						select exists (
							select 1 from tree busy_thread
							where ${laneBusy(sql`busy_thread.id`, [Facilitate._tag])}
						) or exists (
							select 1 from ${turn} active_turn
							join tree on tree.id = active_turn.thread_id
							where active_turn.status = 'running'
						) as active
					`,
							"objects",
						);
						return rows[0]?.active ?? false;
					}),
				);
				yield* publishEvents(
					affectedThreadIds.map((affectedThreadId) => ({
						channel: threadChannel(affectedThreadId),
						event: streamEvent("thread.changed"),
					})),
				);
			}
			if (active) return false;

			const state =
				pendingState ??
				(status.last_turn_status === "failed"
					? "failed"
					: status.last_turn_status === "cancelled"
						? "cancelled"
						: "completed");
			const error = pendingError ?? (state === "failed" ? status.last_turn_error : null);
			const [settled] = yield* query((db) =>
				db
					.update(routineExecution)
					.set({
						state,
						error: error ?? null,
						finishedAt: new Date(),
						pendingTerminalState: null,
						pendingTerminalError: null,
					})
					.where(and(eq(routineExecution.id, status.id), eq(routineExecution.state, "running")))
					.returning({ id: routineExecution.id }),
			);
			if (!settled) return false;
			yield* runs.settled({ routineId: status.routine_id, executionId: status.id });
			yield* announceRunEnded(publishEvents, {
				workspaceId: status.workspace_id,
				threadId: status.thread_id,
			});
			return true;
		}),
	);
}

/** Tells the workspace that a routine run's thread changed because the run ended. */
const announceRunEnded = (
	publishEvents: PublishEvents,
	run: { readonly workspaceId: string; readonly threadId: string },
) =>
	Effect.gen(function* () {
		const chatId = yield* query((db) =>
			Effect.gen(function* () {
				const [root] = yield* db
					.select({ chatId: thread.chatId })
					.from(thread)
					.where(eq(thread.id, run.threadId))
					.limit(1);
				if (!root?.chatId) throw new Error("Routine thread has no Chat");
				return root.chatId;
			}),
		);
		yield* publishEvents([
			{
				channel: workspaceChannel(run.workspaceId),
				event: streamEvent("chat.thread_changed", {
					chatId,
					threadId: run.threadId,
					threadType: "routine",
				}),
			},
		]);
	});

function generateSecret() {
	return randomBytes(32).toString("base64url");
}

function executionTitle(name: string, acceptedAt: Date) {
	const suffix = ` - ${acceptedAt.toISOString()}`;
	return `${name.slice(0, MAX_THREAD_TITLE_CHARACTERS - suffix.length)}${suffix}`;
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

function toRoutine(row: schema.RoutineRow): Routine {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		agentId: row.agentId,
		name: row.name,
		instructions: row.instructions,
		trigger:
			row.triggerKind === "cron"
				? {
						kind: "cron",
						expression: row.cronExpression ?? "",
						timezone: row.cronTimezone ?? "",
						nextScheduledAt: row.nextScheduledAt?.toISOString() ?? null,
					}
				: { kind: "webhook" },
		state: row.state,
		createdById: row.createdById,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function encodeExecutionCursor(row: Pick<schema.RoutineExecutionRow, "acceptedAt" | "id">): string {
	return Buffer.from(`${row.acceptedAt.toISOString()}\n${row.id}`).toString("base64url");
}

function decodeExecutionCursor(
	cursor: string,
): Effect.Effect<ExecutionCursor, InvalidRoutineExecutionCursor> {
	const decoded = Buffer.from(cursor, "base64url").toString();
	const [timestamp, id, extra] = decoded.split("\n");
	const acceptedAt = timestamp ? new Date(timestamp) : new Date(Number.NaN);
	const wellFormed =
		extra === undefined &&
		timestamp &&
		id &&
		isUuid(id) &&
		!Number.isNaN(acceptedAt.getTime()) &&
		acceptedAt.toISOString() === timestamp &&
		Buffer.from(decoded).toString("base64url") === cursor;
	return wellFormed
		? Effect.succeed({ acceptedAt, id })
		: Effect.fail(new InvalidRoutineExecutionCursor());
}
