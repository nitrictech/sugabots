import { streamEvent } from "@sugabots/contracts";
import { describe, expect, it, vi } from "vitest";
import { createEventsApi } from "./events.ts";

/**
 * The client end of a stream. The API is not involved: `fetch` is replaced by
 * something that hands back a scripted body, which is how a reconnect — the
 * behaviour that matters most here — can be provoked at will.
 */

const BASE = "https://api.test";

/** The longest event data the client accepts. */
const MAX_EVENT_CHARS = 1024 * 1024;

/** An SSE frame, as the server writes it. */
function frame({
	event,
	id,
	data,
}: {
	event: string;
	id?: number | string;
	data?: unknown;
}): string {
	return [
		`event: ${event}`,
		...(id === undefined ? [] : [`id: ${id}`]),
		`data: ${JSON.stringify(data ?? streamEvent(event))}`,
		"",
		"",
	].join("\n");
}

interface Call {
	startedAtMs: number;
	url: string;
	headers: Headers;
	credentials?: RequestCredentials;
}

/**
 * A `fetch` that plays one scripted response per call. A string is a body that
 * ends, which is a server hanging up; a list of strings is such a body arriving
 * in those chunks; a number is that status.
 */
function scripted(...responses: (string | readonly string[] | number)[]) {
	const calls: Call[] = [];

	const fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			startedAtMs: Date.now(),
			url: String(url),
			headers: new Headers(init?.headers),
			credentials: init?.credentials,
		});
		const scene = responses[calls.length - 1] ?? Number.POSITIVE_INFINITY;

		if (typeof scene === "number") {
			if (!Number.isFinite(scene)) {
				// Past the end of the script: hold the connection open rather
				// than spinning through reconnects while the test finishes.
				return new Response(new ReadableStream(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(JSON.stringify({ message: "no" }), {
				status: scene,
			});
		}

		const chunks = typeof scene === "string" ? [scene] : scene;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream; charset=utf-8" },
		});
	}) as typeof globalThis.fetch;

	return { fetch, calls };
}

function events(fetch: typeof globalThis.fetch) {
	return createEventsApi({ baseUrl: BASE, fetch, retryMs: 1 });
}

/** Reads `count` events, then closes the stream. */
async function take(stream: AsyncIterable<{ type: string }>, count: number) {
	const taken: { type: string }[] = [];
	for await (const event of stream) {
		taken.push(event);
		if (taken.length === count) {
			break;
		}
	}
	return taken;
}

describe("requests", () => {
	it("asks for the right route with the session cookie", async () => {
		const { fetch, calls } = scripted(frame({ event: "chat.created", id: 1 }));
		const stream = events(fetch).workspace("w1");

		await take(stream, 1);

		expect(calls[0]?.url).toBe(`${BASE}/workspaces/w1/events`);
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(calls[0]?.credentials).toBe("include");
	});

	it("escapes an id rather than pasting it into the path", async () => {
		const { fetch, calls } = scripted(frame({ event: "message.created", id: 1 }));
		await take(events(fetch).chat("a/../b"), 1);

		expect(calls[0]?.url).toBe(`${BASE}/chats/a%2F..%2Fb/events`);
	});
});

