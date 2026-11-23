import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { computerProjectStandingFor, mayDecideToolCall } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import { Visibility } from "../../authorization/visibility.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { toolCall, turn } from "../../database/schema.ts";
import { isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import { approversOf } from "../tools/approvers.ts";
import { awaitsDecisions } from "./lifecycle.ts";
import { TurnSignals } from "./signals.ts";
import { awaitsDecision } from "./tool-calls/lifecycle.ts";
import { ToolCallStore } from "./tool-calls/store.ts";
import type { Turns } from "./turns.ts";
import { WorkAdmission } from "./work-admission.ts";

/**
 * `Turns.Controls`: people deciding the tool calls a turn parked for
 * approval. The turn reading their decisions and running what they allowed is
 * `ApprovedToolCalls`.
 */
export const makeControls = Effect.gen(function* () {
	const operation = yield* serviceOperations<Turns.ControlsInterface>("Turns.Controls");
	const visibility = yield* Visibility.Service;
	const toolCalls = yield* ToolCallStore.Service;
	const signals = yield* TurnSignals.Service;
	const admission = yield* WorkAdmission.Service;
	return {
		decide: (input) =>
			operation(
				"decide",
				transaction(
					Effect.gen(function* () {
						// Inside the transaction that sends or records the decision, so a
						// demotion a moment earlier is seen.
						if (!isUuid(input.toolCallId)) return yield* new ToolApprovalNotFound();
						const [candidate] = yield* query((db) =>
							db
								.select({
									call: toolCall,
									chatId: toolCall.chatId,
									botId: turn.botId,
									owner: turn.owner,
									turn: { status: turn.status, cancelRequested: turn.cancelRequested },
								})
								.from(toolCall)
								.innerJoin(turn, eq(turn.id, toolCall.turnId))
								.where(eq(toolCall.id, input.toolCallId))
								.limit(1)
								// The call alone: the turn is locked by whoever transitions it.
								.for("update", { of: toolCall }),
						);
						if (!candidate?.call.approvalId || !awaitsDecisions(candidate.turn)) {
							return yield* new ToolApprovalNotFound();
						}
						// Seeing the chat is enough to ask; who decides is `mayDecideToolCall`'s to say.
						const reached = yield* visibility
							.chatStanding(candidate.chatId)
							.pipe(Effect.mapError(() => new ToolApprovalNotFound()));
						const { personId } = yield* CurrentActor.Service;
						if (!awaitsDecision(candidate.call)) return yield* new ToolApprovalConflict();
						const approvers = approversOf(candidate.call.tool);
						const computerProject =
							approvers === "computer-managers"
								? yield* query((db) =>
										computerProjectStandingFor(db, candidate.chatId, candidate.botId, personId),
									)
								: undefined;
						// The chat's people decide, and in an automation's run only those managing its bot.
						const runBot =
							approvers === "chat" ? yield* admission.runBotOf(candidate.chatId) : undefined;
						if (!mayDecideToolCall(reached.standing, computerProject, runBot, approvers)) {
							return yield* new ToolApprovalForbidden();
						}
						const approvalId = candidate.call.approvalId;
						const decision = { decision: input.decision, personId };
						if (!candidate.owner) return yield* new ToolApprovalNotFound();
						// Recorded and sent in one transaction: the engine writes the signal
						// through the same connection, so both commit or neither does, and
						// everyone watching the chat sees it decided as this commits. The
						// first decision recorded stands.
						const recorded = yield* toolCalls.recordDecision({
							chatId: candidate.chatId,
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
		return userText`No such pending tool approval`;
	}
}
export class ToolApprovalConflict
	extends Data.TaggedError("ToolApprovalConflict")
	implements UserFacing
{
	get userMessage() {
		return userText`That tool approval has already been decided`;
	}
}
export class ToolApprovalForbidden
	extends Data.TaggedError("ToolApprovalForbidden")
	implements UserFacing
{
	get userMessage() {
		return userText`You are not allowed to make that decision`;
	}
}
