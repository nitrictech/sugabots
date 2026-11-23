import { loadEmojiDataset } from "@sugabots/emoji";
import { Result, Schema, SchemaIssue } from "effect";
import { describe, expect, it } from "vitest";
import {
	conversationHistoryQuerySchema,
	DEFAULT_CONVERSATION_HISTORY_LIMIT,
	jsonValueSchema,
	MAX_CONVERSATION_HISTORY_LIMIT,
	MAX_CONVERSATION_TITLE_CHARACTERS,
	MESSAGE_PREVIEW_CHARACTERS,
	mentionPattern,
	mentionsEveryone,
	mentionsOnlyPeople,
	messagePartsFor,
	messagePreview,
	messageSchema,
	newMessageSchema,
	participantSchema,
	placedConversationSchema,
	reactionEmojiSchema,
	textWithoutNarration,
} from "./conversations.ts";
import { testPerson } from "./testing.ts";

const ID = "0199a3a0-0000-7000-8000-000000000001";

/** A project's thread, placed, as it decodes. */
const placedThread = {
	id: ID,
	workspaceId: ID,
	projectId: ID,
	botId: ID,
	rootConversationId: ID,
	kind: "project_thread",
	title: "Release notes",
	status: "done",
	parentConversationId: null,
	doneAt: null,
	createdAt: "2026-09-11T00:00:00.000Z",
	updatedAt: "2026-09-11T00:00:00.000Z",
};

