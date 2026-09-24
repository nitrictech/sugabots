import type { PodRouting, ThreadType } from "@sugabots/contracts";
import {
	type Message,
	messagePartsFor,
	streamEvent,
	type ThreadParticipant,
	threadChannel,
	workspaceChannel,
} from "@sugabots/contracts";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
	type Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../../database/database.ts";
import type { PendingEvent, PublishEvents } from "../../database/events/publish.ts";
import {
	type AgentRow,
	agent,
	job,
	type MessageRow,
	message,
	pod,
	routineExecution,
	type StoredMessagePart,
	type TurnReason,
	thread,
	toolCall,
	turn,
	user,
	workspace,
} from "../../database/schema.ts";
import {
	type ClaimedJob,
	cancelJob,
	claimNextJob,
	completeJob,
	failJob,
	JobNotRunnable,
	queueDeferredJob,
	requeueInterruptedJobs,
	retryOrFailJob,
} from "../jobs/queue.ts";
import { findRoutineExecutionId, routineSettlementLockKey } from "../routines/execution.ts";
import { queueSummary } from "../summaries/store.ts";
import { loadParticipants, participantColumns, toMessage } from "../threads/participants.ts";
import { loadPlacedParts } from "../threads/placed-parts.ts";
import { toToolCallPart } from "../threads/tool-calls.ts";
import { visibleThread } from "../threads/visibility.ts";
import type { PendingToolApproval } from "../tools/approvals/store.ts";
import { executionJson } from "../tools/approvals/store.ts";
import { abandonRunningToolCalls, boundedJson, deleteToolCallsOf } from "../tools/calls/store.ts";
import { type FloorDecision, giveFloor } from "./floor.ts";

export { queueTurn } from "./queue.ts";

import type { ModelMessage } from "ai";
import type { ModelAccounting } from "./model.ts";

/**
 * Turns: one agent answering one message in a thread.
 *
 * A turn is queued as a job when a person posts, claimed by the worker, and
 * recorded as a `turn` row plus the agent's reply as a `message` that starts
 * out `streaming`. The worker drives it from there through the methods below,
 * each of which writes the outcome and publishes it in one transaction.
 */

/** How much of the conversation the agent is shown. */
const MAX_HISTORY_MESSAGES = 100;

export type ClaimedTurn = ClaimedJob<"turn">;

/** What the model is told about where it is and what has been said. */
export interface TurnContext {
	thread: {
		id: string;
		workspaceId: string;
		title: string;
		type?: ThreadType;
		/** Set when another agent opened this thread by delegating to this one. */
		parentThreadId: string | null;
	};
	agent: {
		id: string;
		name: string;
		handle: string;
		model: string;
		prompt: string;
		/** Built-in tools an admin switched off for this agent, by key. */
		disabledTools: string[];
		podId: string;
	};
	/** Why this agent has the turn, when the trigger recorded it. */
	reason: TurnReason | undefined;
	/** Whether non-chat threads use the Facilitator to choose the next speaker. */
	routing: PodRouting;
	podName: string;
	workspaceName: string;
	/** The other crew agents in the pod, who this agent may collaborate with. */
	crew: Array<{ id: string; name: string; handle: string; description: string | null }>;
	participants: ThreadParticipant[];
	/** messages contains up to one hundred completed messages, oldest first. */
	messages: Message[];
}

/**
 * The reply as the worker has it so far: the text, and where in that text the
 * agent made each collaboration and tool call. Stored as parts in that order.
 */
export interface ReplyDraft {
	content: string;
	collaborations: ReadonlyArray<{ id: string; atOffset: number }>;
	toolCalls: ReadonlyArray<{ id: string; atOffset: number }>;
	/**
	 * A tool that may have changed something ran. A failed attempt is then not
	 * retried on its own, since the retry could do it again (ADR 002).
	 */
	acted?: boolean;
}

/** A claimed turn with its rows written and its context loaded, ready to run. */
export interface PreparedTurn {
	job: ClaimedTurn;
	turnId: string;
	/** The agent's reply, `streaming` and empty until the worker fills it. */
	responseMessage: Message;
	context: TurnContext;
	checkpoint?: TurnCheckpoint;
}

export interface TurnCheckpoint {
	messages: ModelMessage[];
	approvals: Array<{
		approvalId: string;
		tool: string;
		connectionId: string;
		connectionRevision: number;
		remoteToolName: string;
	}>;
	modelInput: {
		model: string;
		system: string;
		messages: import("./model.ts").TurnPromptMessage[];
	};
	reply: ReplyDraft;
	accounting: ModelAccounting;
}

