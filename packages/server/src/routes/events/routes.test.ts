import { EVENT_VERSION, type EventType, type StreamEvent, streamEvent } from "@sugabots/contracts";
import { EventBus } from "@sugabots/core/database/events/bus";
import { PodAudience } from "@sugabots/core/database/events/pod-audience";
import { EventStore } from "@sugabots/core/database/events/store";
import { Effect, Layer, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy, type TestApp } from "../../http/app.test-support.ts";
import { openChannelAccess } from "./access.test-support.ts";
import { ChannelAccess } from "./access.ts";
import { StreamTiming, type Timing } from "./routes.ts";

/**
 * The stream routes, driven through `createTestApp`: no socket, no database,
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

const resolveUser: UserResolver = async (headers) =>
	headers.get("authorization") === "Bearer good-token" ? user : null;

function server(access: ChannelAccess.Interface = openChannelAccess, timing?: Partial<Timing>) {
	const bus = EventBus.inProcess({ store: EventStore.inMemory() });
	return { bus, app: streaming(bus, { access, timing }) };
}

/** The app with its streams on `bus`, open to everyone unless `access` says otherwise. */
function streaming(
	bus: EventBus.Interface,
	{
		access = openChannelAccess,
		timing = {},
		logs = Layer.empty,
	}: { access?: ChannelAccess.Interface; timing?: Partial<Timing>; logs?: Layer.Layer<never> } = {},
) {
	return createTestApp(
		Layer.mergeAll(
			identifiedBy(resolveUser),
			Layer.succeed(EventBus.Service, bus),
			Layer.succeed(ChannelAccess.Service, access),
			Layer.succeed(StreamTiming, { ...StreamTiming.defaultValue(), ...timing }),
			logs,
		),
	);
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
	app: TestApp,
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
			workspace: () => Effect.undefined,
			thread: () => Effect.undefined,
			reachesPod: () => Effect.succeed(false),
		});

		const response = await app.request(`/threads/${THREAD}/events`, {
			headers: { authorization: "Bearer good-token" },
		});

		expect(response.status).toBe(404);
	});

	it("subscribes to the channel authorisation resolved, not the one in the path", async () => {
		// Access answers with the channel to listen to, and the route must use that
		// answer rather than build a channel from the path itself.
		const { app, bus } = server({
			workspace: () => Effect.undefined,
			thread: () => Effect.succeed("thread:root"),
			reachesPod: () => Effect.succeed(true),
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
		const bus = EventBus.inProcess({ store: EventStore.inMemory() });
		let open = 0;
		const counted: EventBus.Interface = {
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
		const app = streaming(counted);

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
		const { app } = server(openChannelAccess, { ping: 5 });
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		expect((await stream.take(2)).map((frame) => frame.comment)).toEqual(["ping", "ping"]);
		stream.close();
	});

	it("hangs up eventually, so a client that went away cannot hold a connection", async () => {
		const { app } = server(openChannelAccess, { maxAge: "10 millis" });
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		await expect(stream.take(1)).rejects.toThrow("stream ended");
	});

	it.each(["revoked", "changed"])("ends when thread access is %s", async (change) => {
		let channel: "thread:root" | "thread:other" | undefined = "thread:root";
		const { app, bus } = server(
			{
				workspace: () => Effect.undefined,
				thread: () => Effect.succeed(channel),
				reachesPod: () => Effect.succeed(true),
			},
			{ recheck: 0 },
		);
		const stream = await open(app, `/threads/${THREAD}/events`);
		await bus.publish("thread:root", rawEvent("message.created"));
		await stream.take(1);
		channel = change === "revoked" ? undefined : "thread:other";
		await bus.publish("thread:root", rawEvent("message.created"));
		await expect(stream.take(1)).rejects.toThrow("stream ended");
	});

	it("asks about access again only once the recheck window has passed", async () => {
		let asked = 0;
		const { app, bus } = server({
			workspace: () => Effect.undefined,
			thread: () =>
				Effect.sync(() => {
					asked += 1;
					return "thread:root" as const;
				}),
			reachesPod: () => Effect.succeed(true),
		});
		const stream = await open(app, `/threads/${THREAD}/events`);
		for (let i = 0; i < 3; i++) {
			await bus.publish("thread:root", rawEvent("message.delta"));
		}
		await stream.take(3);
		// Once to open the stream, once for the first event.
		expect(asked).toBe(2);
		stream.close();
	});

	it("logs a subscription failure and ends after flushing queued events", async () => {
		const failure = new Error("subscription failed");
		const logged: unknown[] = [];
		const bus = EventBus.inProcess({ store: EventStore.inMemory() });
		const app = streaming(
			{
				...bus,
				async *subscribe() {
					yield { seq: 1, event: rawEvent("message.created") };
					throw failure;
				},
			},
			{ logs: Logger.layer([Logger.make(({ message }) => logged.push(message))]) },
		);
		const stream = await open(app, `/threads/${THREAD}/events`);
		expect((await stream.take(1))[0]?.id).toBe("1");
		await expect(stream.take(1)).rejects.toThrow("stream ended");
		expect(logged).toContainEqual([`Streaming thread:${THREAD} failed`, failure]);
	});

	it("bounds read-ahead and releases a producer blocked by a slow client", async () => {
		let produced = 0;
		let subscribed = false;
		const bus = EventBus.inProcess({ store: EventStore.inMemory() });
		const app = streaming({
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
		const bus = EventBus.inProcess({ store: EventStore.inMemory(), maxBuffered: 2 });
		const app = streaming(bus);
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

describe("events meant for one pod's people", () => {
	const REACHED = "0199a3a0-0000-7000-8000-0000000000c1";
	const UNREACHED = "0199a3a0-0000-7000-8000-0000000000c2";
	const reachingOne: ChannelAccess.Interface = {
		...openChannelAccess,
		reachesPod: (podId) => Effect.succeed(podId === REACHED),
	};
	const channel = `workspace:${WORKSPACE}` as const;
	const about = (podId: string, threadId: string) =>
		PodAudience.forPod(podId, streamEvent("thread.changed", { threadId }));

	it("skips what a listener outside the pod may not hear, and sends the rest without the pod", async () => {
		const { app, bus } = server(reachingOne);
		const stream = await open(app, `/workspaces/${WORKSPACE}/events`);

		await bus.publish(channel, about(UNREACHED, "hidden"));
		await bus.publish(channel, about(REACHED, "shown"));

		expect(await stream.take(1)).toEqual([
			{
				event: "thread.changed",
				id: "2",
				data: { v: 1, type: "thread.changed", threadId: "shown" },
			},
		]);
		stream.close();
	});

	it("skips them on a replay too", async () => {
		const { app, bus } = server(reachingOne);
		await bus.publish(channel, rawEvent("thread.created", { threadId: "first" }));
		await bus.publish(channel, about(UNREACHED, "hidden"));
		await bus.publish(channel, about(REACHED, "shown"));

		const resumed = await open(app, `/workspaces/${WORKSPACE}/events`, { lastEventId: "1" });

		expect((await resumed.take(1))[0]).toMatchObject({ id: "3", data: { threadId: "shown" } });
		resumed.close();
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

describe("typing", () => {
	const typing = (app: TestApp) =>
		app.request(`/threads/${THREAD}/typing`, {
			method: "POST",
			headers: { authorization: "Bearer good-token" },
		});

	it("tells the thread's watchers who is typing, without an id to resume from", async () => {
		const { app } = server();
		const stream = await open(app, `/threads/${THREAD}/events`);

		expect((await typing(app)).status).toBe(204);

		expect((await stream.take(1))[0]).toEqual({
			event: "person.typing",
			data: {
				v: 1,
				type: "person.typing",
				threadId: THREAD,
				person: { kind: "person", id: user.id, name: "Sam", handle: "sam", image: null },
			},
		});
		stream.close();
	});

	it("answers 404 for a thread the caller cannot see, and tells nobody", async () => {
		const { app, bus } = server({ ...openChannelAccess, thread: () => Effect.undefined });
		const publish = vi.spyOn(bus, "publish");

		expect((await typing(app)).status).toBe(404);
		expect(publish).not.toHaveBeenCalled();
	});
});