describe("conversation contracts", () => {
	it("requires a client message id for optimistic reconciliation", () => {
		expect(Schema.decodeUnknownResult(newMessageSchema)({ message: "Follow up" })._tag).toBe(
			"Failure",
		);
	});

	it("bounds conversation history pages", () => {
		const decode = Schema.decodeUnknownSync(conversationHistoryQuerySchema);
		expect(decode({ limit: String(MAX_CONVERSATION_HISTORY_LIMIT) })).toEqual({
			limit: MAX_CONVERSATION_HISTORY_LIMIT,
		});
		expect(
			Schema.decodeResult(conversationHistoryQuerySchema)({
				limit: String(MAX_CONVERSATION_HISTORY_LIMIT + 1),
			})._tag,
		).toBe("Failure");
	});

	it("bounds generated conversation titles", () => {
		const decode = Schema.decodeUnknownResult(placedConversationSchema);
		expect(decode(placedThread)._tag).toBe("Success");
		expect(decode({ ...placedThread, title: "" })._tag).toBe("Failure");
		expect(
			decode({ ...placedThread, title: "x".repeat(MAX_CONVERSATION_TITLE_CHARACTERS + 1) })._tag,
		).toBe("Failure");
	});

	it("keeps person and bot participants distinct", () => {
		expect(
			Schema.decodeSync(participantSchema)({
				kind: "person",
				id: ID,
				name: "Sam",
				email: "sam@example.com",
				handle: "sam",
				image: null,
			}),
		).toMatchObject({ kind: "person", name: "Sam" });
		expect(
			Schema.decodeUnknownResult(participantSchema)({
				kind: "bot",
				id: ID,
				name: "Linear Handler",
				image: null,
			})._tag,
		).toBe("Failure");
	});

	it("requires semantic ISO timestamps", () => {
		const decode = Schema.decodeUnknownResult(placedConversationSchema);
		expect(decode(placedThread)._tag).toBe("Success");
		expect(decode({ ...placedThread, createdAt: "2026-02-30T00:00:00.000Z" })._tag).toBe("Failure");
	});

	it("requires message content to exactly match its text parts", () => {
		const message = {
			id: ID,
			conversationId: ID,
			author: testPerson({ id: ID, name: "Sam" }),
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
			botId: ID,
			botName: "Helper",
			conversationId: ID,
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
			expect(Schema.decodeUnknownResult(conversationHistoryQuerySchema)({ limit })._tag).toBe(
				"Failure",
			);
		},
	);

	it("defaults undefined limits and accepts leading zeroes without coercing cursors", () => {
		const decode = Schema.decodeUnknownSync(conversationHistoryQuerySchema);
		expect(decode({ limit: undefined })).toEqual({ limit: DEFAULT_CONVERSATION_HISTORY_LIMIT });
		expect(decode({ limit: "001", cursor: "next" })).toEqual({ limit: 1, cursor: "next" });
		for (const cursor of ["", "x".repeat(201), 1, null]) {
			expect(Schema.decodeUnknownResult(conversationHistoryQuerySchema)({ cursor })._tag).toBe(
				"Failure",
			);
		}
	});

	it("trims message content before validating", () => {
		expect(Schema.decodeSync(newMessageSchema)({ id: ID, message: " hi " }).message).toBe("hi");
	});

	it("validates nested JSON", () => {
		const nested = { values: [1, true, null, { text: "kept" }] };
		expect(Schema.decodeSync(jsonValueSchema)([nested])).toEqual([nested]);
		expect(Schema.decodeSync(jsonValueSchema)({ nested })).toEqual({ nested });
	});

	it.each([undefined, { nested: [NaN] }, new Date(0)])("rejects non-JSON values: %s", (value) => {
		expect(Schema.decodeResult(jsonValueSchema)(value)._tag).toBe("Failure");
	});
});

describe("mentionsEveryone", () => {
	it.each(["@here", "@channel, standup is on", "Heads up @Here: the build is red", "(@channel)"])(
		"reads %j as addressing everyone",
		(content) => {
			expect(mentionsEveryone(content)).toBe(true);
		},
	);

	it.each(["sam@here.com", "@heresy", "@here-ish", "@channels", "@sam", "here and channel"])(
		"does not read %j as addressing everyone",
		(content) => {
			expect(mentionsEveryone(content)).toBe(false);
		},
	);
});

describe("mentionsOnlyPeople", () => {
	const known = { botHandles: new Set(["reviewer"]), peopleHandles: new Set(["sam"]) };

	it.each([[["sam"]], [["here"]], [["sam", "backlog"]]])(
		"reads %j as addressing only people",
		(handles) => {
			expect(mentionsOnlyPeople(handles, known)).toBe(true);
		},
	);

	it.each([[[]], [["backlog"]], [["reviewer"]], [["sam", "reviewer"]], [["channel", "reviewer"]]])(
		"does not read %j as addressing only people",
		(handles) => {
			expect(mentionsOnlyPeople(handles, known)).toBe(false);
		},
	);
});

describe("mentionPattern", () => {
	it("matches a mention of any handle it is given, as mentionedHandles reads one", () => {
		const pattern = new RegExp(mentionPattern("sam", "here"), "i");
		expect(pattern.test("ping @Sam and others")).toBe(true);
		expect(pattern.test("@here")).toBe(true);
		expect(pattern.test("@samantha")).toBe(false);
		expect(pattern.test("sam@here.com")).toBe(false);
	});
});

describe("textWithoutNarration", () => {
	it("leaves out the words that come straight before a tool call", () => {
		expect(
			textWithoutNarration([
				{ type: "text", text: "Let me check:" },
				{ type: "tool_call", toolCallId: ID },
				{ type: "text", text: "It is paid." },
			]),
		).toBe("It is paid.");
	});

	it("keeps words before a collaboration, which the conversation shows", () => {
		expect(
			textWithoutNarration([
				{ type: "text", text: "Asking Finance. " },
				{ type: "collaboration", collaborationId: ID },
				{ type: "text", text: "They say it is paid." },
			]),
		).toBe("Asking Finance. They say it is paid.");
	});
});

describe("messagePreview", () => {
	it("takes the first line with words in it, with its spaces closed up", () => {
		expect(messagePreview("\n  Budget   review is Friday\nand bring the numbers")).toBe(
			"Budget review is Friday",
		);
	});

	it("cuts a long line at a word, within the limit", () => {
		const preview = messagePreview(`Here is the summary. ${"word ".repeat(60)}`);

		expect(preview.length).toBeLessThanOrEqual(MESSAGE_PREVIEW_CHARACTERS);
		expect(preview).toMatch(/ word…$/);
	});

	it("reads Markdown as the text it renders", () => {
		expect(messagePreview("[**SUGA-1974**](https://example.com) is _done_")).toBe(
			"SUGA-1974 is done",
		);
	});

	it("skips lines that render no text", () => {
		expect(messagePreview("---\n## Weekly `report`")).toBe("Weekly report");
	});
});

describe("reactionEmojiSchema", () => {
	const decode = Schema.decodeUnknownSync(reactionEmojiSchema);

	it("reads an emoji with a variation selector it has no need of as the emoji alone", () => {
		expect(decode("\u{1F44D}\uFE0F")).toBe("👍");
	});

	it("keeps the variation selectors an emoji needs", () => {
		for (const emoji of ["❤️", "☺️", "1️⃣", "❤️‍🔥", "🏳️‍🌈", "👍🏽", "🇳🇿", "🇦"]) {
			expect(decode(emoji)).toBe(emoji);
		}
	});

	it("refuses anything but one emoji", () => {
		for (const text of ["", "ok", "👍👍", "👍 ", "🇦🇧🇨"]) {
			expect(() => decode(text)).toThrow();
		}
	});

	it("takes every emoji the app offers, in every skin tone", async () => {
		const { emojis } = await loadEmojiDataset();
		const offered = emojis.flatMap(({ emoji, skins, aliases }) => [
			emoji,
			...Object.values(skins ?? {}),
			...(aliases ?? []),
		]);
		const refused = offered.filter((emoji) =>
			Result.isFailure(Schema.decodeUnknownResult(reactionEmojiSchema)(emoji)),
		);
		expect(refused).toEqual([]);
	});
});
