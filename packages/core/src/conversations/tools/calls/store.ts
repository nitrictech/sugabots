import type { JsonValue, ToolCallPart } from "@sugabots/contracts";
import { streamEvent, threadChannel } from "@sugabots/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../../database/database.ts";
import type { PendingEvent, PublishEvents } from "../../../database/events/publish.ts";
import { type ToolCallRow, toolCall } from "../../../database/schema.ts";
import type { UserMessage } from "../../../user-message.ts";
import { toToolCallPart } from "../../threads/tool-calls.ts";

/**
 * Tool calls: what an agent's reply asked a built-in tool, and what it got.
 *
 * A call is opened when the tool starts and closed when it returns, each in
 * its own transaction, so a reader watching the thread sees the call appear
 * and then resolve. The reply keeps a reference to the call among its parts at
 * the point it was made; the input and output live here. Writing them here
 * rather than into the reply's parts means the tool never writes the row the
 * streaming reply is being saved to.
 */

/** Stored inputs and outputs are cut at this many characters of JSON (ADR 002). */
export const MAX_STORED_JSON_CHARACTERS = 64_000;

export type ToolCallOutcome = { output: unknown } | { error: UserMessage };

export interface ToolCallStore {
	/** Records that the tool has been called, and tells the thread. */
	open(input: {
		threadId: string;
		messageId: string;
		turnId: string;
		tool: string;
		input: unknown;
		/** How far into the reply's text the call was made. */
		atOffset: number;
		/** Whether the tool may change something at the other end. Off when left out. */
		mutating?: boolean;
	}): Effect.Effect<ToolCallPart, never, Database>;
	/** Records what the tool returned or how it failed. Nothing if the call is gone. */
	close(
		toolCallId: string,
		outcome: ToolCallOutcome,
	): Effect.Effect<ToolCallPart | undefined, never, Database>;
}

export function toolCallStore(publishEvents: PublishEvents): ToolCallStore {
	return {
		open: (input) =>
			transaction(
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.insert(toolCall)
							.values({
								threadId: input.threadId,
								messageId: input.messageId,
								turnId: input.turnId,
								tool: input.tool,
								input: boundedJson(input.input),
								atOffset: input.atOffset,
								mutating: input.mutating ?? false,
								startedAt: new Date(),
							})
							.returning(),
					);
					if (!row) {
						return yield* Effect.die(new Error("Tool call insert returned no row"));
					}
					yield* publishEvents([toolCallEvent("tool_call.started", row)]);
					return toToolCallPart(row);
				}),
			),

		close: (toolCallId, outcome) =>
			transaction(
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db
							.update(toolCall)
							.set({ ...finished(outcome), finishedAt: new Date() })
							.where(and(eq(toolCall.id, toolCallId), eq(toolCall.status, "running")))
							.returning(),
					);
					if (!row) {
						return undefined;
					}
					yield* publishEvents([toolCallEvent("tool_call.completed", row)]);
					return toToolCallPart(row);
				}),
			),
	};
}

/**
 * Marks the turn's still-running calls failed with `error`, for a turn that
 * ended before its tools returned. Returns the events that announce it, for
 * the caller's own transaction to publish.
 */
export const abandonRunningToolCalls = Effect.fn("ToolCallStore.abandonRunningToolCalls")(
	function* (db: Executor, turnId: string, error: UserMessage) {
		const rows = yield* db
			.update(toolCall)
			.set({
				status: "failed",
				approvalStatus: sql`case when ${toolCall.approvalStatus} = 'pending' then 'denied' else ${toolCall.approvalStatus} end`,
				error,
				finishedAt: new Date(),
			})
			.where(
				and(
					eq(toolCall.turnId, turnId),
					inArray(toolCall.status, ["running", "awaiting_approval"]),
				),
			)
			.returning();
		return rows.map((row): PendingEvent => toolCallEvent("tool_call.completed", row));
	},
);

/** Forgets a reply's tool calls, for a retry that starts the reply again. */
export const deleteToolCallsOf = Effect.fn("ToolCallStore.deleteToolCallsOf")(function* (
	db: Executor,
	messageId: string,
) {
	yield* db.delete(toolCall).where(eq(toolCall.messageId, messageId));
});

function finished(outcome: ToolCallOutcome): Pick<ToolCallRow, "status" | "output" | "error"> {
	return "error" in outcome
		? { status: "failed", output: null, error: outcome.error }
		: { status: "completed", output: boundedJson(outcome.output), error: null };
}

function toolCallEvent(
	type: "tool_call.started" | "tool_call.completed",
	row: ToolCallRow,
): PendingEvent {
	return {
		channel: threadChannel(row.threadId),
		event: streamEvent(type, {
			threadId: row.threadId,
			messageId: row.messageId,
			toolCall: toToolCallPart(row),
		}),
	};
}

/**
 * The value as JSON will keep it, cut down when it is too large to store. The
 * round trip through text is what drops `undefined` and anything else JSON
 * cannot carry; the cut keeps the start, which is where a page's title and a
 * result list's first entries are.
 */
export function boundedJson(value: unknown): JsonValue {
	const text = JSON.stringify(value ?? null) ?? "null";
	if (text.length <= MAX_STORED_JSON_CHARACTERS) {
		return JSON.parse(text);
	}
	return {
		truncated: true,
		characters: text.length,
		preview: text.slice(0, MAX_STORED_JSON_CHARACTERS),
	};
}
