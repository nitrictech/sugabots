export * as ToolApprovals from "./tool-approvals.ts";

import type { ToolApprovalDecision } from "@sugabots/contracts";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import type { CurrentActor } from "../../../authorization/current-actor.ts";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import { thread, toolCall, turn } from "../../../database/schema.ts";
import { isUuid } from "../../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../../user-message.ts";
import { lockRoutineSettlementOf } from "../../routines/execution.ts";
import { awaitsDecisions } from "../lifecycle.ts";
import { TurnSignals } from "../signals.ts";
import { awaitsDecision } from "../tool-calls/lifecycle.ts";
import { ToolCallRepository } from "../tool-calls/repository.ts";

/**
 * People deciding the tool calls a reply parked for approval. The turn reading
 * their decisions and running what they allowed is `ApprovedToolCalls`.
 */
export interface Interface {
	/**
	 * Checks the current actor may make the decision, then sends it, as theirs,
	 * to the turn's workflow, which records it.
	 */
	readonly decide: (input: {
		podId: string;
		toolCallId: string;
		decision: ToolApprovalDecision["decision"];
	}) => Effect.Effect<
		void,
		AuthorizationDenied | ToolApprovalNotFound | ToolApprovalConflict | ToolApprovalForbidden,
		CurrentActor.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ToolApprovals",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ToolApprovals");
	const authorization = yield* Authorization.Service;
	const toolCalls = yield* ToolCallRepository.Service;
	const signals = yield* TurnSignals.Service;
	return Service.of({
		decide: (input) =>
			operation(
				"decide",
				transaction(
					Effect.gen(function* () {
						// Inside the transaction that sends or records the decision, so a
						// demotion a moment earlier is seen.
						const decider = yield* authorization.pod(input.podId, "approval.decide");
						const { pod } = decider;
						if (!isUuid(input.toolCallId)) return yield* new ToolApprovalNotFound();
						const [approvalThread] = yield* query((db) =>
							db
								.select({ id: thread.id })
								.from(toolCall)
								.innerJoin(thread, eq(thread.id, toolCall.threadId))
								.where(
									and(
										eq(toolCall.id, input.toolCallId),
										eq(thread.workspaceId, pod.workspaceId),
										eq(thread.podId, pod.id),
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
										eq(thread.workspaceId, pod.workspaceId),
										eq(thread.podId, pod.id),
									),
								)
								.limit(1)
								// The call alone: whoever ends its turn locks the turn before the
								// settlement lock this holds, so waiting on the turn could deadlock.
								.for("update", { of: toolCall }),
						);
						if (!candidate?.call.approvalId || !awaitsDecisions(candidate.turn)) {
							return yield* new ToolApprovalNotFound();
						}
						if (!awaitsDecision(candidate.call)) return yield* new ToolApprovalConflict();
						if (routineExecutionId && !decider.may("approval.routine.decide")) {
							return yield* new ToolApprovalForbidden();
						}
						const approvalId = candidate.call.approvalId;
						const decision = { decision: input.decision, userId: decider.actor.userId };
						if (!candidate.owner) return yield* new ToolApprovalNotFound();
						// Only one person's decision reaches the workflow, so the first to
						// claim the call decides it and anyone after is told it is taken.
						// The claim is undone with this transaction if the send fails.
						if (!(yield* toolCalls.claimDecision(input.toolCallId, decider.actor.userId))) {
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
	Layer.provide([Authorization.layer, ToolCallRepository.layer]),
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
