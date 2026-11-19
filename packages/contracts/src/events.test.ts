import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	conversationUpdateEventSchema,
	durableEventTypeSchema,
	EVENT_VERSION,
	ephemeralEventTypeSchema,
	eventPayloadSchemas,
	isDurableEventType,
	streamEvent,
	streamEventSchema,
	workspaceUpdateEventSchema,
} from "./events.ts";
import { testPerson } from "./testing.ts";

describe("durability", () => {
	it("persists state changes and not progress", () => {
		expect(isDurableEventType("message.created")).toBe(true);
		expect(isDurableEventType("message.delta")).toBe(false);
	});

	it("declares no type both durable and ephemeral", () => {
		const durable = durableEventTypeSchema.literals;
		const ephemeral = ephemeralEventTypeSchema.literals;

		expect(ephemeral.some(isDurableEventType)).toBe(false);
		expect(new Set([...durable, ...ephemeral]).size).toBe(durable.length + ephemeral.length);
	});

	it("does not declare message-routed events", () => {
		expect(isDurableEventType("chat.message_routed")).toBe(false);
		expect("chat.message_routed" in eventPayloadSchemas).toBe(false);
	});

	it("treats a type it has never heard of as ephemeral", () => {
		// A client older than the server must not try to resume from an id it
		// was never given, so an unknown type is the conservative case.
		expect(isDurableEventType("something.new")).toBe(false);
	});
});

describe("envelope", () => {
	it("stamps the version and keeps the payload", () => {
		const event = streamEvent("conversation.created", { conversationId: "c1" });

		expect(event).toEqual({
			v: EVENT_VERSION,
			type: "conversation.created",
			conversationId: "c1",
		});
	});

	it("cannot have its version overwritten by a payload field", () => {
		expect(streamEvent("unknown.event", { v: 99 }).v).toBe(EVENT_VERSION);
	});

	it("parses an event carrying fields this version has never seen", () => {
		const parsed = Schema.decodeSync(streamEventSchema)({
			v: 1,
			type: "conversation.changed",
			surprise: true,
		});

		expect(parsed.surprise).toBe(true);
	});

	it("rejects an event from a version this client cannot read", () => {
		expect(
			Schema.decodeUnknownResult(streamEventSchema)({ v: 2, type: "conversation.changed" })._tag,
		).toBe("Failure");
	});

	it("rejects an event with no type", () => {
		expect(Schema.decodeResult(streamEventSchema)({ v: 1, type: "" })._tag).toBe("Failure");
	});

	it.each([
		"message.created",
		"message.delta",
		"message.completed",
		"message.failed",
		"tool_call.started",
		"tool_call.completed",
		"turn.started",
		"turn.completed",
		"conversation.changed",
		"conversation.notice",
		"collaboration.updated",
	])("recognizes the known conversation update %s", (type) => {
		const ids = {
			conversationId: "00000000-0000-4000-8000-000000000001",
			turnId: "00000000-0000-4000-8000-000000000002",
			botId: "00000000-0000-4000-8000-000000000003",
		};
		const payloads: Record<string, Record<string, unknown>> = {
			"message.created": { ...ids, message: message() },
			"message.delta": { ...ids, messageId: "m1", offset: 0, text: "hi" },
			"message.completed": {
				...ids,
				messageId: "m1",
				content: "hi",
				status: "complete",
			},
			"message.failed": {
				...ids,
				messageId: "m1",
				willRetry: false,
				error: "Provider returned 403",
			},
			"tool_call.started": { ...ids, messageId: "m1", toolCall: toolCall("running") },
			"tool_call.completed": { ...ids, messageId: "m1", toolCall: toolCall("completed") },
			"turn.completed": { ...ids, status: "done" },
			"conversation.notice": { ...ids, notice: "Ada has no model chosen, so it cannot reply." },
			"collaboration.updated": {
				...ids,
				messageId: "00000000-0000-4000-8000-000000000004",
				collaboration: {
					type: "collaboration",
					id: "00000000-0000-4000-8000-000000000006",
					botId: ids.botId,
					botName: "Helper",
					conversationId: "00000000-0000-4000-8000-000000000007",
					brief: "Look into it",
					status: "waiting",
					answer: null,
					atOffset: 0,
				},
			},
		};

		expect(
			Schema.decodeUnknownResult(conversationUpdateEventSchema)({
				v: EVENT_VERSION,
				type,
				...ids,
				...payloads[type],
			})._tag,
		).toBe("Success");
	});

	it("round-trips future event types and unknown payload fields through native decoders", () => {
		const event = { v: 1, type: "future.event", payload: { nested: [1, "two"] }, extra: true };
		const parsed = Schema.decodeUnknownSync(streamEventSchema)(event);
		expect(parsed).toEqual(event);
		expect(Schema.encodeSync(streamEventSchema)(parsed)).toEqual(event);
	});

	it("preserves extras while validating known project payloads", () => {
		const event = {
			v: 1,
			type: "message.delta",
			conversationId: "00000000-0000-4000-8000-000000000001",
			messageId: "m1",
			offset: 0,
			text: "hi",
			extra: { future: true },
		};
		const parsed = Schema.decodeUnknownSync(conversationUpdateEventSchema)(event);
		expect(parsed).toEqual(event);
		expect(Schema.encodeSync(conversationUpdateEventSchema)(parsed)).toEqual(event);
		expect(
			Schema.decodeUnknownResult(conversationUpdateEventSchema)({ ...event, offset: -1 })._tag,
		).toBe("Failure");
	});

	it("keeps open empty payloads and workspace envelopes", () => {
		const extras = { future: { value: 1 } };
		expect(Schema.decodeSync(eventPayloadSchemas["bot.updated"])(extras)).toEqual(extras);
		for (const payload of [
			{ type: "reset" },
			{ type: "conversation.changed", conversationId: "00000000-0000-4000-8000-000000000001" },
		]) {
			const event = { v: 1, ...payload, ...extras };
			expect(Schema.decodeUnknownSync(workspaceUpdateEventSchema)(event)).toEqual(event);
			expect(Schema.decodeUnknownSync(conversationUpdateEventSchema)(event)).toEqual(event);
		}
	});

	it("accepts changes to a conversation's items", () => {
		const event = {
			v: EVENT_VERSION,
			type: "conversation.item_changed",
			rootConversationId: "00000000-0000-4000-8000-000000000001",
			conversationId: "00000000-0000-4000-8000-000000000002",
		};
		expect(Schema.decodeUnknownResult(workspaceUpdateEventSchema)(event)._tag).toBe("Success");
		expect(Schema.decodeUnknownResult(conversationUpdateEventSchema)(event)._tag).toBe("Success");
	});
});

function toolCall(status: "running" | "completed") {
	return {
		type: "tool_call",
		id: "00000000-0000-4000-8000-000000000008",
		tool: "web_fetch",
		input: { url: "https://example.com" },
		output: status === "completed" ? { title: "Example" } : null,
		status,
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-14T00:00:00.000Z",
		finishedAt: status === "completed" ? "2026-09-14T00:00:01.000Z" : null,
	};
}

function message() {
	return {
		id: "00000000-0000-4000-8000-000000000004",
		conversationId: "00000000-0000-4000-8000-000000000001",
		author: testPerson({ id: "00000000-0000-4000-8000-000000000005", name: "Sam" }),
		kind: "text" as const,
		status: "complete" as const,
		parts: [{ type: "text" as const, text: "hi" }],
		content: "hi",
		createdAt: "2026-01-01T00:00:00Z",
	};
}
