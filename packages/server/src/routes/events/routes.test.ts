import { EVENT_VERSION, type EventType, type StreamEvent, streamEvent } from "@sugabots/contracts";
import { createEventBus, type EventBus } from "@sugabots/core/database/events/bus";
import { memoryEventStore } from "@sugabots/core/database/events/store";
import { describe, expect, it, vi } from "vitest";
import type { SessionResolver } from "../../auth/session.ts";
import { createTestApp } from "../../http/app.test-support.ts";
import type { AppType } from "../../http/app.ts";
import { openChannelAccess } from "./access.test-support.ts";
import type { ChannelAccess } from "./access.ts";
import type { StreamOptions } from "./routes.ts";

/**
 * The stream routes, driven through `app.request()`: no socket, no database,
 * but a real Response whose body is parsed the way a client parses it.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-00000000000a";
const THREAD = "0199a3a0-0000-7000-8000-00000000000b";

function rawEvent(type: EventType, data: Record<string, unknown> = {}): StreamEvent {
	return { ...data, v: EVENT_VERSION, type };
}

const user = {
	id: "0199a3a0-0000-7000-8000-0000000000ff",
	email: "sam@example.com",
	name: "Sam",
	image: null,
};

const resolveSession: SessionResolver = async (headers) =>
	headers.get("authorization") === "Bearer good-token" ? { user } : null;

function server(access: ChannelAccess = openChannelAccess(), stream?: StreamOptions) {
	const bus = createEventBus({ store: memoryEventStore() });
	return { bus, app: createTestApp({ resolveSession, events: { bus, access, stream } }) };
}

interface Frame {
	event?: string;
	id?: string;
	data?: unknown;
	comment?: string;
}

/**
 * Opens a stream and reads frames off it until `count` have arrived, then hangs
 * up — which is what a client closing a tab does, and what the next `open` with
 * a `Last-Event-ID` resumes from.
 */
async function open(
	app: AppType,
	path: string,
	{ lastEventId, token = "good-token" }: { lastEventId?: string; token?: string } = {},
) {
	const response = await app.request(path, {
		headers: {
			authorization: `Bearer ${token}`,
			...(lastEventId ? { "last-event-id": lastEventId } : {}),
		},
	});

	const reader = response.body?.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	return {
		response,
		/** Reads until `count` frames have arrived. Rejects if the stream ends first. */
		async take(count: number): Promise<Frame[]> {
			const frames: Frame[] = [];

			while (frames.length < count) {
				const chunk = await reader?.read();
				if (!chunk || chunk.done) {
					throw new Error(`stream ended after ${frames.length} of ${count} frames`);
				}

				buffer += decoder.decode(chunk.value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					frames.push(parseFrame(buffer.slice(0, boundary)));
					buffer = buffer.slice(boundary + 2);
					boundary = buffer.indexOf("\n\n");
				}
			}

			return frames;
		},
		close: () => void reader?.cancel(),
	};
}

function parseFrame(raw: string): Frame {
	const frame: Frame = {};

	for (const line of raw.split("\n")) {
		if (line.startsWith(":")) {
			frame.comment = line.slice(1).trim();
		} else if (line.startsWith("event:")) {
			frame.event = line.slice(6).trim();
		} else if (line.startsWith("id:")) {
			frame.id = line.slice(3).trim();
		} else if (line.startsWith("data:")) {
			frame.data = JSON.parse(line.slice(5).trim());
		}
	}

	return frame;
}

describe("authorisation", () => {
	it("answers 404, not 403, for a resource the caller cannot see", async () => {
		// Telling the caller a thread exists but is not theirs is itself a leak.
		const { app } = server({
			workspace: async () => undefined,
			thread: async () => undefined,
		});

		const response = await app.request(`/threads/${THREAD}/events`, {
			headers: { authorization: "Bearer good-token" },
		});

		expect(response.status).toBe(404);
	});

	it("subscribes to the channel authorisation resolved, not the one in the path", async () => {
		// A thread's events publish on its root thread's channel, so the id in the
		// path and the channel listened to are routinely different.
		const { app, bus } = server({
			workspace: async () => undefined,
			thread: async () => "thread:root",
		});

		const stream = await open(app, `/threads/${THREAD}/events`);
		await bus.publish("thread:root", rawEvent("message.created", { id: "m1" }));

		expect((await stream.take(1))[0]?.event).toBe("message.created");
		stream.close();
	});
});

