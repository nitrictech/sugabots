import { ToolApprovalConflict, ToolApprovalNotFound } from "@sugabots/contracts/errors/approvals";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { toolCall, turn } from "../../database/schema.ts";
import { awaitsDecisions } from "./lifecycle.ts";
import { TurnSignals } from "./signals.ts";
import { awaitsDecision } from "./tool-calls/lifecycle.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import type { Turns } from "./turns.ts";

/**
 * `Turns.Controls`: members deciding the tool calls a turn parked for
 * approval, once `CanDecide` has found them its approver. The turn reading
 * their decisions and running what they allowed is `ApprovedToolCalls`.
 */
export const makeControls = Effect.gen(function* () {
	const operation = yield* serviceOperations<Turns.ControlsInterface>("Turns.Controls");
	const toolCalls = yield* ToolCallStore.Service;
	const signals = yield* TurnSignals.Service;
	return {
		decide: (isMember, canDecide, decision) =>
			operation(
				"decide",
				transaction(
					Effect.gen(function* () {
						const [candidate] = yield* query((db) =>
							db
								.select({
									call: toolCall,
									chatId: toolCall.chatId,
									executionId: turn.executionId,
									turn: { status: turn.status, interruptRequested: turn.interruptRequested },
								})
								.from(toolCall)
								.innerJoin(turn, eq(turn.id, toolCall.turnId))
								.where(eq(toolCall.id, canDecide.call.value))
								.limit(1)
								// The call alone: the turn is locked by whoever transitions it.
								.for("update", { of: toolCall }),
						);
						if (!candidate?.call.approvalId || !awaitsDecisions(candidate.turn)) {
							return yield* new ToolApprovalNotFound();
						}
						if (!awaitsDecision(candidate.call)) return yield* new ToolApprovalConflict();
						if (!candidate.executionId) return yield* new ToolApprovalNotFound();
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
						return yield* signals.decide({
							executionId: candidate.executionId,
							approvalId,
							decision: decided,
						});
					}),
				),
			),
	} satisfies Turns.ControlsInterface;
});
