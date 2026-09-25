import type {
	ToolApprovalDecision,
	ToolApprovalSummary,
	ToolCallPart,
} from "@sugabots/contracts";
import { streamEvent, threadChannel } from "@sugabots/contracts";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../../../database/database.ts";
import type { PublishEvents } from "../../../database/events/publish.ts";
import {
	connection,
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
import { ownedByJob, resumeWaitingJob } from "../../turns/owner.ts";
import type { TurnSignals } from "../../turns/signals.ts";
import type { ApprovalDecision } from "../../turns/turn.workflow.ts";
import { boundedJson } from "../calls/store.ts";

/**
 * What an approval is for: a tool on one of the pod's connections, at the
 * configuration it was approved under, or one of the product's own tools.
 */
export type ApprovalTarget =
	| {
			kind: "connection";
			connectionId: string;
			connectionRevision: number;
			remoteToolName: string;
	  }
	| { kind: "built_in" };

export interface PendingToolApproval {
	id: string;
	approvalId: string;
	sdkToolCallId: string;
	tool: string;
	input: unknown;
	reason?: string;
	target: ApprovalTarget;
	/** What the server found the call would do, shown to whoever decides. The model doesn't write it. */
	summary?: ToolApprovalSummary;
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
		target: ApprovalTarget;
	}): Effect.Effect<ToolCallPart, ToolExecutionRefused, Database>;
	/** What was shown to whoever approved the call, so the call does exactly that. */
	approvedSummary(
		turnId: string,
		sdkToolCallId: string,
	): Effect.Effect<ToolApprovalSummary | undefined, never, Database>;
	/**
	 * Checks a person may make the decision, then sends it to the turn's
	 * workflow, which records it. A turn run as a job records it here.
	 */
	decide(input: {
		workspaceId: string;
		podId: string;
		toolCallId: string;
		userId: string;
		decision: ToolApprovalDecision["decision"];
	}): Effect.Effect<
		void,
		ToolApprovalNotFound | ToolApprovalConflict | ToolApprovalForbidden,
		Database
	>;
	/** Records a decision on an approval in the thread, and announces it. Does nothing once decided. */
	record(input: {
		threadId: string;
		approvalId: string;
		decision: ApprovalDecision;
	}): Effect.Effect<void, never, Database>;
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

export function toolApprovalStore(
	publishEvents: PublishEvents,
	signals: TurnSignals,
): ToolApprovalStore {
	/** Writes a decision still pending and announces it; `undefined` if it was already decided. */
	const recordDecision = (threadId: string, approvalId: string, decision: ApprovalDecision) =>
		Effect.gen(function* () {
			const allowed = decision.decision !== "deny";
			const [updated] = yield* query((db) =>
				db
					.update(toolCall)
					.set({
						approvalStatus: allowed ? "allowed" : "denied",
						decidedById: decision.userId,
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
					.where(
						and(
							eq(toolCall.threadId, threadId),
							eq(toolCall.approvalId, approvalId),
							eq(toolCall.approvalStatus, "pending"),
						),
					)
					.returning(),
			);
			if (!updated) return undefined;
			const [deciderName] = yield* query((db) =>
				db.select({ name: user.name }).from(user).where(eq(user.id, decision.userId)).limit(1),
			);
			yield* publishEvents([
				callEvent(
					"tool_call.updated",
					toToolCallPart(updated, deciderName?.name ?? null),
					updated.threadId,
					updated.messageId,
				),
			]);
			return updated;
		});

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

		approvedSummary: (turnId, sdkToolCallId) =>
			Effect.map(
				query((db) =>
					db
						.select({ summary: toolCall.approvalSummary })
						.from(toolCall)
						.where(
							and(
								eq(toolCall.turnId, turnId),
								eq(toolCall.sdkToolCallId, sdkToolCallId),
								eq(toolCall.approvalStatus, "allowed"),
							),
						)
						.limit(1),
				),
				([row]) => row?.summary ?? undefined,
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
					const target = input.target;
					// A connection tool runs only under the configuration it was approved
					// under; a built-in tool has no configuration to have changed.
					if (target.kind === "connection") {
						const [currentConnection] = yield* query((db) =>
							db
								.select({ revision: connection.configurationRevision })
								.from(connection)
								.where(
									and(
										eq(connection.id, target.connectionId),
										eq(connection.workspaceId, scope.workspaceId),
										eq(connection.podId, scope.podId),
										ne(connection.access, "off"),
										eq(connection.configurationRevision, target.connectionRevision),
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
					// Every call needing approval was parked for a person to allow first.
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
									...(target.kind === "connection"
										? [
												eq(toolCall.connectionId, target.connectionId),
												eq(toolCall.connectionRevision, target.connectionRevision),
												eq(toolCall.remoteToolName, target.remoteToolName),
											]
										: [isNull(toolCall.connectionId)]),
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
								owner: turn.owner,
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
					// transaction that sends or records the decision, so a demotion
					// between the route's check and the decision does not slip through. Somebody who
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
					const approvalId = candidate.call.approvalId;
					const decision = { decision: input.decision, userId: input.userId };
					if (!candidate.owner) return yield* new ToolApprovalNotFound();
					if (!(yield* ownedByJob(candidate.owner))) {
						// Only one person's decision reaches the workflow, so the first to
						// claim the call decides it and anyone after is told it is taken.
						// The claim is undone with this transaction if the send fails.
						const claimed = yield* query((db) =>
							db
								.update(toolCall)
								.set({ decidedById: input.userId })
								.where(
									and(
										eq(toolCall.id, input.toolCallId),
										eq(toolCall.approvalStatus, "pending"),
										isNull(toolCall.decidedById),
									),
								)
								.returning({ id: toolCall.id }),
						);
						if (claimed.length === 0) return yield* new ToolApprovalConflict();
						return yield* signals.decide({ owner: candidate.owner, approvalId, decision });
					}
					const recorded = yield* recordDecision(candidate.threadId, approvalId, decision);
					if (!recorded) return yield* new ToolApprovalConflict();
					const [count] = yield* query((db) =>
						db
							.select({ unresolved: sql<number>`count(*)`.mapWith(Number) })
							.from(toolCall)
							.where(
								and(eq(toolCall.turnId, recorded.turnId), eq(toolCall.approvalStatus, "pending")),
							),
					);
					if ((count?.unresolved ?? 0) === 0) yield* resumeWaitingJob(candidate.owner);
				}),
			),

		record: (input) =>
			transaction(recordDecision(input.threadId, input.approvalId, input.decision)).pipe(
				Effect.asVoid,
			),
	};
}

/** No connection approvals for workers that are not offered connection tools. */
export const noToolApprovalStore: ToolApprovalStore = {
	responsesForTurn: () =>
		Effect.fail(new ToolApprovalsIncomplete({ message: "Tool approvals are not configured" })),
	beginExecution: () =>
		Effect.fail(new ToolExecutionRefused({ message: "Tool approvals are not configured" })),
	approvedSummary: () => Effect.undefined,
	decide: () => Effect.fail(new ToolApprovalNotFound()),
	record: () => Effect.void,
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
