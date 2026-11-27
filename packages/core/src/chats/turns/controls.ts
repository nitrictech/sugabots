import { ToolApprovalConflict, ToolApprovalNotFound } from "@sugabots/contracts/errors/approvals";
import { Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { approvalCutoff } from "./approval-withdrawals.ts";
import { TurnSignals } from "./signals.ts";
import { TurnStore } from "./store.ts";
import { lockCurrentApproval, readCurrentApproval } from "./tool-calls/pending-approval.ts";
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
		decide: (isMember, canDecide, shownApprovalId, decision, allow, checkConnector) =>
			operation(
				"decide",
				Effect.gen(function* () {
					const callId = canDecide.call.value;

					let connectorConflict: ToolApprovalConflict["reason"];
					if (decision === "allow_once" && checkConnector) {
						const candidate = yield* requirePendingApproval(
							query((db) => readCurrentApproval(db, callId, shownApprovalId)),
						);
						if (candidate.call.connectorId) {
							connectorConflict = yield* checkConnector(candidate.call, candidate.executionNumber);
						}
					}
					const conflict = yield* transaction(
						Effect.gen(function* () {
							const candidate = yield* requirePendingApproval(
								lockCurrentApproval(callId, shownApprovalId),
							);
							const approvalId = shownApprovalId;
							const reason =
								decision === "deny"
									? undefined
									: ((yield* allow(canDecide, candidate.call, candidate.executionNumber)) ??
										connectorConflict);
							if (reason) {
								const conflict = new ToolApprovalConflict({ reason });
								yield* toolCalls.withdrawPending(
									candidate.call.turnId,
									{ userMessage: conflict.userMessage, closedBecause: reason },
									approvalId,
								);
								yield* signals.withdraw({ executionId: candidate.executionId, approvalId });
								return conflict;
							}
							const decided = { decision, memberId: isMember.member };
							// The decision and its signal commit together, so the first decision stands.
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
					);
					// Fail after the withdrawal commits.
					if (conflict) return yield* conflict;
					return undefined;
				}),
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

function requirePendingApproval(read: ReturnType<typeof lockCurrentApproval>) {
	return Effect.gen(function* () {
		const candidate = yield* read;
		if (!candidate) return yield* new ToolApprovalNotFound();
		if (!candidate.pending) return yield* new ToolApprovalConflict();
		if (
			!candidate.executionId ||
			(candidate.call.approvalAskedAt ?? candidate.call.startedAt) <= (yield* approvalCutoff)
		)
			return yield* new ToolApprovalNotFound();
		return { ...candidate, executionId: candidate.executionId };
	});
}
