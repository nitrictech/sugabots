import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	chatHistoryPageSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
	customerThreadTypeSchema,
	MAX_CHAT_PAGE_LIMIT,
} from "./chats.ts";

const ID = "0199a3a0-0000-7000-8000-000000000001";

describe("chat contracts", () => {
	it("bounds pages", () => {
		expect(Schema.decodeSync(chatPageQuerySchema)({})).toEqual({ limit: 50 });
		expect(
			Schema.decodeResult(chatPageQuerySchema)({
				limit: String(MAX_CHAT_PAGE_LIMIT + 1),
			})._tag,
		).toBe("Failure");
	});

	it.each(["chat", "system_agent"])("keeps %s threads out of customer-facing history", (type) => {
		const internalEntry = {
			threadId: ID,
			parentThreadId: null,
			type,
			title: "Summary",
			participants: [],
			status: "completed",
			latestActivityAt: "2026-09-18T00:00:00.000Z",
		};
		expect(
			Schema.decodeUnknownResult(chatHistoryPageSchema)({
				items: [internalEntry],
				nextCursor: null,
			})._tag,
		).toBe("Failure");
	});

	it.each(["collaboration", "routine"])("accepts customer thread type %s", (type) => {
		expect(Schema.decodeUnknownSync(customerThreadTypeSchema)(type)).toBe(type);
	});

	it("accepts a Routine run in the Chat timeline", () => {
		expect(
			Schema.decodeSync(chatMessagesPageSchema)({
				items: [
					{
						kind: "routine",
						id: ID,
						threadId: "0199a3a0-0000-7000-8000-000000000002",
						routineName: "Overnight review",
						triggerKind: "webhook",
						state: "completed",
						error: null,
						createdAt: "2026-09-18T00:00:00.000Z",
					},
				],
				nextCursor: null,
			}).items[0]?.kind,
		).toBe("routine");
	});
});
