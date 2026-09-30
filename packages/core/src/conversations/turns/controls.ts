import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { mayDecideApprovals, ResourceHidden } from "../../authorization/access.ts";
import { Authorization } from "../../authorization/authorization.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { afterCommit, query, serviceOperations, transaction } from "../../database/database.ts";
import { thread, toolCall, turn } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import { type UserFacing, UserMessage } from "../../user-message.ts";
import { awaitsDecisions } from "./lifecycle.ts";
import { TurnRepository } from "./repository.ts";
import { TurnSignals } from "./signals.ts";
import { awaitsDecision } from "./tool-calls/lifecycle.ts";
import { ToolCallRepository } from "./tool-calls/repository.ts";
import type { Turns } from "./turns.ts";
import { WorkAdmission } from "./work-admission.ts";

/**
 * `Turns.Controls`: people cancelling a turn and deciding the tool calls it
 * parked for approval. The turn reading their decisions and running what they
 * allowed is `ApprovedToolCalls`.
 */
export const makeControls = Effect.gen(function* () {
	const operation = yield* serviceOperations<Turns.ControlsInterface>("Turns.Controls");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const turns = yield* TurnRepository.Service;
	const toolCalls = yield* ToolCallRepository.Service;
	const signals = yield* TurnSignals.Service;
	const admission = yield* WorkAdmission.Service;
	return {
		cancel: (turnId) =>
			operation(
				"cancel",
				transaction(
					Effect.gen(function* () {
						const hidden = new ResourceHidden({ resource: "turn" });
						if (!isUuid(turnId)) return yield* hidden;
						const [candidate] = yield* query((db) =>
							db.select({ threadId: turn.threadId }).from(turn).where(eq(turn.id, turnId)).limit(1),
						);
						if (!candidate) return yield* hidden;
						yield* visibility
							.thread(candidate.threadId)
							.pipe(Effect.catchTag("ResourceHidden", () => Effect.fail(hidden)));
						const requested = yield* turns.requestCancel(turnId);
						if (requested._tag === "Refused") return false;
						// Telling the workflow is the cancellation; it records it. The flag
						// set with it stops the next segment instead if the workflow has
						// just stopped waiting, since the signal would then go unheard.
						if (requested._tag === "SignalOwner") {
							yield* afterCommit(signals.cancel(requested.owner));
						}
						return true;
					}),
				),
			),
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
						const [candidate] = yield* query((db) =>
							db
								.select({
									call: toolCall,
									threadId: thread.id,
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
								// The call alone: the turn is locked by whoever transitions it.
								.for("update", { of: toolCall }),
						);
						if (!candidate?.call.approvalId || !awaitsDecisions(candidate.turn)) {
							return yield* new ToolApprovalNotFound();
						}
						if (!awaitsDecision(candidate.call)) return yield* new ToolApprovalConflict();
						const forRoutine = yield* admission.forRoutine(candidate.threadId);
						if (!mayDecideApprovals(decider, forRoutine)) {
							return yield* new ToolApprovalForbidden();
						}
						const approvalId = candidate.call.approvalId;
						const decision = { decision: input.decision, userId: decider.actor.userId };
						if (!candidate.owner) return yield* new ToolApprovalNotFound();
						// Recorded and sent in one transaction: the engine writes the signal
						// through the same connection, so both commit or neither does, and
						// everyone watching the thread sees it decided as this commits. The
						// first decision recorded stands.
						const recorded = yield* toolCalls.recordDecision({
							threadId: candidate.threadId,
							approvalId,
							decision,
						});
						if (!recorded) return yield* new ToolApprovalConflict();
						return yield* signals.decide({ owner: candidate.owner, approvalId, decision });
					}),
				),
			),
	} satisfies Turns.ControlsInterface;
});

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
