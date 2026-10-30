import type { FormAnswer, ToolCallForm, ToolCallPart } from "@sugabots/contracts";
import { eq, inArray } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { Executor } from "../../database/database.ts";
import { type ToolCallRow, toolCall, toolCallFormAnswer, user } from "../../database/schema.ts";
import { decidersOf } from "../tools/approval-deciders.ts";
import { ASK_FORM_TOOL, readStoredFormInput } from "../tools/ask-form/tool.ts";

/**
 * Reading tool calls back into the messages they belong to.
 *
 * A message stores a tool call by id only (`StoredMessagePart`); what the tool
 * was given and what it returned live on the `tool_call` row, and the answer
 * to a form an agent asked people to fill in on `tool_call_form_answer`. These
 * functions put the rows back into the part the API hands out. Writing tool
 * calls is `turns/tool-calls/repository.ts`.
 */

/** The answer a form call was given; null until someone answers, and for any other call. */
export const loadFormAnswer = Effect.fn("ToolCalls.loadFormAnswer")(function* (
	db: Executor,
	toolCallId: string,
) {
	const [row] = yield* db
		.select({ answer: toolCallFormAnswer.answer })
		.from(toolCallFormAnswer)
		.where(eq(toolCallFormAnswer.toolCallId, toolCallId))
		.limit(1);
	return row?.answer ?? null;
});

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
		.select({ call: toolCall, decidedByName: user.name, formAnswer: toolCallFormAnswer.answer })
		.from(toolCall)
		.leftJoin(user, eq(user.id, toolCall.decidedById))
		.leftJoin(toolCallFormAnswer, eq(toolCallFormAnswer.toolCallId, toolCall.id))
		.where(inArray(toolCall.messageId, [...messageIds]))
		.orderBy(toolCall.startedAt, toolCall.id);
	for (const { call, decidedByName, formAnswer } of rows) {
		const parts = byMessage.get(call.messageId) ?? [];
		parts.push(toToolCallPart(call, decidedByName, formAnswer));
		byMessage.set(call.messageId, parts);
	}
	return byMessage;
});

export function toToolCallPart(
	row: ToolCallRow,
	decidedByName: string | null = null,
	formAnswer: FormAnswer | null = null,
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
					deciders: decidersOf(row.tool),
					decidedByName,
					decidedAt: row.decidedAt?.toISOString() ?? null,
				}
			: null,
		form: formOf(row, decidedByName, formAnswer),
		error: row.error,
		mutating: row.mutating,
		atOffset: row.atOffset,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

/**
 * The form a call put to people, with its answer, which whoever decided the
 * call gave; null for a call that put none, such as one never shown.
 */
function formOf(
	row: ToolCallRow,
	decidedByName: string | null,
	answer: FormAnswer | null,
): ToolCallForm | null {
	if (row.tool !== ASK_FORM_TOOL) return null;
	const stored = Option.getOrUndefined(readStoredFormInput(row.executionInput));
	if (!stored) return null;
	return {
		request: stored.input,
		fieldOrder: stored.fieldOrder,
		response:
			answer && row.decidedAt
				? { answer, answeredByName: decidedByName, answeredAt: row.decidedAt.toISOString() }
				: null,
	};
}
