import type { ToolApprovalDecision, ToolCallPart } from "@sugabots/contracts";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../../../database/database.ts";
import {
	connection,
	pod,
	routineExecution,
	thread,
	toolCall,
	turn,
} from "../../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../../user-message.ts";
import { podStandingFor } from "../../../workspaces/access.ts";
import { findRoutineExecutionId, routineSettlementLockKey } from "../../routines/execution.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";
import { awaitsDecisions, mayRunTools } from "../../turns/lifecycle.ts";
import type { TurnRepository } from "../../turns/repository.ts";
import { TurnSignals } from "../../turns/signals.ts";
import { awaitsDecision } from "../calls/lifecycle.ts";
import type { ToolCallRepository } from "../calls/repository.ts";

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
	/**
	 * Checks a person may make the decision, then sends it to the turn's
	 * workflow, which records it.
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
}

export class ToolApprovalNotFound
	extends Data.TaggedError("ToolApprovalNotFound")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`No such pending tool approval`;
	}
}
export class ToolApprovalConflict
	extends Data.TaggedError("ToolApprovalConflict")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`That tool approval has already been decided`;
	}
}
export class ToolApprovalForbidden
	extends Data.TaggedError("ToolApprovalForbidden")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`You are not allowed to make that decision`;
	}
}
/** A resumed turn found its approvals not all decided, so it cannot continue. */
export class ToolApprovalsIncomplete
	extends Data.TaggedError("ToolApprovalsIncomplete")<{ readonly message: string }>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The reply could not continue: its tool approvals were not all decided.`;
	}
}
/** An approved tool call may no longer run, so it was not started. */
export class ToolExecutionRefused extends Data.TaggedError("ToolExecutionRefused")<{
	readonly message: string;
}> {}

export const toolApprovalStore = Effect.fnUntraced(function* (
	toolCalls: ToolCallRepository,
	turns: Pick<TurnRepository, "markActed">,
) {
	const signals = yield* TurnSignals.Service;
	const store: ToolApprovalStore = {
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
								status: turn.status,
								cancelRequested: turn.cancelRequested,
							})
							.from(turn)
							.innerJoin(thread, eq(thread.id, turn.threadId))
							.innerJoin(pod, eq(pod.id, thread.podId))
							.where(and(eq(turn.id, input.turnId), eq(turn.threadId, input.threadId)))
							.limit(1)
							.for("update"),
					);
					if (!scope || !mayRunTools(scope)) {
						return yield* new ToolExecutionRefused({ message: "Turn is not running" });
					}
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
					const began = yield* toolCalls.beginExecution(input);
					if (began._tag === "Refused") {
						return yield* new ToolExecutionRefused({ message: began.reason });
					}
					if (began.call.mutating) yield* turns.markActed(began.call.turnId);
					return toToolCallPart(began.call);
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
								owner: turn.owner,
								turn: { status: turn.status, cancelRequested: turn.cancelRequested },
							})
							.from(toolCall)
							.innerJoin(turn, eq(turn.id, toolCall.turnId))
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(
								and(
									eq(toolCall.id, input.toolCallId),
									eq(thread.workspaceId, input.workspaceId),
									eq(thread.podId, input.podId),
								),
							)
							.limit(1)
							.for("update"),
					);
					if (!candidate?.call.approvalId || !awaitsDecisions(candidate.turn)) {
						return yield* new ToolApprovalNotFound();
					}
					// The caller's authority is read again here, inside the
					// transaction that sends or records the decision, so a demotion
					// between the route's check and the decision does not slip through. Somebody who
					// cannot decide at all is told nothing is there, exactly as the
					// route would have.
					const decider = yield* query((db) => podStandingFor(db, input.podId, input.userId));
					if (!decider?.may("approval.decide")) {
						return yield* new ToolApprovalNotFound();
					}
					if (!awaitsDecision(candidate.call)) return yield* new ToolApprovalConflict();
					if (routineExecutionId && !decider.may("approval.routine.decide")) {
						return yield* new ToolApprovalForbidden();
					}
					const approvalId = candidate.call.approvalId;
					const decision = { decision: input.decision, userId: input.userId };
					if (!candidate.owner) return yield* new ToolApprovalNotFound();
					// Only one person's decision reaches the workflow, so the first to
					// claim the call decides it and anyone after is told it is taken.
					// The claim is undone with this transaction if the send fails.
					if (!(yield* toolCalls.claimDecision(input.toolCallId, input.userId))) {
						return yield* new ToolApprovalConflict();
					}
					return yield* signals.decide({ owner: candidate.owner, approvalId, decision });
				}),
			),
	};
	return store;
});

/** No connection approvals, for turns that are offered no connection tools. */
export const noToolApprovalStore: ToolApprovalStore = {
	responsesForTurn: () =>
		Effect.fail(new ToolApprovalsIncomplete({ message: "Tool approvals are not configured" })),
	beginExecution: () =>
		Effect.fail(new ToolExecutionRefused({ message: "Tool approvals are not configured" })),
	decide: () => Effect.fail(new ToolApprovalNotFound()),
};