describe("parsing", () => {
	it("yields the events in a body, in order", async () => {
		const { fetch } = scripted(
			frame({ event: "message.created", id: 1 }) +
				frame({ event: "message.delta", data: { v: 1, type: "message.delta", text: "hi" } }) +
				frame({ event: "message.completed", id: 2 }),
		);

		const seen = await take(events(fetch).chat("c1"), 3);

		expect(seen.map((event) => event.type)).toEqual([
			"message.created",
			"message.delta",
			"message.completed",
		]);
	});

	it("keeps a payload field it has no schema for", async () => {
		const { fetch } = scripted(
			frame({
				event: "chat.created",
				id: 1,
				data: { v: 1, type: "chat.created", chatId: "c1" },
			}),
		);

		expect((await take(events(fetch).workspace("w1"), 1))[0]).toEqual({
			v: 1,
			type: "chat.created",
			chatId: "c1",
		});
	});

	it("skips a frame it cannot read instead of failing the stream", async () => {
		const { fetch } = scripted(
			"event: broken\ndata: {not json\n\n" +
				'event: old\ndata: {"v":99,"type":"from.the.future"}\n\n' +
				frame({ event: "message.created", id: 1 }),
		);

		expect((await take(events(fetch).chat("c1"), 1)).map((e) => e.type)).toEqual([
			"message.created",
		]);
	});

	it("delivers a tool call whose stored output was cut down, and the events after it", async () => {
		// The server cuts a large output to a 64,000-character preview of its
		// JSON, which the event's own JSON escapes again.
		const searchResults = JSON.stringify(
			Array.from({ length: 500 }, (_, index) => ({
				name: `crm__find_contact_${index}`,
				description: "Find a contact by name or email.",
				inputSchema: { type: "object", properties: { query: { type: "string" } } },
			})),
		);
		const toolCallCompleted = streamEvent("tool_call.completed", {
			chatId: "c1",
			messageId: "m1",
			toolCall: {
				type: "tool_call",
				id: "t1",
				tool: "tool_search",
				input: { query: "contacts" },
				output: {
					truncated: true,
					characters: searchResults.length,
					preview: searchResults.slice(0, 64_000),
				},
				status: "completed",
				error: null,
				approval: null,
				atOffset: 0,
				startedAt: "2026-10-06T02:50:51.000Z",
				finishedAt: "2026-10-06T02:50:51.027Z",
			},
		});
		const { fetch } = scripted(
			frame({ event: "tool_call.completed", id: 1, data: toolCallCompleted }) +
				frame({ event: "message.delta", id: 2 }),
		);

		expect((await take(events(fetch).chat("c1"), 2)).map((e) => e.type)).toEqual([
			"tool_call.completed",
			"message.delta",
		]);
	});

	it("bounds an unfinished frame", async () => {
		const { fetch } = scripted(`data: ${"x".repeat(2 * MAX_EVENT_CHARS + 1)}\n`);

		await expect(take(events(fetch).chat("c1"), 1)).rejects.toMatchObject({
			_tag: "InternalServerError",
		});
	});

	describe("holds every event to the size limit, however its chunks split", () => {
		/** A frame whose data is exactly `characters` long. */
		const frameOfSize = (characters: number) => {
			const delta = (text: string) =>
				streamEvent("message.delta", {
					chatId: "c1",
					messageId: "m1",
					offset: 0,
					text,
					execution: 1,
				});
			const padding = characters - JSON.stringify(delta("")).length;
			return frame({ event: "message.delta", id: 1, data: delta("x".repeat(padding)) });
		};
		/** The frame whole, and split one character before its data ends. */
		const deliveries = (whole: string) => {
			const splitAt = whole.length - "x}\n\n".length + 1;
			return [
				["whole", [whole]],
				["split", [whole.slice(0, splitAt), whole.slice(splitAt)]],
			] as const;
		};

		it.each(deliveries(frameOfSize(MAX_EVENT_CHARS)))(
			"delivers one at the limit, %s",
			async (_, chunks) => {
				const { fetch } = scripted(chunks);

				expect(await take(events(fetch).chat("c1"), 1)).toHaveLength(1);
			},
		);

		it.each(deliveries(frameOfSize(MAX_EVENT_CHARS + 1)))(
			"refuses one past the limit, %s",
			async (_, chunks) => {
				const { fetch } = scripted(chunks);

				await expect(take(events(fetch).chat("c1"), 1)).rejects.toMatchObject({
					_tag: "InternalServerError",
				});
			},
		);
	});

	it("delivers the events before a frame past the limit and none after it, in one chunk", async () => {
		const oversized = frame({
			event: "message.delta",
			id: 2,
			data: { pad: "x".repeat(MAX_EVENT_CHARS) },
		});
		const { fetch } = scripted([
			frame({ event: "turn.started", id: 1 }) +
				oversized +
				frame({ event: "turn.completed", id: 3 }),
		]);
		const delivered: string[] = [];

		const reading = (async () => {
			for await (const event of events(fetch).chat("c1")) delivered.push(event.type);
		})();

		await expect(reading).rejects.toMatchObject({ _tag: "InternalServerError" });
		expect(delivered).toEqual(["turn.started"]);
	});

	it("ignores the server's keep-alive comments", async () => {
		const { fetch } = scripted(`: ping\n\n: ping\n\n${frame({ event: "turn.started", id: 1 })}`);

		expect(await take(events(fetch).chat("c1"), 1)).toHaveLength(1);
	});
});

