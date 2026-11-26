import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { chatMessagesPageSchema, chatPageQuerySchema, MAX_CHAT_PAGE_LIMIT } from "./chats.ts";

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

	it("accepts an automation run in the Chat timeline", () => {
		expect(
			Schema.decodeSync(chatMessagesPageSchema)({
				items: [
					{
						kind: "run",
						id: ID,
						chatId: "0199a3a0-0000-7000-8000-000000000002",
						automationName: "Overnight review",
						triggerKind: "webhook",
						state: "completed",
						error: null,
						reply: null,
						createdAt: "2026-09-18T00:00:00.000Z",
					},
				],
				nextCursor: null,
			}).items[0]?.kind,
		).toBe("run");
	});
});
