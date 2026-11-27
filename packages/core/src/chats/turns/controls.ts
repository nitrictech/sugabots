import { ToolApprovalConflict, ToolApprovalNotFound } from "@sugabots/contracts/errors/approvals";
import { Effect } from "effect";
import { serviceOperations, transaction } from "../../database/database.ts";
import { approvalCutoff } from "./approval-withdrawals.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";
import { lockCurrentApproval } from "./tool-calls/pending-approval.ts";
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
		decide: (isMember, canDecide, shownApprovalId, decision, allow) =>
			operation(
				"decide",
				transaction(
					Effect.gen(function* () {
						const candidate = yield* lockCurrentApproval(canDecide.call.value, shownApprovalId);
						if (!candidate) return yield* new ToolApprovalNotFound();
						if (!candidate.pending) return yield* new ToolApprovalConflict();
						if (
							(candidate.call.approvalAskedAt ?? candidate.call.startedAt) <=
							(yield* approvalCutoff)
						)
							return yield* new ToolApprovalNotFound();
						if (!candidate.executionId) return yield* new ToolApprovalNotFound();
						if (decision !== "deny")
							yield* allow(canDecide, candidate.call, candidate.executionNumber);
						const approvalId = shownApprovalId;
						const decided = { decision, memberId: isMember.member };
						// Recorded and sent in one transaction: the engine writes the signal
						// through the same connection, so both commit or neither does, and
						// everyone watching the chat sees it decided as this commits. The
						// first decision recorded stands.
						const recorded = yield* toolCalls.recordDecision({
							chatId: candidate.call.chatId,
							approvalId,
							decision: decided,
						});
						if (!recorded) return yield* new ToolApprovalConflict();
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