describe("resume", () => {
	it("backs off when successful responses keep ending without events", async () => {
		vi.useFakeTimers();
		const jitter = vi.spyOn(Math, "random").mockReturnValue(0.5);
		const { fetch, calls } = scripted("", "", 401);
		const stream = createEventsApi({ baseUrl: BASE, fetch, retryMs: 100 }).workspace("w1");
		const finished = expect(take(stream, 2)).rejects.toMatchObject({ _tag: "Unauthorized" });

		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toHaveLength(1);
			await vi.runAllTimersAsync();
			await finished;
			expect(calls).toHaveLength(3);
			const [initial, firstRetry, secondRetry] = calls.map((call) => call.startedAtMs) as [
				number,
				number,
				number,
			];
			expect(firstRetry).toBeGreaterThan(initial);
			expect(secondRetry - firstRetry).toBeGreaterThan(firstRetry - initial);
		} finally {
			stream.close();
			jitter.mockRestore();
			vi.useRealTimers();
		}
	});

	it("reconnects when the server hangs up, and says where it got to", async () => {
		const { fetch, calls } = scripted(
			frame({ event: "message.created", id: 7 }),
			frame({ event: "message.completed", id: 8 }),
		);

		const seen = await take(events(fetch).chat("c1"), 2);

		expect(seen.map((event) => event.type)).toEqual(["message.created", "message.completed"]);
		expect(calls[0]?.headers.get("last-event-id")).toBeNull();
		expect(calls[1]?.headers.get("last-event-id")).toBe("7");
	});

	it("leaves the refetch after a reconnect with nothing to resume from to the server's ready", async () => {
		const ready = frame({ event: "ready", data: { v: 1, type: "ready" } });
		const { fetch, calls } = scripted(
			`${ready}: ping\n\n`,
			ready + frame({ event: "message.completed", id: 8 }),
		);

		const seen = await take(events(fetch).chat("c1"), 3);

		expect(seen.map((event) => event.type)).toEqual(["ready", "ready", "message.completed"]);
		expect(calls[1]?.headers.get("last-event-id")).toBeNull();
	});

	it("resumes from where ready said the stream starts, even when it starts empty", async () => {
		const { fetch, calls } = scripted(
			frame({ event: "ready", id: 0, data: { v: 1, type: "ready" } }),
			frame({ event: "message.completed", id: 8 }),
		);

		const seen = await take(events(fetch).chat("c1"), 2);

		expect(seen.map((event) => event.type)).toEqual(["ready", "message.completed"]);
		expect(calls[1]?.headers.get("last-event-id")).toBe("0");
	});

	it("does not let a delta move the resume point", async () => {
		// Deltas carry no id, so a reconnect goes back to the last state change
		// and the partial text is recovered from the message itself.
		const { fetch, calls } = scripted(
			frame({ event: "message.created", id: 7 }) +
				frame({ event: "message.delta", data: { v: 1, type: "message.delta", text: "hi" } }),
			frame({ event: "message.completed", id: 8 }),
		);

		await take(events(fetch).chat("c1"), 3);

		expect(calls[1]?.headers.get("last-event-id")).toBe("7");
	});

	it("preserves an empty id as a cleared checkpoint", async () => {
		const { fetch, calls } = scripted(
			frame({ event: "message.created", id: 7 }) +
				frame({ event: "message.delta", id: "", data: { v: 1, type: "message.delta" } }),
			frame({ event: "message.completed", id: 8 }),
		);

		await take(events(fetch).chat("c1"), 3);

		expect(calls[1]?.headers.get("last-event-id")).toBeNull();
	});

	it("resets instead of checkpointing an invalid identified event", async () => {
		const { fetch, calls } = scripted(
			"id: 8\ndata: {not json\n\n",
			frame({ event: "message.completed", id: 9 }),
		);

		const seen = await take(events(fetch).chat("c1"), 2);

		expect(seen.map((event) => event.type)).toEqual(["reset", "message.completed"]);
		expect(calls[1]?.headers.get("last-event-id")).toBeNull();
	});

	it("passes a reset through for the caller to act on", async () => {
		// The client cannot refetch on its own — only the caller knows what view
		// this stream is feeding — so `reset` is delivered like any other event.
		const { fetch } = scripted(frame({ event: "reset", data: { v: 1, type: "reset" } }));

		expect((await take(events(fetch).chat("c1"), 1))[0]?.type).toBe("reset");
	});
});

