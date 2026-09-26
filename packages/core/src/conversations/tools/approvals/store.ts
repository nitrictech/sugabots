import type { ToolApprovalDecision, ToolCallPart } from "@sugabots/contracts";
import { streamEvent, threadChannel } from "@sugabots/contracts";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../../../database/database.ts";
import type { PublishEvents } from "../../../database/events/publish.ts";
import {
	connection,
	job,
	pod,
	routineExecution,
	thread,
	toolCall,
	turn,
	user,
} from "../../../database/schema.ts";
import { podStandingFor } from "../../../workspaces/access.ts";
import { findRoutineExecutionId, routineSettlementLockKey } from "../../routines/execution.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";
import { boundedJson } from "../calls/store.ts";

export interface PendingToolApproval {
	id: string;
	approvalId: string;
	sdkToolCallId: string;
	tool: string;
	input: unknown;
	reason?: string;
	connectionId: string;
	connectionRevision: number;
	remoteToolName: string;
	/** Whether the tool may change something, as opposed to one the connection's `ask` holds back. */
	mutating: boolean;
	atOffset: number;
}

export interface ToolApprovalStore {
	responsesForTurn(
		turnId: string,
		approvalIds: readonly string[],
	): Effect.Effect<ToolModelMessage, ToolApprovalsIncomplete, Database>;
	beginExecution(input: {
		threadId: string;
		messageId: string;
		turnId: string;
		sdkToolCallId: string;
		tool: string;
		input: unknown;
		atOffset: number;
		connectionId: string;
		connectionRevision: number;
		remoteToolName: string;
	}): Effect.Effect<ToolCallPart, ToolExecutionRefused, Database>;
	decide(input: {
		workspaceId: string;
		podId: string;
		toolCallId: string;
		userId: string;
		decision: ToolApprovalDecision["decision"];
	}): Effect.Effect<
		ToolCallPart,
		ToolApprovalNotFound | ToolApprovalConflict | ToolApprovalForbidden,
		Database
	>;
}

export class ToolApprovalNotFound extends Data.TaggedError("ToolApprovalNotFound") {}
export class ToolApprovalConflict extends Data.TaggedError("ToolApprovalConflict") {}
export class ToolApprovalForbidden extends Data.TaggedError("ToolApprovalForbidden") {}
export class ToolApprovalsIncomplete extends Data.TaggedError("ToolApprovalsIncomplete")<{
	readonly message: string;
}> {}
export class ToolExecutionRefused extends Data.TaggedError("ToolExecutionRefused")<{
	readonly message: string;
}> {}