describe("the stream", () => {
	it("declares itself as events and asks every hop not to buffer it", async () => {
		const { app } = server();
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
		expect(stream.response.headers.get("cache-control")).toBe("no-store");
		expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
		stream.close();
	});

	it("answers HEAD with stream headers without subscribing", async () => {
		const { app, bus } = server();
		const subscribe = vi.spyOn(bus, "subscribe");

		const response = await app.request(`/workspaces/${WORKSPACE}/events`, {
			method: "HEAD",
			headers: { authorization: "Bearer good-token" },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-accel-buffering")).toBe("no");
		expect(response.body).toBeNull();
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("carries the event name, the payload and the id", async () => {
		const { app, bus } = server();
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		await bus.publish(`workspace:${WORKSPACE}`, streamEvent("thread.created", { threadId: "c1" }));

		expect((await stream.take(1))[0]).toEqual({
			event: "thread.created",
			id: "1",
			data: { v: 1, type: "thread.created", threadId: "c1" },
		});
		stream.close();
	});

	it("sends deltas without an id, so they cannot become a resume point", async () => {
		const { app, bus } = server();
		const stream = await open(app, `/threads/${THREAD}/events`);

		await bus.publish(`thread:${THREAD}`, rawEvent("message.delta", { text: "hel" }));

		const [delta] = await stream.take(1);
		expect(delta?.event).toBe("message.delta");
		expect(delta?.id).toBeUndefined();
		stream.close();
	});

	it("unsubscribes when the client hangs up, rather than leaving a subscriber behind", async () => {
		const bus = createEventBus({ store: memoryEventStore() });
		let open = 0;
		const counted: EventBus = {
			...bus,
			async *subscribe(channel, options) {
				open += 1;
				try {
					yield* bus.subscribe(channel, options);
				} finally {
					open -= 1;
				}
			},
		};
		const app = createTestApp({
			resolveSession,
			events: { bus: counted, access: openChannelAccess() },
		});

		const response = await app.request(`/workspaces/${WORKSPACE}/events`, {
			headers: { authorization: "Bearer good-token" },
		});
		const reader = response.body?.getReader();
		await bus.publish(`workspace:${WORKSPACE}`, streamEvent("thread.created", { threadId: "c1" }));
		await reader?.read();
		expect(open).toBe(1);

		// Awaited on purpose: an un-awaited cancel is why this went unnoticed.
		await reader?.cancel();
		await vi.waitFor(() => expect(open).toBe(0));
	});

	it("pings so a proxy does not close an idle stream", async () => {
		const { app } = server(openChannelAccess(), { ping: 5 });
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		expect((await stream.take(2)).map((frame) => frame.comment)).toEqual(["ping", "ping"]);
		stream.close();
	});

	it("hangs up eventually, so a client that went away cannot hold a connection", async () => {
		const { app } = server(openChannelAccess(), { maxAge: "10 millis" });
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		await expect(stream.take(1)).rejects.toThrow("stream ended");
	});

	it.each(["revoked", "changed"])("ends when thread access is %s", async (change) => {
		let channel: "thread:root" | "thread:other" | undefined = "thread:root";
		const { app, bus } = server({
			workspace: async () => undefined,
			thread: async () => channel,
		});
		const stream = await open(app, `/threads/${THREAD}/events`);
		await bus.publish("thread:root", rawEvent("message.created"));
		await stream.take(1);
		channel = change === "revoked" ? undefined : "thread:other";
		await bus.publish("thread:root", rawEvent("message.created"));
		await expect(stream.take(1)).rejects.toThrow("stream ended");
	});

	it("logs a subscription failure and ends after flushing queued events", async () => {
		const failure = new Error("subscription failed");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const bus = createEventBus({ store: memoryEventStore() });
		const app = createTestApp({
			resolveSession,
			events: {
				access: openChannelAccess(),
				bus: {
					...bus,
					async *subscribe() {
						yield { seq: 1, event: rawEvent("message.created") };
						throw failure;
					},
				},
			},
		});
		try {
			const stream = await open(app, `/threads/${THREAD}/events`);
			expect((await stream.take(1))[0]?.id).toBe("1");
			await expect(stream.take(1)).rejects.toThrow("stream ended");
			expect(log).toHaveBeenCalledWith(`Streaming thread:${THREAD} failed`, failure);
		} finally {
			log.mockRestore();
		}
	});

	it("bounds read-ahead and releases a producer blocked by a slow client", async () => {
		let produced = 0;
		let subscribed = false;
		const bus = createEventBus({ store: memoryEventStore() });
		const app = createTestApp({
			resolveSession,
			events: {
				access: openChannelAccess(),
				bus: {
					...bus,
					async *subscribe() {
						subscribed = true;
						try {
							while (true) {
								produced += 1;
								yield { seq: produced, event: rawEvent("message.created") };
							}
						} finally {
							subscribed = false;
						}
					},
				},
			},
		});
		const response = await app.request(`/threads/${THREAD}/events`, {
			headers: { authorization: "Bearer good-token" },
		});
		try {
			await vi.waitFor(() => expect(produced).toBeGreaterThan(16));
			expect(produced).toBeLessThan(100);
		} finally {
			await response.body?.cancel();
		}
		await vi.waitFor(() => expect(subscribed).toBe(false));
	});

	it("flushes a reset and ends when a slow subscriber overflows the bus", async () => {
		const bus = createEventBus({ store: memoryEventStore(), maxBuffered: 2 });
		const app = createTestApp({
			resolveSession,
			events: { bus, access: openChannelAccess() },
		});
		const response = await app.request(`/threads/${THREAD}/events`, {
			headers: { authorization: "Bearer good-token" },
		});
		try {
			for (let index = 0; index < 200; index += 1) {
				await bus.publish(`thread:${THREAD}`, rawEvent("message.created"));
			}
			const text = await response.text();
			const frames = text.trim().split("\n\n").map(parseFrame);
			expect(frames.at(-1)?.event).toBe("reset");
			expect(frames.at(-1)?.id).toBeUndefined();
			expect(frames.length).toBeLessThan(200);
		} finally {
			await bus.close();
		}
	});

	it("ends an idle response when the bus closes", async () => {
		const { app, bus } = server();
		const stream = await open(app, `/threads/${THREAD}/events`);
		await bus.close();
		await expect(stream.take(1)).rejects.toThrow("stream ended");
	});
});

describe("resuming", () => {
	it("replays events published after the client's Last-Event-ID", async () => {
		const { app, bus } = server();
		const channel = `thread:${THREAD}`;
		const path = `/threads/${THREAD}/events`;

		const initial = await open(app, path);
		await bus.publish(channel, rawEvent("message.created", { id: "m1" }));
		const [seen] = await initial.take(1);
		expect(seen?.id).toBe("1");
		initial.close();
		await bus.publish(channel, rawEvent("message.completed", { id: "m1" }));

		const resumed = await open(app, path, { lastEventId: seen?.id });
		expect((await resumed.take(1))[0]).toEqual({
			event: "message.completed",
			id: "2",
			data: { v: 1, type: "message.completed", id: "m1" },
		});

		resumed.close();
	});

	it("tells a client whose resume point is gone to start again", async () => {
		const { app, bus } = server();
		await bus.publish(`thread:${THREAD}`, rawEvent("message.created"));

		const stream = await open(app, `/threads/${THREAD}/events`, { lastEventId: "9999" });

		expect((await stream.take(1))[0]?.event).toBe("reset");
		stream.close();
	});

	it("ignores a Last-Event-ID that is not a sequence number", async () => {
		const { app, bus } = server();
		const stream = await open(app, `/threads/${THREAD}/events`, { lastEventId: "nonsense" });

		await bus.publish(`thread:${THREAD}`, rawEvent("message.created", { id: "m1" }));

		expect((await stream.take(1))[0]?.event).toBe("message.created");
		stream.close();
	});
});