describe("failure", () => {
	it("rejects a successful response that is not an event stream", async () => {
		const fetch = vi.fn(async () => Response.json({ status: "ok" })) as typeof globalThis.fetch;

		await expect(take(events(fetch).chat("c1"), 1)).rejects.toMatchObject({
			_tag: "InternalServerError",
		});
	});

	it.each([503, 429, 408])("retries HTTP %s and delivers the next event", async (status) => {
		const { fetch, calls } = scripted(status, frame({ event: "message.created", id: 1 }));

		expect((await take(events(fetch).chat("c1"), 1)).map((event) => event.type)).toEqual([
			"message.created",
		]);
		expect(calls).toHaveLength(2);
	});

	it.each([
		["a number of seconds", "120"],
		["an HTTP date", new Date(Date.UTC(2026, 10, 25, 12, 2)).toUTCString()],
	])("waits at least as long as Retry-After asks, given as %s", async (_form, retryAfter) => {
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 25, 12, 0) });
		let calls = 0;
		const fetch = (async () => {
			calls++;
			return calls === 1
				? new Response(JSON.stringify({ message: "restarting" }), {
						status: 503,
						headers: { "retry-after": retryAfter },
					})
				: new Response(new TextEncoder().encode(frame({ event: "message.created", id: 1 })), {
						headers: { "content-type": "text/event-stream" },
					});
		}) as typeof globalThis.fetch;
		const stream = events(fetch).chat("c1");

		try {
			const first = take(stream, 1);
			await vi.advanceTimersByTimeAsync(119_999);
			expect(calls).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toBe(2);
			expect((await first).map((event) => event.type)).toEqual(["message.created"]);
		} finally {
			stream.close();
			vi.useRealTimers();
		}
	});

	it.each([
		[401, "Unauthorized"],
		[404, "NotFound"],
	])("ends on HTTP %s with %s", async (status, tag) => {
		const { fetch, calls } = scripted(status);

		await expect(take(events(fetch).chat("c1"), 1)).rejects.toMatchObject({ _tag: tag });
		expect(calls).toHaveLength(1);
	});
});

describe("closing", () => {
	it("ends the iteration without throwing", async () => {
		const { fetch } = scripted(frame({ event: "message.created", id: 1 }));
		const stream = events(fetch).chat("c1");

		const seen: unknown[] = [];
		for await (const event of stream) {
			seen.push(event);
			stream.close();
		}

		expect(seen).toHaveLength(1);
	});
});