export function toolApprovalStore(publishEvents: PublishEvents): ToolApprovalStore {
	return {
		responsesForTurn: (turnId, approvalIds) =>
			Effect.flatMap(
				query((db) =>
					db
						.select({ approvalId: toolCall.approvalId, status: toolCall.approvalStatus })
						.from(toolCall)
						.where(and(eq(toolCall.turnId, turnId), inArray(toolCall.approvalId, [...approvalIds])))
						.orderBy(toolCall.createdAt, toolCall.id),
				),
				(rows) => {
					const expected = new Set(approvalIds);
					if (
						rows.length !== expected.size ||
						rows.some(
							(row) => !row.approvalId || !expected.has(row.approvalId) || row.status === "pending",
						)
					) {
						return Effect.fail(
							new ToolApprovalsIncomplete({ message: "Turn approval decisions are incomplete" }),
						);
					}
					return Effect.succeed({
						role: "tool" as const,
						content: rows.map(
							(row): ToolApprovalResponse => ({
								type: "tool-approval-response",
								approvalId: row.approvalId as string,
								approved: row.status === "allowed",
								reason:
									row.status === "allowed"
										? "A person approved this action"
										: "A person denied this action",
							}),
						),
					});
				},
			),

		beginExecution: (input) =>
			transaction(
				Effect.gen(function* () {
					const executionId = yield* query((db) => findRoutineExecutionId(db, input.threadId));
					if (executionId) {
						const lockKey = routineSettlementLockKey(executionId);
						yield* query((db) =>
							db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
						);
						const [execution] = yield* query((db) =>
							db
								.select({
									state: routineExecution.state,
									pendingTerminalState: routineExecution.pendingTerminalState,
								})
								.from(routineExecution)
								.where(eq(routineExecution.id, executionId))
								.limit(1),
						);
						if (execution?.state !== "running" || execution.pendingTerminalState) {
							return yield* new ToolExecutionRefused({ message: "Routine execution has ended" });
						}
					}
					const [scope] = yield* query((db) =>
						db
							.select({
								workspaceId: thread.workspaceId,
								podId: thread.podId,
							})
							.from(turn)
							.innerJoin(thread, eq(thread.id, turn.threadId))
							.innerJoin(pod, eq(pod.id, thread.podId))
							.where(
								and(
									eq(turn.id, input.turnId),
									eq(turn.threadId, input.threadId),
									eq(turn.status, "running"),
									eq(turn.cancelRequested, false),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!scope) return yield* new ToolExecutionRefused({ message: "Turn is not running" });
					const [currentConnection] = yield* query((db) =>
						db
							.select({ revision: connection.configurationRevision })
							.from(connection)
							.where(
								and(
									eq(connection.id, input.connectionId),
									eq(connection.workspaceId, scope.workspaceId),
									eq(connection.podId, scope.podId),
									ne(connection.access, "off"),
									eq(connection.configurationRevision, input.connectionRevision),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!currentConnection) {
						return yield* new ToolExecutionRefused({
							message: "Connection configuration changed after approval",
						});
					}
					const [existing] = yield* query((db) =>
						db
							.select()
							.from(toolCall)
							.where(
								and(
									eq(toolCall.turnId, input.turnId),
									eq(toolCall.sdkToolCallId, input.sdkToolCallId),
								),
							)
							.limit(1)
							.for("update"),
					);
					// Every call to a connection's tool was parked for a person to allow first.
					if (!existing) {
						return yield* new ToolExecutionRefused({ message: "Tool call has no approval record" });
					}
					if (existing.approvalStatus !== "allowed" || existing.status !== "awaiting_approval") {
						return yield* new ToolExecutionRefused({
							message: "Tool call is not approved for execution",
						});
					}
					const [running] = yield* query((db) =>
						db
							.update(toolCall)
							.set({ status: "running", startedAt: new Date() })
							.where(
								and(
									eq(toolCall.id, existing.id),
									eq(toolCall.threadId, input.threadId),
									eq(toolCall.messageId, input.messageId),
									eq(toolCall.status, "awaiting_approval"),
									eq(toolCall.tool, input.tool),
									eq(toolCall.connectionId, input.connectionId),
									eq(toolCall.connectionRevision, input.connectionRevision),
									eq(toolCall.remoteToolName, input.remoteToolName),
									sql`${toolCall.executionInput} = ${JSON.stringify(executionJson(input.input))}::jsonb`,
								),
							)
							.returning(),
					);
					if (!running)
						return yield* new ToolExecutionRefused({
							message: "Tool call execution was already claimed",
						});
					if (running.mutating) yield* markMutationStarted(running.turnId);
					const part = toToolCallPart(running);
					yield* publishEvents([
						callEvent("tool_call.updated", part, running.threadId, running.messageId),
					]);
					return part;
				}),
			),

		decide: (input) =>
			transaction(
				Effect.gen(function* () {
					const [approvalThread] = yield* query((db) =>
						db
							.select({ id: thread.id })
							.from(toolCall)
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(
								and(
									eq(toolCall.id, input.toolCallId),
									eq(thread.workspaceId, input.workspaceId),
									eq(thread.podId, input.podId),
								),
							)
							.limit(1),
					);
					if (!approvalThread) return yield* new ToolApprovalNotFound();
					const routineExecutionId = yield* query((db) =>
						findRoutineExecutionId(db, approvalThread.id),
					);
					if (routineExecutionId) {
						const lockKey = routineSettlementLockKey(routineExecutionId);
						yield* query((db) =>
							db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`),
						);
					}
					const [candidate] = yield* query((db) =>
						db
							.select({
								call: toolCall,
								threadId: thread.id,
								agentId: turn.agentId,
								jobId: turn.jobId,
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(
								and(
									eq(toolCall.id, input.toolCallId),
									eq(thread.workspaceId, input.workspaceId),
									eq(thread.podId, input.podId),
									eq(turn.status, "waiting"),
									eq(turn.cancelRequested, false),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!candidate?.call.approvalId) return yield* new ToolApprovalNotFound();
					// The caller's authority is read again here, inside the
					// transaction that settles the call, so a demotion between the
					// route's check and the write does not slip through. Somebody who
					// cannot decide at all is told nothing is there, exactly as the
					// route would have.
					const decider = yield* query((db) => podStandingFor(db, input.podId, input.userId));
					if (!decider?.may("approval.decide")) {
						return yield* new ToolApprovalNotFound();
					}
					if (candidate.call.approvalStatus !== "pending") return yield* new ToolApprovalConflict();
					if (routineExecutionId && !decider.may("approval.routine.decide")) {
						return yield* new ToolApprovalForbidden();
					}
					const allowed = input.decision !== "deny";
					const [updated] = yield* query((db) =>
						db
							.update(toolCall)
							.set({
								approvalStatus: allowed ? "allowed" : "denied",
								decidedById: input.userId,
								decidedAt: new Date(),
								...(allowed
									? {}
									: {
											status: "completed" as const,
											output: boundedJson({
												status: "denied",
												reason: "A person denied this action",
											}),
											finishedAt: new Date(),
										}),
							})
							.where(and(eq(toolCall.id, input.toolCallId), eq(toolCall.approvalStatus, "pending")))
							.returning(),
					);
					if (!updated) return yield* new ToolApprovalConflict();
					const [deciderName] = yield* query((db) =>
						db.select({ name: user.name }).from(user).where(eq(user.id, input.userId)).limit(1),
					);
					const part = toToolCallPart(updated, deciderName?.name ?? null);
					yield* publishEvents([
						callEvent("tool_call.updated", part, updated.threadId, updated.messageId),
					]);

					const [count] = yield* query((db) =>
						db
							.select({ unresolved: sql<number>`count(*)`.mapWith(Number) })
							.from(toolCall)
							.where(
								and(eq(toolCall.turnId, updated.turnId), eq(toolCall.approvalStatus, "pending")),
							),
					);
					if ((count?.unresolved ?? 0) === 0) {
						yield* query((db) =>
							db
								.update(job)
								.set({ status: "queued", availableAt: new Date(), lockedAt: null })
								.where(
									and(
										eq(job.id, candidate.jobId ?? "00000000-0000-0000-0000-000000000000"),
										eq(job.status, "waiting"),
										sql`exists (
											select 1 from ${turn}
											where ${turn.jobId} = ${job.id}
												and ${turn.status} = 'waiting'
												and ${turn.cancelRequested} = false
										)`,
									),
								),
						);
					}
					return part;
				}),
			),
	};
}

/** No connection approvals for workers that are not offered connection tools. */
export const noToolApprovalStore: ToolApprovalStore = {
	responsesForTurn: () =>
		Effect.fail(new ToolApprovalsIncomplete({ message: "Tool approvals are not configured" })),
	beginExecution: () =>
		Effect.fail(new ToolExecutionRefused({ message: "Tool approvals are not configured" })),
	decide: () => Effect.fail(new ToolApprovalNotFound()),
};

export function executionJson(value: unknown) {
	return JSON.parse(JSON.stringify(value ?? null));
}

const markMutationStarted = (turnId: string) =>
	query((db) =>
		db
			.update(turn)
			.set({
				mutationStarted: true,
				checkpoint: sql`case when ${turn.checkpoint} is null then null else jsonb_set(${turn.checkpoint}, '{reply,acted}', 'true'::jsonb, true) end`,
			})
			.where(eq(turn.id, turnId)),
	).pipe(Effect.asVoid);

function callEvent(
	type: "tool_call.started" | "tool_call.updated",
	toolCallPart: ToolCallPart,
	threadId: string,
	messageId: string,
) {
	return {
		channel: threadChannel(threadId),
		event: streamEvent(type, { threadId, messageId, toolCall: toolCallPart }),
	};
}
