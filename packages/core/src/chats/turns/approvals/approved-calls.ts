export * as ApprovedToolCalls from "./approved-calls.ts";

import type { ToolCallPart } from "@sugabots/contracts";
import { userText } from "@sugabots/errors";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import { toolCall } from "../../../database/schema.ts";
import type { UserFacing } from "../../../user-message.ts";
import { toToolCallPart } from "../../store/tool-calls.ts";
import { DENIED_OUTPUT } from "../tool-calls/lifecycle.ts";
import { ToolCallStore } from "../tool-calls/store.ts";

/**
 * A turn reading what members decided on the calls it parked for approval, and
 * running the ones they allowed. The turn runs for its workflow, not for a
 * member, so this asks for no actor and is never handed to a route; the
 * members deciding go through `Turns.Controls`.
 */
export interface Interface {
	/**
	 * What members decided on the approvals a suspended turn asked for, as the
	 * model reads it when the turn continues. Fails while any is undecided.
	 */
	readonly responsesForTurn: (
		turnId: string,
		approvalIds: readonly string[],
	) => Effect.Effect<ToolModelMessage, ToolApprovalsIncomplete>;
	/** Starts an allowed call (see `ToolCallStore.beginExecution`). */
	readonly beginExecution: (input: {
		chatId: string;
		messageId: string;
		turnId: string;
		sdkToolCallId: string;
		tool: string;
		input: unknown;
		binding: ToolCallStore.ApprovalBinding;
	}) => Effect.Effect<ToolCallPart, ToolExecutionRefused>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ApprovedToolCalls",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ApprovedToolCalls");
	const toolCalls = yield* ToolCallStore.Service;
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
											? "A member approved this action"
											: DENIED_OUTPUT.reason,
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
						return toToolCallPart(began.call);
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(ToolCallStore.layer));

/** A resumed turn found its approvals not all decided, so it cannot continue. */
export class ToolApprovalsIncomplete
	extends Data.TaggedError("ToolApprovalsIncomplete")<{ readonly message: string }>
	implements UserFacing
{
	get userMessage() {
		return userText`The reply could not continue: its tool approvals were not all decided.`;
	}
}
/** An approved tool call may no longer run, so it was not started. */
export class ToolExecutionRefused extends Data.TaggedError("ToolExecutionRefused")<{
	readonly message: string;
}> {}
