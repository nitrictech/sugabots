import { streamEvent } from "@sugabots/contracts";
import { describe, expect, it, vi } from "vitest";
import { isApiFailure } from "./errors.ts";
import { createEventsApi } from "./events.ts";
import { memoryTokenStore } from "./tokens.ts";

/**
 * The client end of a stream. The API is not involved: `fetch` is replaced by
 * something that hands back a scripted body, which is how a reconnect — the
 * behaviour that matters most here — can be provoked at will.
 */

const BASE = "https://api.test";

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
	url: string;
	headers: Headers;
	credentials?: RequestCredentials;
}

/**
 * A `fetch` that plays one scripted response per call. A string is a body that
 * ends, which is a server hanging up; a number is that status.
 */
function scripted(...responses: (string | number)[]) {
	const calls: Call[] = [];

	const fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
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
			if (scene === 204) {
				return new Response(null, { status: 204 });
			}
			return new Response(JSON.stringify({ message: "no" }), {
				status: scene,
			});
		}

		return new Response(new TextEncoder().encode(scene), {
			status: 200,
			headers: { "content-type": "text/event-stream; charset=utf-8" },
		});
	}) as typeof globalThis.fetch;

	return { fetch, calls };
}

function events(fetch: typeof globalThis.fetch, token = "t0") {
	return createEventsApi({ baseUrl: BASE, tokens: memoryTokenStore(token), fetch, retryMs: 1 });
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
	it("asks for the right route with the bearer token", async () => {
		const { fetch, calls } = scripted(frame({ event: "thread.created", id: 1 }));
		const stream = events(fetch).workspace("w1");

		await take(stream, 1);

		expect(calls[0]?.url).toBe(`${BASE}/workspaces/w1/events`);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer t0");
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
		expect(calls[0]?.credentials).toBe("omit");
	});

	it("includes browser cookies when no bearer store is supplied", async () => {
		const { fetch, calls } = scripted(frame({ event: "thread.created", id: 1 }));
		const stream = createEventsApi({ baseUrl: BASE, fetch }).workspace("w1");

		await take(stream, 1);

		expect(calls[0]?.credentials).toBe("include");
		expect(calls[0]?.headers.get("authorization")).toBeNull();
	});

	it("escapes an id rather than pasting it into the path", async () => {
		const { fetch, calls } = scripted(frame({ event: "message.created", id: 1 }));
		await take(events(fetch).thread("a/../b"), 1);

		expect(calls[0]?.url).toBe(`${BASE}/threads/a%2F..%2Fb/events`);
	});
});

describe("parsing", () => {
	it("yields the events in a body, in order", async () => {
		const { fetch } = scripted(
			frame({ event: "message.created", id: 1 }) +
				frame({ event: "message.delta", data: { v: 1, type: "message.delta", text: "hi" } }) +
				frame({ event: "message.completed", id: 2 }),
		);

		const seen = await take(events(fetch).thread("c1"), 3);

		expect(seen.map((event) => event.type)).toEqual([
			"message.created",
			"message.delta",
			"message.completed",
		]);
	});

	it("keeps a payload field it has no schema for", async () => {
		const { fetch } = scripted(
			frame({
				event: "thread.created",
				id: 1,
				data: { v: 1, type: "thread.created", threadId: "c1" },
			}),
		);

		expect((await take(events(fetch).workspace("w1"), 1))[0]).toEqual({
			v: 1,
			type: "thread.created",
			threadId: "c1",
		});
	});

	it("skips a frame it cannot read instead of failing the stream", async () => {
		const { fetch } = scripted(
			"event: broken\ndata: {not json\n\n" +
				'event: old\ndata: {"v":99,"type":"from.the.future"}\n\n' +
				frame({ event: "message.created", id: 1 }),
		);

		expect((await take(events(fetch).thread("c1"), 1)).map((e) => e.type)).toEqual([
			"message.created",
		]);
	});

	it("bounds an unfinished frame", async () => {
		const { fetch } = scripted(`data: ${"x".repeat(64 * 1024)}\n`);

		await expect(take(events(fetch).thread("c1"), 1)).rejects.toMatchObject({
			_tag: "InternalServerError",
		});
	});

	it("ignores the server's keep-alive comments", async () => {
		const { fetch } = scripted(`: ping\n\n: ping\n\n${frame({ event: "turn.started", id: 1 })}`);

		expect(await take(events(fetch).thread("c1"), 1)).toHaveLength(1);
	});
});

