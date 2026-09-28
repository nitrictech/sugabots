export * as ToolApprovals from "./tool-approvals.ts";

import type { ToolApprovalDecision, ToolCallPart } from "@sugabots/contracts";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import { thread, toolCall, turn } from "../../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../../user-message.ts";
import { podStandingFor } from "../../../workspaces/access.ts";
import { lockRoutineSettlementOf } from "../../routines/execution.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";
import { awaitsDecisions } from "../../turns/lifecycle.ts";
import { TurnRepository } from "../../turns/repository.ts";
import { TurnSignals } from "../../turns/signals.ts";
import { awaitsDecision } from "../calls/lifecycle.ts";
import { ToolCallRepository } from "../calls/repository.ts";

/**
 * People deciding the tool calls a reply parked for approval, and the turn
 * running the calls they allowed.
 */
export interface Interface {
	/**
	 * What people decided on the approvals a suspended turn asked for, as the
	 * model reads it when the turn continues. Fails while any is undecided.
	 */
	readonly responsesForTurn: (
		turnId: string,
		approvalIds: readonly string[],
	) => Effect.Effect<ToolModelMessage, ToolApprovalsIncomplete>;
	/**
	 * Starts an allowed call (see `ToolCallRepository.beginExecution`). A call
	 * that may change something marks its turn as having acted (ADR 002).
	 */
	readonly beginExecution: (input: {
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
	}) => Effect.Effect<ToolCallPart, ToolExecutionRefused>;
	/**
	 * Checks a person may make the decision, then sends it to the turn's
	 * workflow, which records it.
	 */
	readonly decide: (input: {
		workspaceId: string;
		podId: string;
		toolCallId: string;
		userId: string;
		decision: ToolApprovalDecision["decision"];
	}) => Effect.Effect<void, ToolApprovalNotFound | ToolApprovalConflict | ToolApprovalForbidden>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ToolApprovals",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ToolApprovals");
	const toolCalls = yield* ToolCallRepository.Service;
	const turns = yield* TurnRepository.Service;
	const signals = yield* TurnSignals.Service;
	return Service.of({
		responsesForTurn: (turnId, approvalIds) =>
			operation(
				"responsesForTurn",
				Effect.flatMap(
					query((db) =>
						db
							.select({ approvalId: toolCall.approvalId, status: toolCall.approvalStatus })
							.from(toolCall)
							.where(
								and(eq(toolCall.turnId, turnId), inArray(toolCall.approvalId, [...approvalIds])),
							)
							.orderBy(toolCall.createdAt, toolCall.id),
					),
					(rows) => {
						const expected = new Set(approvalIds);
						if (
							rows.length !== expected.size ||
							rows.some(
								(row) =>
									!row.approvalId || !expected.has(row.approvalId) || row.status === "pending",
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
			),

		beginExecution: (input) =>
			operation(
				"beginExecution",
				transaction(
					Effect.gen(function* () {
						const began = yield* toolCalls.beginExecution(input);
						if (began._tag === "Refused") {
							return yield* new ToolExecutionRefused({ message: began.reason });
						}
						if (began.call.mutating) yield* turns.markActed(began.call.turnId);
						return toToolCallPart(began.call);
					}),
				),
			),

		decide: (input) =>
			operation(
				"decide",
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
						const routineExecutionId = yield* lockRoutineSettlementOf(approvalThread.id);
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
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ToolCallRepository.layer, TurnRepository.layer]),
);

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