export interface TurnStore {
	/** Puts turns left `running` by a stopped process back in the queue. */
	requeueInterrupted(): Effect.Effect<void, never, Database>;
	claimNext(): Effect.Effect<ClaimedTurn | undefined, never, Database>;
	/** Records that preparing the turn failed and returns whether it will be retried. */
	releaseFailedClaim(claimed: ClaimedTurn, error: string): Effect.Effect<boolean, never, Database>;
	/**
	 * Opens the turn: creates or reopens its `turn` row and reply message and
	 * loads what the model needs. Fails when the thread is gone, or the agent is
	 * no longer in its pod.
	 */
	prepare(claimed: ClaimedTurn): Effect.Effect<PreparedTurn, JobNotRunnable, Database>;
	/** Persists the reply so far, so a crash loses at most a second of text. */
	saveStreamingMessage(
		prepared: Pick<PreparedTurn, "responseMessage">,
		reply: ReplyDraft,
	): Effect.Effect<void, never, Database>;
	complete(
		prepared: PreparedTurn,
		reply: ReplyDraft,
		accounting: ModelAccounting,
	): Effect.Effect<void, never, Database>;
	/** Parks this exact model transcript until all requested tool approvals are decided. */
	suspend(
		prepared: PreparedTurn,
		checkpoint: TurnCheckpoint,
		approvals: readonly PendingToolApproval[],
	): Effect.Effect<boolean, never, Database>;
	/** Asks the summarise system agent to catch up on this thread. */
	queueSummary(prepared: PreparedTurn): Effect.Effect<void, never, Database>;
	/** Decides who speaks after this completed reply, and queues them (ADR 004). */
	giveFloor(
		prepared: PreparedTurn,
		reply: ReplyDraft,
	): Effect.Effect<FloorDecision, never, Database>;
	/** Returns whether the turn will be retried. */
	fail(
		prepared: PreparedTurn,
		reply: ReplyDraft,
		error: string,
	): Effect.Effect<boolean, never, Database>;
	cancel(prepared: PreparedTurn, reply: ReplyDraft): Effect.Effect<void, never, Database>;
	isCancellationRequested(
		prepared: Pick<PreparedTurn, "turnId">,
	): Effect.Effect<boolean, never, Database>;
	/** `false` when there is no running turn this person may see. */
	requestCancel(turnId: string, userId: string): Effect.Effect<boolean, never, Database>;
	/** Ends a claim that cannot run, recording why. */
	discard(claimed: Pick<ClaimedTurn, "id">, reason: string): Effect.Effect<void, never, Database>;
}

