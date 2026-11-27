import { ToolApprovalConflict, ToolApprovalNotFound } from "@sugabots/contracts/errors/approvals";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { toolCall, turn } from "../../database/schema.ts";
import { proveCanDecide } from "../../proofs/can-decide.ts";
import { approvalCutoff } from "./approval-withdrawals.ts";
import { awaitsDecisions } from "./lifecycle.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";
import { awaitsDecision } from "./tool-calls/lifecycle.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import type { Turns } from "./turns.ts";

/**
 * `Turns.Controls`: members deciding the tool calls a turn parked for
 * approval, once `CanDecide` has found them its approver; its asker steering
 * it, once `CanSteer` has; and interrupting it, once `CanInterrupt` has. The
 * turn reading their decisions and running what they allowed is
 * `ApprovedToolCalls`.
 */
export const makeControls = Effect.gen(function* () {
	const operation = yield* serviceOperations<Turns.ControlsInterface>("Turns.Controls");
	const toolCalls = yield* ToolCallStore.Service;
	const turns = yield* TurnStore.Service;
	const signals = yield* TurnSignals.Service;
	return {
		decide: (isMember, canDecide, shownApprovalId, decision, allowed) =>
			operation(
				"decide",
				transaction(
					Effect.gen(function* () {
						// The turn's row first, then the call's, in the lock order (see
						// `TurnStore`'s `lockedTurn`): a decision waits for a turn being
						// ended, and then finds it ended, and a steer or an interrupt never
						// races it.
						const [owner] = yield* query((db) =>
							db
								.select({ turnId: toolCall.turnId })
								.from(toolCall)
								.where(eq(toolCall.id, canDecide.call.value))
								.limit(1),
						);
						if (!owner) return yield* new ToolApprovalNotFound();
						yield* query((db) =>
							db.select({ id: turn.id }).from(turn).where(eq(turn.id, owner.turnId)).for("update"),
						);
						const [candidate] = yield* query((db) =>
							db
								.select({
									call: toolCall,
									chatId: toolCall.chatId,
									executionId: turn.executionId,
									turn: { status: turn.status, endRequested: turn.endRequested },
								})
								.from(toolCall)
								.innerJoin(turn, eq(turn.id, toolCall.turnId))
								.where(eq(toolCall.id, canDecide.call.value))
								.limit(1)
								.for("update", { of: toolCall }),
						);
						// A call asked again has a new approval, which the one shown doesn't decide.
						if (
							candidate?.call.approvalId !== shownApprovalId ||
							!awaitsDecisions(candidate.turn)
						) {
							return yield* new ToolApprovalNotFound();
						}
						if (!awaitsDecision(candidate.call)) return yield* new ToolApprovalConflict();
						if (
							(candidate.call.approvalAskedAt ?? candidate.call.startedAt) <=
							(yield* approvalCutoff)
						)
							return yield* new ToolApprovalNotFound();
						if (!candidate.executionId) return yield* new ToolApprovalNotFound();
						// Who may decide is proved again as the decision is made, so one who
						// lost the standing since they were shown the call can't decide it.
						const approver = yield* proveCanDecide(isMember, canDecide.call);
						const approvalId = candidate.call.approvalId;
						const decided = { decision, memberId: isMember.member };
						// Recorded and sent in one transaction: the engine writes the signal
						// through the same connection, so both commit or neither does, and
						// everyone watching the chat sees it decided as this commits. The
						// first decision recorded stands.
						const recorded = yield* toolCalls.recordDecision({
							chatId: candidate.chatId,
							approvalId,
							decision: decided,
						});
						if (!recorded) return yield* new ToolApprovalConflict();
						if (decision !== "deny") yield* allowed(approver);
						return yield* signals.decide({
							executionId: candidate.executionId,
							approvalId,
							decision: decided,
						});
					}),
				),
			),

		steer: (canSteer, steer) =>
			operation(
				"steer",
				transaction(
					Effect.gen(function* () {
						const steered = yield* turns.steer(canSteer.turn.value, steer);
						if (steered._tag === "NotSteered") return false;
						// Sent in the steer's transaction, as a decision is, so the turn hears
						// its approvals were withdrawn only if the steer commits.
						const withdrawn = steered.withdrawn;
						if (withdrawn) {
							yield* Effect.forEach(
								withdrawn.approvalIds,
								(approvalId) =>
									signals.withdraw({ executionId: withdrawn.executionId, approvalId }),
								{ discard: true },
							);
						}
						return true;
					}),
				),
			),

		interrupt: (canInterrupt) =>
			operation(
				"interrupt",
				transaction(
					Effect.gen(function* () {
						const { executionToTell } = yield* turns.interrupt(canInterrupt.turn.value);
						if (executionToTell) yield* signals.cancel(executionToTell);
					}),
				),
			),
	} satisfies Turns.ControlsInterface;
});
