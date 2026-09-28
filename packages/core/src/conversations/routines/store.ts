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
} from "@sugabots/contracts";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, queryCatching, transaction } from "../../database/database.ts";
import { isUniqueViolation } from "../../database/errors.ts";
import type { DomainEvents } from "../../database/events/domain-events.ts";
import { isUuid } from "../../database/ids.ts";
import type * as schema from "../../database/schema.ts";
import {
	agent,
	chat,
	message,
	pod,
	routine,
	routineExecution,
	thread,
	threadParticipant,
} from "../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { reachesPod } from "../../workspaces/access.ts";
import { crewAgentRow, toAgent } from "../../workspaces/agents/store.ts";
import { ConversationEvent } from "../events.ts";
import { TurnRequests } from "../turns/requests.ts";
import { toRoutineExecution } from "./execution.ts";
import type { RoutineRun } from "./routine.workflow.ts";
import { RoutineRuns } from "./runs.ts";
import {
	type InvalidRoutineSchedule,
	latestMissedAndNextOccurrence,
	nextOccurrence,
} from "./schedule.ts";

const deriveKey = promisify(scrypt);

interface ExecutionCursor {
	acceptedAt: Date;
	id: string;
}

export class RoutineNotFound extends Data.TaggedError("RoutineNotFound") implements UserFacing {
	get userMessage() {
		return UserMessage.of`No such Routine`;
	}
}
export class RoutineNameTaken extends Data.TaggedError("RoutineNameTaken") implements UserFacing {
	get userMessage() {
		return UserMessage.of`A Routine with that name already exists`;
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
export class InvalidRoutineExecutionCursor
	extends Data.TaggedError("InvalidRoutineExecutionCursor")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That Routine execution cursor is invalid`;
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

export const routineStore = Effect.fnUntraced(function* (
	emit: DomainEvents.Emit<ConversationEvent>,
) {
	const requests = yield* TurnRequests.Service;
	const runs = yield* RoutineRuns.Service;
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
					yield* emit([
						ConversationEvent.RoutineExecutionAccepted({
							workspaceId: input.workspaceId,
							chatId: currentChat.id,
							threadId: executionThread.id,
						}),
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
					yield* requests.queueTurn({
						threadId: execution.threadId,
						agentId: execution.agentId,
						triggerMessageId: triggerMessage.id,
						reason: "routine",
					});
				}),
			),

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
});

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