export function turnStore(publishEvents: PublishEvents): TurnStore {
	return {
		requeueInterrupted: () => requeueInterruptedJobs("turn"),

		claimNext: () => claimNextJob("turn"),

		releaseFailedClaim: (claimed, error) =>
			transaction(
				Effect.gen(function* () {
					const willRetry = yield* retryOrFailJob(claimed, error);
					if (!willRetry) {
						const [active] = yield* query((db) =>
							db
								.select({ id: turn.id })
								.from(turn)
								.where(
									and(eq(turn.jobId, claimed.id), inArray(turn.status, ["running", "waiting"])),
								)
								.limit(1),
						);
						if (active) yield* query((db) => finishInterruptedTurn(db, active.id, "failed", error));
						yield* query((db) => queueDeferredJob(db, claimed.id));
					}
					return willRetry;
				}),
			),

		prepare: (claimed) =>
			transaction(
				Effect.gen(function* () {
					const executionId = yield* query((db) => findRoutineExecutionId(db, claimed.threadId));
					if (executionId) {
						const lockKey = routineSettlementLockKey(executionId);
						yield* query((db) =>
							db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
						);
					}
					if (
						executionId &&
						(yield* query((db) => routineExecutionRejectsNewTurns(db, executionId)))
					) {
						const outcome = yield* query((db) => terminateClaimedTurn(db, claimed.id));
						return new JobNotRunnable({
							reason: "The Routine execution has ended",
							...(outcome ? { terminalOutcome: outcome } : {}),
						});
					}
					const scope = yield* query((db) => loadTurnScope(db, claimed));
					if (!scope) {
						return new JobNotRunnable({
							reason: "The thread is gone, or this agent is not a crew agent in its pod",
						});
					}
					// An agent whose model has been cleared does not fall back to
					// another one: it stops, and says so, until somebody chooses.
					// Read out here so what opens the turn is handed a model rather
					// than a scope that might not carry one.
					const model = scope.agentModel;
					if (model === null) {
						return new JobNotRunnable({
							reason: `${scope.agentName} has no model chosen`,
						});
					}
					if (scope.threadType === "chat" && claimed.payload.reason === "facilitator") {
						const outcome = yield* query((db) => terminateClaimedTurn(db, claimed.id));
						return new JobNotRunnable({
							reason: "The Facilitator does not route Chats",
							...(outcome ? { terminalOutcome: outcome } : {}),
						});
					}
					const opened = yield* query((db) => openTurn(db, claimed, scope, model));
					if ("notRunnableReason" in opened) {
						return new JobNotRunnable({
							reason: opened.notRunnableReason,
							...(opened.terminalOutcome ? { terminalOutcome: opened.terminalOutcome } : {}),
						});
					}
					const { turnId, response, checkpoint, resumed } = opened;
					// One query at a time: inside a transaction the executor is a single
					// connection, and queries sent concurrently down one are not run
					// concurrently anyway. The driver queues them, and warns that it is
					// about to stop accepting them at all.
					const participants = yield* query((db) => loadParticipants(db, scope.threadId));
					const crew = yield* query((db) => loadCrew(db, scope));
					const messages = yield* query((db) => loadHistory(db, scope.threadId, response.id));

					const prepared: PreparedTurn = {
						job: claimed,
						turnId,
						responseMessage: toMessage(response, {
							userId: null,
							userName: null,
							userImage: null,
							agentId: scope.agentId,
							agentName: scope.agentName,
							agentHandle: scope.agentHandle,
							agentHue: scope.agentHue,
							agentFace: scope.agentFace,
						}),
						context: {
							thread: {
								id: scope.threadId,
								workspaceId: scope.workspaceId,
								title: scope.threadTitle,
								type: scope.threadType,
								parentThreadId: scope.parentThreadId,
							},
							agent: {
								id: scope.agentId,
								name: scope.agentName,
								handle: scope.agentHandle,
								model,
								prompt: scope.agentPrompt,
								disabledTools: scope.agentDisabledTools,
								podId: scope.podId,
							},
							reason: claimed.payload.reason,
							routing: scope.routing,
							podName: scope.podName,
							workspaceName: scope.workspaceName,
							crew,
							participants,
							messages,
						},
						...(checkpoint ? { checkpoint } : {}),
					};
					if (!resumed)
						yield* publishEvents([
							{
								channel: threadChannel(scope.threadId),
								event: streamEvent("turn.started", {
									threadId: scope.threadId,
									turnId,
									agentId: scope.agentId,
								}),
							},
							{
								channel: threadChannel(scope.threadId),
								event: streamEvent("message.created", {
									threadId: scope.threadId,
									message: prepared.responseMessage,
								}),
							},
						]);
					return prepared;
				}),
			).pipe(
				Effect.flatMap((result) =>
					result instanceof JobNotRunnable ? Effect.fail(result) : Effect.succeed(result),
				),
			),

		saveStreamingMessage: (prepared, reply) =>
			query((db) =>
				db
					.update(message)
					.set({ content: reply.content, parts: replyParts(reply) })
					.where(eq(message.id, prepared.responseMessage.id)),
			).pipe(Effect.asVoid),

		complete: (prepared, reply, accounting) =>
			transaction(
				Effect.gen(function* () {
					const content = reply.content;
					yield* query((db) =>
						db
							.update(message)
							.set({ status: "complete", content, parts: replyParts(reply) })
							.where(eq(message.id, prepared.responseMessage.id)),
					);
					yield* query((db) =>
						db
							.update(turn)
							.set({
								status: "done",
								// What the requests used is in the ledger; the row keeps only the
								// context size, which is the last request's rather than a sum.
								contextTokens: accounting.contextTokens ?? null,
								contextCapacity: accounting.contextCapacity ?? null,
								checkpoint: null,
								finishedAt: new Date(),
							})
							.where(eq(turn.id, prepared.turnId)),
					);
					yield* completeJob(prepared.job.id);
					yield* query((db) => queueDeferredJob(db, prepared.job.id));
					yield* publishEvents([
						replyFinished(prepared, content, "complete"),
						{
							channel: threadChannel(prepared.context.thread.id),
							event: streamEvent("turn.completed", {
								threadId: prepared.context.thread.id,
								turnId: prepared.turnId,
								status: "done",
								usage: accounting.usage,
								reportedCost: accounting.reportedCost,
							}),
						},
						threadChanged(prepared),
					]);
				}),
			),

		suspend: (prepared, checkpoint, approvals) =>
			transaction(
				Effect.gen(function* () {
					const executionId = yield* query((db) =>
						findRoutineExecutionId(db, prepared.context.thread.id),
					);
					if (executionId) {
						const lockKey = routineSettlementLockKey(executionId);
						yield* query((db) =>
							db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
						);
						if (yield* query((db) => routineExecutionRejectsNewTurns(db, executionId))) {
							return false;
						}
					}
					yield* query((db) =>
						db.execute(
							sql`select pg_advisory_xact_lock(hashtextextended(${prepared.job.dedupeKey}, 0))`,
						),
					);
					const [suspendable] = yield* query((db) =>
						db
							.select({ id: turn.id })
							.from(turn)
							.where(
								and(
									eq(turn.id, prepared.turnId),
									eq(turn.status, "running"),
									eq(turn.cancelRequested, false),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!suspendable) return false;
					const [deferred] = yield* query((db) =>
						db
							.update(job)
							.set({ status: "cancelled", lastError: "Deferred until approval completes" })
							.where(
								and(
									eq(job.dedupeKey, prepared.job.dedupeKey),
									eq(job.status, "queued"),
									ne(job.id, prepared.job.id),
								),
							)
							.returning({ payload: job.payload }),
					);
					const [suspended] = yield* query((db) =>
						db
							.update(turn)
							.set({ status: "waiting", checkpoint })
							.where(
								and(
									eq(turn.id, prepared.turnId),
									eq(turn.status, "running"),
									eq(turn.cancelRequested, false),
								),
							)
							.returning({ id: turn.id }),
					);
					if (!suspended) {
						return yield* Effect.die(new Error("Locked turn could not be suspended"));
					}
					const parked = yield* query((db) =>
						Effect.gen(function* () {
							const rows = [];
							for (const approval of approvals) {
								const [row] = yield* db
									.insert(toolCall)
									.values({
										id: approval.id,
										threadId: prepared.context.thread.id,
										messageId: prepared.responseMessage.id,
										turnId: prepared.turnId,
										tool: approval.tool,
										sdkToolCallId: approval.sdkToolCallId,
										approvalId: approval.approvalId,
										approvalStatus: "pending",
										approvalReason: approval.reason ?? null,
										connectionId: approval.connectionId,
										connectionRevision: approval.connectionRevision,
										remoteToolName: approval.remoteToolName,
										input: boundedJson(approval.input),
										executionInput: executionJson(approval.input),
										status: "awaiting_approval",
										mutating: true,
										atOffset: approval.atOffset,
									})
									.returning();
								if (!row) throw new Error("Tool approval insert returned no row");
								rows.push(row);
							}
							return rows;
						}),
					);
					yield* query((db) =>
						db
							.update(message)
							.set({ content: checkpoint.reply.content, parts: replyParts(checkpoint.reply) })
							.where(eq(message.id, prepared.responseMessage.id)),
					);
					const parkedJob = yield* query((db) =>
						db
							.update(job)
							.set({
								status: "waiting",
								lockedAt: null,
								attempts: sql`greatest(${job.attempts} - 1, 0)`,
								...(deferred ? { deferredPayload: deferred.payload } : {}),
							})
							.where(and(eq(job.id, prepared.job.id), eq(job.status, "running")))
							.returning({ id: job.id }),
					);
					if (parkedJob.length !== 1) {
						return yield* Effect.die(new Error("Suspended turn's job is not running"));
					}
					yield* publishEvents([
						...parked.map((row) => ({
							channel: threadChannel(row.threadId),
							event: streamEvent("tool_call.started" as const, {
								threadId: row.threadId,
								messageId: row.messageId,
								toolCall: toToolCallPart(row),
							}),
						})),
						threadChanged(prepared),
					]);
					return true;
				}),
			),

		giveFloor: (prepared, reply) =>
			giveFloor(publishEvents, {
				id: prepared.responseMessage.id,
				threadId: prepared.context.thread.id,
				content: reply.content,
				author: {
					kind: "agent",
					agentId: prepared.context.agent.id,
					spokeBecause: prepared.job.payload.reason,
				},
			}),

		queueSummary: (prepared) =>
			queueSummary({
				threadId: prepared.context.thread.id,
				agentId: prepared.context.agent.id,
				sourceMessageId: prepared.responseMessage.id,
			}),

		fail: (prepared, reply, error) =>
			transaction(
				Effect.gen(function* () {
					yield* query((db) =>
						db
							.update(message)
							.set({ status: "failed", content: reply.content, parts: replyParts(reply) })
							.where(eq(message.id, prepared.responseMessage.id)),
					);
					yield* query((db) =>
						db
							.update(turn)
							.set({ status: "failed", error, checkpoint: null, finishedAt: new Date() })
							.where(eq(turn.id, prepared.turnId)),
					);
					const abandoned = yield* query((db) =>
						abandonRunningToolCalls(db, prepared.turnId, error),
					);
					// After a tool that changes things has run, a retry could run it
					// again, so the job stops here and a person decides (ADR 002).
					const willRetry = prepared.checkpoint
						? yield* Effect.as(failJob(prepared.job.id, error), false)
						: reply.acted
							? yield* Effect.as(failJob(prepared.job.id, error), false)
							: yield* retryOrFailJob(prepared.job, error);
					if (!willRetry) yield* query((db) => queueDeferredJob(db, prepared.job.id));
					yield* publishEvents([
						...abandoned,
						{
							channel: threadChannel(prepared.context.thread.id),
							event: streamEvent("message.failed", {
								threadId: prepared.context.thread.id,
								messageId: prepared.responseMessage.id,
								turnId: prepared.turnId,
								willRetry,
								error,
							}),
						},
					]);
					return willRetry;
				}),
			),

		cancel: (prepared, reply) =>
			transaction(
				Effect.gen(function* () {
					const content = reply.content;
					yield* query((db) =>
						db
							.update(message)
							.set({ status: "cancelled", content, parts: replyParts(reply) })
							.where(eq(message.id, prepared.responseMessage.id)),
					);
					yield* query((db) =>
						db
							.update(turn)
							.set({ status: "cancelled", checkpoint: null, finishedAt: new Date() })
							.where(eq(turn.id, prepared.turnId)),
					);
					const abandoned = yield* query((db) =>
						abandonRunningToolCalls(db, prepared.turnId, "Turn cancelled"),
					);
					yield* cancelJob(prepared.job.id, "Cancelled by a person");
					yield* query((db) => queueDeferredJob(db, prepared.job.id));
					yield* publishEvents([
						...abandoned,
						replyFinished(prepared, content, "cancelled"),
						{
							channel: threadChannel(prepared.context.thread.id),
							event: streamEvent("turn.completed", {
								threadId: prepared.context.thread.id,
								turnId: prepared.turnId,
								status: "cancelled",
							}),
						},
						threadChanged(prepared),
					]);
				}),
			),

		isCancellationRequested: (prepared) =>
			query((db) =>
				Effect.gen(function* () {
					const [row] = yield* db
						.select({ requested: turn.cancelRequested })
						.from(turn)
						.where(eq(turn.id, prepared.turnId))
						.limit(1);
					// A turn that has vanished should stop too.
					return row?.requested ?? true;
				}),
			),

		requestCancel: (turnId, userId) =>
			transaction(
				Effect.gen(function* () {
					const [candidate] = yield* query((db) =>
						db
							.select({
								threadId: turn.threadId,
								jobId: turn.jobId,
								status: turn.status,
								workspaceId: thread.workspaceId,
								messageId: message.id,
								content: message.content,
							})
							.from(turn)
							.innerJoin(thread, eq(thread.id, turn.threadId))
							.innerJoin(message, eq(message.turnId, turn.id))
							.where(eq(turn.id, turnId))
							.limit(1)
							.for("update"),
					);
					if (!candidate) {
						return false;
					}
					const visible = yield* query((db) => visibleThread(db, candidate.threadId, userId));
					if (!visible) {
						return false;
					}
					if (candidate.status === "waiting") {
						const stopped = yield* query((db) =>
							db
								.update(turn)
								.set({
									status: "cancelled",
									cancelRequested: true,
									checkpoint: null,
									finishedAt: new Date(),
								})
								.where(and(eq(turn.id, turnId), eq(turn.status, "waiting")))
								.returning({ id: turn.id }),
						);
						if (stopped.length === 0) return false;
						yield* query((db) =>
							db
								.update(message)
								.set({ status: "cancelled" })
								.where(eq(message.id, candidate.messageId)),
						);
						yield* query((db) =>
							db
								.update(job)
								.set({ status: "cancelled", lastError: "Cancelled by a person", lockedAt: null })
								.where(
									and(
										eq(job.id, candidate.jobId ?? "00000000-0000-0000-0000-000000000000"),
										inArray(job.status, ["waiting", "queued"]),
									),
								),
						);
						if (candidate.jobId) {
							yield* query((db) => queueDeferredJob(db, candidate.jobId as string));
						}
						const abandoned = yield* query((db) =>
							abandonRunningToolCalls(db, turnId, "Turn cancelled"),
						);
						yield* publishEvents([
							...abandoned,
							{
								channel: threadChannel(candidate.threadId),
								event: streamEvent("message.completed", {
									threadId: candidate.threadId,
									messageId: candidate.messageId,
									content: candidate.content,
									status: "cancelled",
								}),
							},
							{
								channel: threadChannel(candidate.threadId),
								event: streamEvent("turn.completed", {
									threadId: candidate.threadId,
									turnId,
									status: "cancelled",
								}),
							},
							{
								channel: workspaceChannel(candidate.workspaceId),
								event: streamEvent("thread.changed"),
							},
						]);
						return true;
					}
					const updated = yield* query((db) =>
						db
							.update(turn)
							.set({ cancelRequested: true })
							.where(
								and(
									eq(turn.id, turnId),
									eq(turn.status, "running"),
									eq(turn.cancelRequested, false),
								),
							)
							.returning({ id: turn.id }),
					);
					return updated.length === 1;
				}),
			),

		discard: (claimed, reason) => cancelJob(claimed.id, reason),
	};
}

/** The thread a turn happens in, with its pod, workspace and the agent taking it. */
interface TurnScope {
	threadId: string;
	chatId: string | null;
	workspaceId: string;
	podId: string;
	parentThreadId: string | null;
	threadTitle: string;
	threadType: ThreadType;
	podName: string;
	workspaceName: string;
	routing: PodRouting;
	agentId: string;
	agentName: string;
	agentHandle: string;
	agentHue: number;
	agentFace: AgentRow["face"];
	/** Null when nobody has chosen one. The turn refuses rather than guessing. */
	agentModel: string | null;
	agentPrompt: string;
	agentDisabledTools: string[];
}

/**
 * The thread and the agent about to speak in it, or nothing if the turn may
 * not run.
 *
 * The agent has to be crew placed in the thread's pod, not the thread's host.
 * A shared thread gives the floor to whoever the facilitator or a mention
 * picks, and that is rarely the host — requiring the host discarded
 * every routed turn, so the person watched a reply that was never coming.
 *
 * Pod membership is still a real check: it is what stops a job naming an agent
 * from another pod or another workspace.
 */
const loadTurnScope = Effect.fn("TurnStore.loadTurnScope")(function* (
	db: Executor,
	claimed: ClaimedTurn,
): Effect.fn.Return<TurnScope | undefined, QueryFailure> {
	const [row] = yield* db
		.select({
			threadId: thread.id,
			chatId: thread.chatId,
			workspaceId: thread.workspaceId,
			podId: thread.podId,
			parentThreadId: thread.parentThreadId,
			threadTitle: thread.title,
			threadType: thread.type,
			podName: pod.name,
			routing: pod.routing,
			workspaceName: workspace.name,
			agentId: agent.id,
			agentName: agent.name,
			agentHandle: agent.handle,
			agentHue: agent.hue,
			agentFace: agent.face,
			agentModel: agent.model,
			agentPrompt: agent.prompt,
			agentDisabledTools: agent.disabledTools,
		})
		.from(thread)
		.innerJoin(pod, eq(pod.id, thread.podId))
		.innerJoin(workspace, eq(workspace.id, thread.workspaceId))
		.innerJoin(agent, and(eq(agent.id, claimed.payload.agentId), eq(agent.podId, thread.podId)))
		.where(eq(thread.id, claimed.threadId))
		.limit(1);
	return row;
});

const routineExecutionRejectsNewTurns = Effect.fn("TurnStore.routineExecutionRejectsNewTurns")(
	function* (db: Executor, executionId: string) {
		const [execution] = yield* db
			.select({
				state: routineExecution.state,
				pendingTerminalState: routineExecution.pendingTerminalState,
			})
			.from(routineExecution)
			.where(eq(routineExecution.id, executionId))
			.limit(1);
		if (!execution) return true;
		return (
			execution.pendingTerminalState !== null ||
			execution.state === "completed" ||
			execution.state === "failed" ||
			execution.state === "cancelled"
		);
	},
);

const finishInterruptedTurn = Effect.fn("TurnStore.finishInterruptedTurn")(function* (
	db: Executor,
	turnId: string,
	status: "failed" | "cancelled",
	error: string,
) {
	yield* db
		.update(turn)
		.set({
			status,
			error: status === "failed" ? error : null,
			checkpoint: null,
			finishedAt: new Date(),
		})
		.where(eq(turn.id, turnId));
	yield* db.update(message).set({ status }).where(eq(message.turnId, turnId));
	yield* abandonRunningToolCalls(db, turnId, error);
});

const terminateClaimedTurn = Effect.fn("TurnStore.terminateClaimedTurn")(function* (
	db: Executor,
	jobId: string,
): Effect.fn.Return<{ state: "failed" | "cancelled"; error?: string } | undefined, QueryFailure> {
	const [active] = yield* db
		.select({ id: turn.id, status: turn.status, error: turn.error })
		.from(turn)
		.where(and(eq(turn.jobId, jobId), inArray(turn.status, ["running", "waiting"])))
		.limit(1);
	if (!active) return undefined;
	yield* finishInterruptedTurn(db, active.id, "cancelled", "Routine execution ended");
	return { state: "cancelled" };
});

/** The other crew agents placed in the pod: who this agent may collaborate with. */
const loadCrew = (db: Executor, scope: TurnScope) =>
	db
		.select({
			id: agent.id,
			name: agent.name,
			handle: agent.handle,
			description: agent.description,
		})
		.from(agent)
		.where(
			and(
				eq(agent.podId, scope.podId),
				eq(agent.workspaceId, scope.workspaceId),
				isNull(agent.systemAgentKey),
				ne(agent.id, scope.agentId),
			),
		)
		.orderBy(agent.name);

/**
 * The turn row and its reply message. A retry of the same trigger reopens the
 * existing pair rather than adding a second reply beside the first.
 */
const openTurn = Effect.fn("TurnStore.openTurn")(function* (
	db: Executor,
	claimed: ClaimedTurn,
	scope: TurnScope,
	/** The agent's model, already resolved: a turn is never opened without one. */
	model: string,
): Effect.fn.Return<
	| {
			turnId: string;
			response: MessageRow;
			checkpoint?: TurnCheckpoint;
			resumed: boolean;
	  }
	| {
			notRunnableReason: string;
			terminalOutcome?: { state: "failed" | "cancelled"; error?: string };
	  },
	QueryFailure
> {
	const [existing] = yield* db
		.select({
			id: turn.id,
			jobId: turn.jobId,
			status: turn.status,
			checkpoint: turn.checkpoint,
			mutationStarted: turn.mutationStarted,
			cancelRequested: turn.cancelRequested,
		})
		.from(turn)
		.where(
			and(
				eq(turn.triggerMessageId, claimed.payload.triggerMessageId),
				eq(turn.agentId, claimed.payload.agentId),
			),
		)
		.limit(1)
		.for("update");

	if (existing) {
		if (existing.status === "done" || existing.status === "cancelled") {
			return { notRunnableReason: "The turn has already ended" };
		}
		if (existing.cancelRequested) {
			const error = "Turn cancelled";
			yield* finishInterruptedTurn(db, existing.id, "cancelled", error);
			return {
				notRunnableReason: error,
				terminalOutcome: { state: "cancelled" },
			};
		}
		const [uncertainMutation] = yield* db
			.select({ id: toolCall.id })
			.from(toolCall)
			.where(
				and(
					eq(toolCall.turnId, existing.id),
					eq(toolCall.status, "running"),
					eq(toolCall.mutating, true),
				),
			)
			.limit(1);
		if (existing.mutationStarted && (!existing.checkpoint || uncertainMutation)) {
			const error = "A mutating tool may have run before the worker stopped";
			yield* finishInterruptedTurn(db, existing.id, "failed", error);
			return {
				notRunnableReason: error,
				terminalOutcome: { state: "failed", error },
			};
		}
		if (existing.checkpoint) {
			if (
				(existing.status !== "waiting" && existing.status !== "running") ||
				existing.jobId !== claimed.id
			) {
				return { notRunnableReason: "The suspended turn no longer belongs to this job" };
			}
			const [resumed] = yield* db
				.update(turn)
				.set({ status: "running" })
				.where(
					and(
						eq(turn.id, existing.id),
						inArray(turn.status, ["waiting", "running"]),
						eq(turn.cancelRequested, false),
						eq(turn.jobId, claimed.id),
					),
				)
				.returning({ id: turn.id });
			if (!resumed) return { notRunnableReason: "The suspended turn can no longer resume" };
			const [response] = yield* db
				.select()
				.from(message)
				.where(eq(message.turnId, existing.id))
				.limit(1);
			if (!response) throw new Error("A suspended turn has no reply message");
			return {
				turnId: existing.id,
				response,
				checkpoint: existing.checkpoint as TurnCheckpoint,
				resumed: true,
			};
		}
		yield* db
			.update(turn)
			.set({
				status: "running",
				error: null,
				finishedAt: null,
				checkpoint: null,
				jobId: claimed.id,
			})
			.where(eq(turn.id, existing.id));
		const [response] = yield* db
			.update(message)
			.set({ status: "streaming", parts: [], content: "" })
			.where(eq(message.turnId, existing.id))
			.returning();
		if (!response) {
			throw new Error("A turn being retried has no reply message");
		}
		// The reply starts again, so the calls its first attempt made go with its parts.
		yield* deleteToolCallsOf(db, response.id);
		return { turnId: existing.id, response, resumed: false };
	}

	const [created] = yield* db
		.insert(turn)
		.values({
			threadId: scope.threadId,
			agentId: scope.agentId,
			triggerMessageId: claimed.payload.triggerMessageId,
			jobId: claimed.id,
			status: "running",
			reason: claimed.payload.reason ?? null,
			model,
			startedAt: new Date(),
		})
		.returning({ id: turn.id });
	if (!created) {
		throw new Error("Turn insert returned no row");
	}
	const [response] = yield* db
		.insert(message)
		.values({
			threadId: scope.threadId,
			authorAgentId: scope.agentId,
			kind: "text",
			status: "streaming",
			parts: [],
			content: "",
			turnId: created.id,
		})
		.returning();
	if (!response) {
		throw new Error("Reply message insert returned no row");
	}
	return { turnId: created.id, response, resumed: false };
});

/**
 * loadHistory returns up to one hundred completed messages, excluding the
 * response currently being written.
 */
const loadHistory = Effect.fn("TurnStore.loadHistory")(function* (
	db: Executor,
	threadId: string,
	responseMessageId: string,
) {
	const newestFirst = yield* db
		.select({ message, ...participantColumns })
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(agent, eq(agent.id, message.authorAgentId))
		.where(
			and(
				eq(message.threadId, threadId),
				ne(message.id, responseMessageId),
				eq(message.status, "complete"),
			),
		)
		.orderBy(desc(message.createdAt), desc(message.id))
		.limit(MAX_HISTORY_MESSAGES);
	const rows = newestFirst.reverse();
	const placed = yield* loadPlacedParts(
		db,
		rows.map(({ message: row }) => row.id),
	);
	return rows.map(({ message: row, ...author }) => toMessage(row, author, placed(row.id)));
});

/** The stored parts of a reply: its text, split around the collaborations and tool calls it made. */
function replyParts(reply: ReplyDraft): StoredMessagePart[] {
	if (!reply.content && reply.collaborations.length === 0 && reply.toolCalls.length === 0) {
		return [];
	}
	const placed: Array<
		Extract<StoredMessagePart, { type: "collaboration" | "tool_call" }> & { atOffset: number }
	> = [
		...reply.collaborations.map(({ id, atOffset }) => ({
			type: "collaboration" as const,
			collaborationId: id,
			atOffset,
		})),
		...reply.toolCalls.map(({ id, atOffset }) => ({
			type: "tool_call" as const,
			toolCallId: id,
			atOffset,
		})),
	];
	const parts = messagePartsFor(reply.content, placed)
		.map((part): StoredMessagePart => {
			if (part.type === "text") return part;
			if (part.type === "collaboration")
				return { type: "collaboration", collaborationId: part.collaborationId };
			return { type: "tool_call", toolCallId: part.toolCallId };
		})
		.filter((part) => part.type !== "text" || part.text !== "");
	return parts;
}

function replyFinished(
	prepared: PreparedTurn,
	content: string,
	status: "complete" | "cancelled",
): PendingEvent {
	return {
		channel: threadChannel(prepared.context.thread.id),
		event: streamEvent("message.completed", {
			threadId: prepared.context.thread.id,
			messageId: prepared.responseMessage.id,
			content,
			status,
		}),
	};
}

function threadChanged(prepared: PreparedTurn): PendingEvent {
	return {
		channel: workspaceChannel(prepared.context.thread.workspaceId),
		event: streamEvent("thread.changed"),
	};
}