describe("resume", () => {
	it("backs off when successful responses keep ending without events", async () => {
		vi.useFakeTimers();
		const { fetch, calls } = scripted("", "", 401);
		const stream = createEventsApi({
			baseUrl: BASE,
			tokens: memoryTokenStore(),
			fetch,
			retryMs: 100,
		}).workspace("w1");
		const finished = expect(take(stream, 1)).rejects.toMatchObject({ _tag: "Unauthorized" });

		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(49);
			expect(calls).toHaveLength(1);
			await vi.runAllTimersAsync();
			await finished;
			expect(calls).toHaveLength(3);
		} finally {
			stream.close();
			vi.useRealTimers();
		}
	});

	it("reconnects when the server hangs up, and says where it got to", async () => {
		const { fetch, calls } = scripted(
			frame({ event: "message.created", id: 7 }),
			frame({ event: "message.completed", id: 8 }),
		);

		const stream = events(fetch).thread("c1");
		const seen = await take(stream, 2);

		expect(seen.map((event) => event.type)).toEqual(["message.created", "message.completed"]);
		expect(calls[0]?.headers.get("last-event-id")).toBeNull();
		expect(calls[1]?.headers.get("last-event-id")).toBe("7");
		expect(stream.lastEventId).toBe("8");
	});

	it("does not let a delta move the resume point", async () => {
		// Deltas carry no id, so a reconnect goes back to the last state change
		// and the partial text is recovered from the message itself.
		const { fetch, calls } = scripted(
			frame({ event: "message.created", id: 7 }) +
				frame({ event: "message.delta", data: { v: 1, type: "message.delta", text: "hi" } }),
			frame({ event: "message.completed", id: 8 }),
		);

		await take(events(fetch).thread("c1"), 3);

		expect(calls[1]?.headers.get("last-event-id")).toBe("7");
	});

	it("starts from a remembered id", async () => {
		const { fetch, calls } = scripted(frame({ event: "message.created", id: 12 }));
		await take(events(fetch).thread("c1", { lastEventId: "11" }), 1);

		expect(calls[0]?.headers.get("last-event-id")).toBe("11");
	});

	it("preserves an empty id as a cleared checkpoint", async () => {
		const { fetch, calls } = scripted(
			frame({ event: "message.created", id: 7 }) +
				frame({ event: "message.delta", id: "", data: { v: 1, type: "message.delta" } }),
			frame({ event: "message.completed", id: 8 }),
		);

		await take(events(fetch).thread("c1"), 3);

		expect(calls[1]?.headers.get("last-event-id")).toBeNull();
	});

	it("resets instead of checkpointing an invalid identified event", async () => {
		const { fetch, calls } = scripted(
			"id: 8\ndata: {not json\n\n",
			frame({ event: "message.completed", id: 9 }),
		);

		const seen = await take(events(fetch).thread("c1"), 2);

		expect(seen.map((event) => event.type)).toEqual(["reset", "message.completed"]);
		expect(calls[1]?.headers.get("last-event-id")).toBeNull();
	});

	it("passes a reset through for the caller to act on", async () => {
		// The client cannot refetch on its own — only the caller knows what view
		// this stream is feeding — so `reset` is delivered like any other event.
		const { fetch } = scripted(frame({ event: "reset", data: { v: 1, type: "reset" } }));

		expect((await take(events(fetch).thread("c1"), 1))[0]?.type).toBe("reset");
	});
});

describe("failure", () => {
	it("ends permanently when the server returns 204", async () => {
		const { fetch, calls } = scripted(204, frame({ event: "message.created", id: 1 }));

		expect(await take(events(fetch).thread("c1"), 1)).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("rejects a successful response that is not an event stream", async () => {
		const fetch = vi.fn(async () => Response.json({ status: "ok" })) as typeof globalThis.fetch;

		await expect(take(events(fetch).thread("c1"), 1)).rejects.toMatchObject({
			_tag: "InternalServerError",
		});
	});

	it("retries a server error", async () => {
		const { fetch, calls } = scripted(503, frame({ event: "message.created", id: 1 }));

		await take(events(fetch).thread("c1"), 1);

		expect(calls).toHaveLength(2);
	});

	it("gives up when the token is refused, rather than retrying forever", async () => {
		const { fetch, calls } = scripted(401);

		const failure = await take(events(fetch).thread("c1"), 1).catch((error: unknown) => error);
		expect(isApiFailure(failure)).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("gives up on a resource that is not there", async () => {
		const { fetch } = scripted(404);

		await expect(take(events(fetch).thread("gone"), 1)).rejects.toMatchObject({ _tag: "NotFound" });
	});

	it("waits out a rate limit instead of giving up on it", async () => {
		// 429 and 408 are the two 4xx that mean "later", not "never". Treating
		// the whole range as fatal left a rate-limited tab with no live
		// updates until it was reloaded.
		const { fetch, calls } = scripted(429, 408, frame({ event: "message.created", id: 1 }));

		expect(await take(events(fetch).thread("c1"), 1)).toHaveLength(1);
		expect(calls).toHaveLength(3);
	});
});

describe("closing", () => {
	it("ends the iteration without throwing", async () => {
		const { fetch } = scripted(frame({ event: "message.created", id: 1 }));
		const stream = events(fetch).thread("c1");

		const seen: unknown[] = [];
		for await (const event of stream) {
			seen.push(event);
			stream.close();
		}

		expect(seen).toHaveLength(1);
	});

	it("stops reconnecting once the caller's signal aborts", async () => {
		const abort = new AbortController();
		const { fetch, calls } = scripted(frame({ event: "message.created", id: 1 }));

		for await (const _event of events(fetch).thread("c1", { signal: abort.signal })) {
			abort.abort();
		}

		expect(calls).toHaveLength(1);
	});
});
