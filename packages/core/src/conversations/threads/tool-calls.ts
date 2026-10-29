import type { FormAnswer, FormRequest, ToolCallForm, ToolCallPart } from "@sugabots/contracts";
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import {
	type ToolCallRow,
	toolCall,
	toolCallForm,
	toolCallFormResponse,
	user,
} from "../../database/schema.ts";
import { decidersOf } from "../tools/approval-deciders.ts";

/**
 * Reading tool calls back into the messages they belong to.
 *
 * A message stores a tool call by id only (`StoredMessagePart`); what the tool
 * was given and what it returned live on the `tool_call` row, and a form an
 * agent asked people to fill in on `tool_call_form`. These functions put the
 * rows back into the part the API hands out. Writing tool calls is
 * `turns/tool-calls/repository.ts`.
 */

/** A form as it is stored, with the answer it was given, if any. */
export interface StoredForm {
	request: FormRequest;
	response: {
		answer: FormAnswer;
		createdAt: Date;
		responder: { name: string } | null;
	} | null;
}

const responder = alias(user, "form_responder");

/** The columns a form and its answer are read from, joined onto `tool_call_form`. */
const formColumns = {
	formRequest: toolCallForm.request,
	formAnswer: toolCallFormResponse.answer,
	answeredAt: toolCallFormResponse.createdAt,
	answeredByName: responder.name,
};

type FormColumns = {
	formRequest: FormRequest | null;
	formAnswer: FormAnswer | null;
	answeredAt: Date | null;
	answeredByName: string | null;
};

function storedFormOf(row: FormColumns): StoredForm | null {
	if (!row.formRequest) return null;
	return {
		request: row.formRequest,
		response:
			row.formAnswer && row.answeredAt
				? {
						answer: row.formAnswer,
						createdAt: row.answeredAt,
						responder: row.answeredByName === null ? null : { name: row.answeredByName },
					}
				: null,
	};
}

/** The form a call asked people to fill in, with its answer; null for a call that asked none. */
export const loadStoredForm = Effect.fn("ToolCalls.loadStoredForm")(function* (
	db: Executor,
	toolCallId: string,
) {
	const [row] = yield* db
		.select(formColumns)
		.from(toolCallForm)
		.leftJoin(toolCallFormResponse, eq(toolCallFormResponse.toolCallId, toolCallForm.toolCallId))
		.leftJoin(responder, eq(responder.id, toolCallFormResponse.responderId))
		.where(eq(toolCallForm.toolCallId, toolCallId))
		.limit(1);
	return row ? storedFormOf(row) : null;
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
		.select({ call: toolCall, decidedByName: user.name, ...formColumns })
		.from(toolCall)
		.leftJoin(user, eq(user.id, toolCall.decidedById))
		.leftJoin(toolCallForm, eq(toolCallForm.toolCallId, toolCall.id))
		.leftJoin(toolCallFormResponse, eq(toolCallFormResponse.toolCallId, toolCall.id))
		.leftJoin(responder, eq(responder.id, toolCallFormResponse.responderId))
		.where(inArray(toolCall.messageId, [...messageIds]))
		.orderBy(toolCall.startedAt, toolCall.id);
	for (const row of rows) {
		const parts = byMessage.get(row.call.messageId) ?? [];
		parts.push(toToolCallPart(row.call, row.decidedByName, storedFormOf(row)));
		byMessage.set(row.call.messageId, parts);
	}
	return byMessage;
});

export function toToolCallPart(
	row: ToolCallRow,
	decidedByName: string | null = null,
	form: StoredForm | null = null,
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
		form: form ? toToolCallForm(form) : null,
		error: row.error,
		mutating: row.mutating,
		atOffset: row.atOffset,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

function toToolCallForm(form: StoredForm): ToolCallForm {
	return {
		request: form.request,
		// Read from `json`, which keeps the keys in the order they were written.
		fieldOrder: Object.keys(form.request.requestedSchema.properties),
		response: form.response
			? {
					answer: form.response.answer,
					answeredByName: form.response.responder?.name ?? null,
					answeredAt: form.response.createdAt.toISOString(),
				}
			: null,
	};
}
