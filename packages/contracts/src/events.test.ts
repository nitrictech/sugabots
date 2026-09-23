import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	durableEventTypeSchema,
	EVENT_VERSION,
	ephemeralEventTypeSchema,
	eventPayloadSchemas,
	isDurableEventType,
	streamEvent,
	streamEventSchema,
	threadUpdateEventSchema,
	workspaceUpdateEventSchema,
} from "./events.ts";

describe("durability", () => {
	it("persists state changes and not progress", () => {
		expect(isDurableEventType("message.created")).toBe(true);
		expect(isDurableEventType("message.delta")).toBe(false);
	});

	it("classifies every declared type, and nothing twice", () => {
		const durable = durableEventTypeSchema.literals;
		const ephemeral = ephemeralEventTypeSchema.literals;

		expect(durable.every(isDurableEventType)).toBe(true);
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
		const event = streamEvent("thread.created", { threadId: "c1" });

		expect(event).toEqual({
			v: EVENT_VERSION,
			type: "thread.created",
			threadId: "c1",
		});
	});

	it("cannot have its version overwritten by a payload field", () => {
		expect(streamEvent("unknown.event", { v: 99 }).v).toBe(EVENT_VERSION);
	});

	it("parses an event carrying fields this version has never seen", () => {
		const parsed = Schema.decodeUnknownSync(streamEventSchema)({
			v: 1,
			type: "thread.changed",
			surprise: true,
		});

		expect(parsed.surprise).toBe(true);
	});

	it("rejects an event from a version this client cannot read", () => {
		expect(
			Schema.decodeUnknownResult(streamEventSchema)({ v: 2, type: "thread.changed" })._tag,
		).toBe("Failure");
	});

	it("rejects an event with no type", () => {
		expect(Schema.decodeUnknownResult(streamEventSchema)({ v: 1, type: "" })._tag).toBe("Failure");
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
		"thread.changed",
		"collaboration.updated",
	])("recognizes the known thread update %s", (type) => {
		const ids = {
			threadId: "00000000-0000-4000-8000-000000000001",
			turnId: "00000000-0000-4000-8000-000000000002",
			agentId: "00000000-0000-4000-8000-000000000003",
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
			"collaboration.updated": {
				...ids,
				messageId: "00000000-0000-4000-8000-000000000004",
				collaboration: {
					type: "collaboration",
					id: "00000000-0000-4000-8000-000000000006",
					agentId: ids.agentId,
					agentName: "Helper",
					threadId: "00000000-0000-4000-8000-000000000007",
					brief: "Look into it",
					status: "waiting",
					answer: null,
					atOffset: 0,
				},
			},
		};

		expect(
			Schema.decodeUnknownResult(threadUpdateEventSchema)({
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

	it("preserves extras while validating known channel payloads", () => {
		const event = {
			v: 1,
			type: "message.delta",
			threadId: "00000000-0000-4000-8000-000000000001",
			messageId: "m1",
			offset: 0,
			text: "hi",
			extra: { future: true },
		};
		const parsed = Schema.decodeUnknownSync(threadUpdateEventSchema)(event);
		expect(parsed).toEqual(event);
		expect(Schema.encodeSync(threadUpdateEventSchema)(parsed)).toEqual(event);
		expect(Schema.decodeUnknownResult(threadUpdateEventSchema)({ ...event, offset: -1 })._tag).toBe(
			"Failure",
		);
	});

	it("keeps open empty payloads and workspace envelopes", () => {
		const extras = { future: { value: 1 } };
		expect(Schema.decodeUnknownSync(eventPayloadSchemas["agent.updated"])(extras)).toEqual(extras);
		for (const type of ["reset", "thread.changed"]) {
			const event = { v: 1, type, ...extras };
			expect(Schema.decodeUnknownSync(workspaceUpdateEventSchema)(event)).toEqual(event);
			expect(Schema.decodeUnknownSync(threadUpdateEventSchema)(event)).toEqual(event);
		}
	});

	it.each(["collaboration", "routine"])("accepts chat thread changes for %s", (threadType) => {
		const event = {
			v: EVENT_VERSION,
			type: "chat.thread_changed",
			chatId: "00000000-0000-4000-8000-000000000001",
			threadId: "00000000-0000-4000-8000-000000000002",
			threadType,
		};
		expect(Schema.decodeUnknownResult(workspaceUpdateEventSchema)(event)._tag).toBe("Success");
		expect(Schema.decodeUnknownResult(threadUpdateEventSchema)(event)._tag).toBe("Success");
	});

	it.each(["chat", "system_agent"])("rejects chat thread changes for %s", (threadType) => {
		expect(
			Schema.decodeUnknownResult(workspaceUpdateEventSchema)({
				v: EVENT_VERSION,
				type: "chat.thread_changed",
				chatId: "00000000-0000-4000-8000-000000000001",
				threadId: "00000000-0000-4000-8000-000000000002",
				threadType,
			})._tag,
		).toBe("Failure");
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
		threadId: "00000000-0000-4000-8000-000000000001",
		author: {
			kind: "person" as const,
			id: "00000000-0000-4000-8000-000000000005",
			name: "Sam",
			email: "sam@example.com",
			handle: "sam",
			image: null,
		},
		kind: "text" as const,
		status: "complete" as const,
		parts: [{ type: "text" as const, text: "hi" }],
		content: "hi",
		createdAt: "2026-01-01T00:00:00Z",
	};
}
