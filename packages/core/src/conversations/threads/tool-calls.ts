import type { ToolCallPart } from "@sugabots/contracts";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { type ToolCallRow, toolCall, user } from "../../database/schema.ts";

/**
 * Reading tool calls back into the messages they belong to.
 *
 * A message stores a tool call by id only (`StoredMessagePart`); what the tool
 * was given and what it returned live on the `tool_call` row. These two
 * functions put the row back into the part the API hands out. Writing tool
 * calls is `turns/tool-calls/repository.ts`.
 */

/** The tool calls made in each of these messages, keyed by message id. */
export const loadToolCallParts = Effect.fn("ToolCalls.loadToolCallParts")(function* (
	db: Executor,
	messageIds: readonly string[],
) {
	const byMessage = new Map<string, ToolCallPart[]>();
	if (messageIds.length === 0) {
		return byMessage;
	}
	const rows = yield* db
		.select({ call: toolCall, decidedByName: user.name })
		.from(toolCall)
		.leftJoin(user, eq(user.id, toolCall.decidedById))
		.where(inArray(toolCall.messageId, [...messageIds]))
		.orderBy(toolCall.startedAt, toolCall.id);
	for (const { call, decidedByName } of rows) {
		const parts = byMessage.get(call.messageId) ?? [];
		parts.push(toToolCallPart(call, decidedByName));
		byMessage.set(call.messageId, parts);
	}
	return byMessage;
});

export function toToolCallPart(
	row: ToolCallRow,
	decidedByName: string | null = null,
): ToolCallPart {
	return {
		type: "tool_call",
		id: row.id,
		tool: row.tool,
		input: row.input,
		output: row.output ?? null,
		status: row.status,
		approval: row.approvalStatus
			? {
					status: row.approvalStatus,
					decidedByName,
					decidedAt: row.decidedAt?.toISOString() ?? null,
				}
			: null,
		error: row.error,
		mutating: row.mutating,
		atOffset: row.atOffset,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}
