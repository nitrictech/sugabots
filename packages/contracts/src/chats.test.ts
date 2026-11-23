import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	chatHistoryPageSchema,
	chatMessagesPageSchema,
	chatPageQuerySchema,
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

	const historyEntry = {
		chatId: ID,
		parentChatId: null,
		kind: "collaboration",
		title: "Summary",
		participants: [],
		status: "completed",
		automationRun: null,
		latestActivityAt: "2026-09-18T00:00:00.000Z",
	};
	const decodeHistory = (entry: object) =>
		Schema.decodeUnknownResult(chatHistoryPageSchema)({ items: [entry], nextCursor: null })._tag;

	it("accepts a collaboration in the history", () => {
		expect(decodeHistory(historyEntry)).toBe("Success");
	});

	it.each(["project_chat", "system_chat"])("keeps %s chats out of the history", (kind) => {
		expect(decodeHistory({ ...historyEntry, kind })).toBe("Failure");
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
						report: null,
						createdAt: "2026-09-18T00:00:00.000Z",
					},
				],
				nextCursor: null,
			}).items[0]?.kind,
		).toBe("run");
	});
});
