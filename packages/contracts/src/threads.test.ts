import { Result, Schema, SchemaIssue } from "effect";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_THREAD_HISTORY_LIMIT,
	jsonValueSchema,
	MAX_THREAD_HISTORY_LIMIT,
	MAX_THREAD_TITLE_CHARACTERS,
	messagePartsFor,
	messageSchema,
	newMessageSchema,
	threadHistoryQuerySchema,
	threadParticipantSchema,
	threadSchema,
	threadSummarySchema,
	threadTypeSchema,
} from "./threads.ts";

const ID = "0199a3a0-0000-7000-8000-000000000001";

describe("thread contracts", () => {
	it.each(["chat", "collaboration", "routine", "system_agent"])(
		"accepts supported internal thread type %s",
		(type) => {
			expect(Schema.decodeUnknownSync(threadTypeSchema)(type)).toBe(type);
		},
	);

	it("requires a client message id for optimistic reconciliation", () => {
		expect(Schema.decodeUnknownResult(newMessageSchema)({ message: "Follow up" })._tag).toBe(
			"Failure",
		);
	});

	it("bounds thread history pages", () => {
		const decode = Schema.decodeUnknownSync(threadHistoryQuerySchema);
		expect(decode({ limit: String(MAX_THREAD_HISTORY_LIMIT) })).toEqual({
			limit: MAX_THREAD_HISTORY_LIMIT,
		});
		expect(
			Schema.decodeUnknownResult(threadHistoryQuerySchema)({
				limit: String(MAX_THREAD_HISTORY_LIMIT + 1),
			})._tag,
		).toBe("Failure");
	});

	it("bounds generated thread titles", () => {
		const thread = {
			id: ID,
			workspaceId: ID,
			podId: ID,
			hostAgentId: ID,
			title: "Release notes",
			status: "done",
			parentThreadId: null,
			initiatorUserId: ID,
			createdAt: "2026-09-11T00:00:00.000Z",
			updatedAt: "2026-09-11T00:00:00.000Z",
		};
		expect(Schema.decodeUnknownResult(threadSchema)({ ...thread, title: "" })._tag).toBe("Failure");
		expect(
			Schema.decodeUnknownResult(threadSchema)({
				...thread,
				title: "x".repeat(MAX_THREAD_TITLE_CHARACTERS + 1),
			})._tag,
		).toBe("Failure");
	});

	it("keeps person and agent participants distinct", () => {
		expect(
			Schema.decodeUnknownSync(threadParticipantSchema)({
				kind: "person",
				id: ID,
				name: "Sam",
				handle: "sam",
				image: null,
			}),
		).toMatchObject({ kind: "person", name: "Sam" });
		expect(
			Schema.decodeUnknownResult(threadParticipantSchema)({
				kind: "agent",
				id: ID,
				name: "Linear Handler",
				image: null,
			})._tag,
		).toBe("Failure");
	});

	it("requires semantic ISO timestamps", () => {
		const thread = {
			id: ID,
			workspaceId: ID,
			podId: ID,
			hostAgentId: ID,
			title: "Release notes",
			status: "running",
			parentThreadId: null,
			initiatorUserId: ID,
			createdAt: "2026-02-30T00:00:00.000Z",
			updatedAt: "2026-09-11T00:00:00.000Z",
		};

		expect(Schema.decodeUnknownResult(threadSchema)(thread)._tag).toBe("Failure");
	});

	it("requires message content to exactly match its text parts", () => {
		const message = {
			id: ID,
			threadId: ID,
			author: { kind: "person", id: ID, name: "Sam", handle: "sam", image: null },
			kind: "text",
			status: "complete",
			parts: [
				{ type: "text", text: "Release " },
				{ type: "text", text: "ready" },
			],
			content: "Release ready",
			createdAt: "2026-09-11T00:00:00.000Z",
		};

		expect(Schema.decodeUnknownResult(messageSchema)(message)._tag).toBe("Success");
		const result = Schema.decodeUnknownResult(messageSchema)({
			...message,
			content: "Release pending",
		});
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue)).toEqual({
				issues: [{ path: ["content"], message: "Content must equal the combined text parts" }],
			});
		}
	});

	it("places collaborations and tool calls in the text at their offsets", () => {
		const toolCall = {
			type: "tool_call" as const,
			id: ID,
			tool: "web_fetch",
			input: { url: "https://example.com" },
			output: { title: "Example" },
			status: "completed" as const,
			error: null,
			mutating: false,
			atOffset: 8,
			startedAt: "2026-09-14T00:00:00.000Z",
			finishedAt: "2026-09-14T00:00:01.000Z",
		};
		const collaboration = {
			type: "collaboration" as const,
			id: "0199a3a0-0000-7000-8000-000000000002",
			agentId: ID,
			agentName: "Helper",
			threadId: ID,
			brief: "Look",
			status: "answered" as const,
			answer: "Seen",
			atOffset: 8,
		};

		const parts = messagePartsFor("Looking. Found it.", [toolCall, collaboration]);

		expect(parts).toEqual([
			{ type: "text", text: "Looking." },
			toolCall,
			collaboration,
			{ type: "text", text: " Found it." },
		]);
	});

	it.each(["", " 1", "1 ", "+1", "-1", "1e1", "0x10", "NaN", "Infinity", "9".repeat(400), 1, null])(
		"rejects a non-digit or out-of-range history limit: %s",
		(limit) => {
			expect(Schema.decodeUnknownResult(threadHistoryQuerySchema)({ limit })._tag).toBe("Failure");
		},
	);

	it("defaults undefined limits and accepts leading zeroes without coercing cursors", () => {
		const decode = Schema.decodeUnknownSync(threadHistoryQuerySchema);
		expect(decode({ limit: undefined })).toEqual({ limit: DEFAULT_THREAD_HISTORY_LIMIT });
		expect(decode({ limit: "001", cursor: "next" })).toEqual({ limit: 1, cursor: "next" });
		for (const cursor of ["", "x".repeat(201), 1, null]) {
			expect(Schema.decodeUnknownResult(threadHistoryQuerySchema)({ cursor })._tag).toBe("Failure");
		}
	});

	it("trims message and summary content before validating", () => {
		expect(Schema.decodeUnknownSync(newMessageSchema)({ id: ID, message: " hi " }).message).toBe(
			"hi",
		);
		expect(
			Schema.decodeUnknownSync(threadSummarySchema)({
				content: " ready ",
				sourceMessageId: ID,
				updatedAt: "2026-09-11T00:00:00Z",
			}).content,
		).toBe("ready");
	});

	it("validates nested JSON", () => {
		const nested = { values: [1, true, null, { text: "kept" }] };
		expect(Schema.decodeUnknownSync(jsonValueSchema)([nested])).toEqual([nested]);
		expect(Schema.decodeUnknownSync(jsonValueSchema)({ nested })).toEqual({ nested });
	});

	it.each([undefined, { nested: [NaN] }, new Date(0)])("rejects non-JSON values: %s", (value) => {
		expect(Schema.decodeUnknownResult(jsonValueSchema)(value)._tag).toBe("Failure");
	});
});
