export * as ApprovedToolCalls from "./approved-calls.ts";

import type { ToolCallPart } from "@sugabots/contracts";
import type { ToolApprovalResponse, ToolModelMessage } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { query, serviceOperations, transaction } from "../../../database/database.ts";
import { toolCall } from "../../../database/schema.ts";
import { type UserFacing, UserMessage } from "../../../user-message.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";
import { TurnRepository } from "../../turns/repository.ts";
import { ToolCallRepository } from "../calls/repository.ts";

/**
 * A turn reading what people decided on the calls it parked for approval, and
 * running the ones they allowed. The turn runs for its workflow, not for a
 * person, so this asks for no actor and is never handed to a route; the
 * people deciding are `ToolApprovals`.
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
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ApprovedToolCalls",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ApprovedToolCalls");
	const toolCalls = yield* ToolCallRepository.Service;
	const turns = yield* TurnRepository.Service;
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
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([ToolCallRepository.layer, TurnRepository.layer]),
);

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
