import {
	type DurableEventType,
	EVENT_VERSION,
	type EventStream,
	type EventType,
	type StreamEvent,
} from "@sugabots/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.ts";
import type { EventRelay } from "./relay.ts";
import { inMemoryEventStore } from "./testing.ts";

/**
 * The bus, without an HTTP layer. `events.test.ts` beside the routes proves the
 * same behaviour over a real stream; these are the cases that are awkward to
 * provoke through a socket.
 */

const STREAM = "chat:c1";

function rawEvent<const T extends EventType>(
	type: T,
	data: Record<string, unknown> = {},
): StreamEvent & { type: T } {
	return { ...data, v: EVENT_VERSION, type };
}

/**
 * Reads `count` events off a subscription, then lets go of it. Called without
 * `await` so the subscriber is registered before the test publishes: the
 * generator turns as far as its first suspension the moment `next` is called,
 * and registration happens before that.
 */
function take(
	stream: AsyncIterable<EventBus.Delivery>,
	count: number,
	timeoutMs = 1000,
): Promise<EventBus.Delivery[]> {
	const iterator = stream[Symbol.asyncIterator]();
	const taken: EventBus.Delivery[] = [];

	let deadline: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		deadline = setTimeout(
			() => reject(new Error(`only ${taken.length} of ${count} events arrived`)),
			timeoutMs,
		);
	});

	return (async () => {
		try {
			while (taken.length < count) {
				const next = await Promise.race([iterator.next(), expired]);
				if (next.done) {
					break;
				}
				taken.push(next.value);
			}
			return taken;
		} finally {
			clearTimeout(deadline);
			await iterator.return?.(undefined);
		}
	})();
}

/** A bus over a memory store, and `commit`, which stores an event and delivers it as the outbox does. */
function bus() {
	const store = inMemoryEventStore();
	const events = EventBus.inProcess();
	const commit = (stream: EventStream, event: StreamEvent & { type: DurableEventType }) =>
		events.publishCommitted([store.record(stream, event)]);
	return { events, store, commit };
}

describe("publish and subscribe", () => {
	it("fans out an already committed event without storing it twice", async () => {
		const { events, store, commit } = bus();
		const live = take(events.subscribe(STREAM), 1);
		const event = rawEvent("chat.changed", { chatId: "c1" });

		await commit(STREAM, event);

		expect(await live).toEqual([{ seq: 1, event }]);
		expect(await store.replay(STREAM, 0, 10)).toEqual([{ seq: 1, event }]);
	});

	it("delivers to every live subscriber", async () => {
		const { events } = bus();
		const first = take(events.subscribe(STREAM), 1);
		const second = take(events.subscribe(STREAM), 1);

		await events.publish(STREAM, rawEvent("message.delta", { id: "m1" }));

		expect((await first)[0]?.event.id).toBe("m1");
		expect((await second)[0]?.event.id).toBe("m1");
	});

	it("keeps streams apart", async () => {
		const { events } = bus();
		const chat = take(events.subscribe(STREAM), 1);

		await events.publish("workspace:w1", rawEvent("message.delta", { id: "elsewhere" }));
		await events.publish(STREAM, rawEvent("message.delta", { id: "here" }));

		expect((await chat).map((delivery) => delivery.event.id)).toEqual(["here"]);
	});

	it("numbers committed events and leaves live-only ones unnumbered", async () => {
		const { events, commit } = bus();
		const stream = take(events.subscribe(STREAM), 2);

		await events.publish(STREAM, rawEvent("message.delta", { text: "hi" }));
		await commit(STREAM, rawEvent("message.completed"));

		const [delta, completed] = await stream;
		expect(delta?.seq).toBeUndefined();
		expect(completed?.seq).toBe(1);
	});

	it("holds ordering within a stream when publishes overlap", async () => {
		const { events } = bus();
		const stream = take(events.subscribe(STREAM), 5);

		await Promise.all(
			[1, 2, 3, 4, 5].map((n) => events.publish(STREAM, rawEvent("message.delta", { n }))),
		);

		expect((await stream).map((delivery) => delivery.event.n)).toEqual([1, 2, 3, 4, 5]);
	});

	it("relays committed events behind an in-flight publish on the same stream", async () => {
		let releaseFirst = () => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const relayed: unknown[] = [];
		const store = inMemoryEventStore();
		const events = EventBus.inProcess({
			relay: {
				async broadcast(_stream, delivery) {
					if (delivery.event.n === 1) await firstBlocked;
					relayed.push(delivery.event.n);
				},
				listen: async () => async () => {},
			},
		});
		const first = events.publish(STREAM, rawEvent("message.delta", { n: 1 }));
		const second = events.publishCommitted([
			store.record(STREAM, rawEvent("chat.changed", { n: 2 })),
		]);

		releaseFirst();
		await Promise.all([first, second]);

		expect(relayed).toEqual([1, 2]);
	});

	it("stops when the caller aborts", async () => {
		const { events } = bus();
		const abort = new AbortController();
		const stream = events.subscribe(STREAM, { signal: abort.signal });

		const drained = (async () => {
			const seen: EventBus.Delivery[] = [];
			for await (const delivery of stream) {
				seen.push(delivery);
				abort.abort();
			}
			return seen;
		})();

		await events.publish(STREAM, rawEvent("message.delta"));

		expect(await drained).toHaveLength(1);
	});
});

describe("slow subscribers", () => {
	it("are dropped with a reset rather than buffered forever", async () => {
		const events = EventBus.inProcess({ maxBuffered: 3 });
		const iterator = events.subscribe(STREAM)[Symbol.asyncIterator]();

		// One read, so the subscriber exists and is registered. It then sits on
		// the yield without asking for another, which is a consumer that has
		// stopped keeping up.
		const first = iterator.next();
		await events.publish(STREAM, rawEvent("message.delta", { n: 0 }));
		expect((await first).value?.event.n).toBe(0);

		for (const n of [1, 2, 3, 4]) {
			await events.publish(STREAM, rawEvent("message.delta", { n }));
		}

		expect((await iterator.next()).value?.event.type).toBe("reset");
		// Reset here means "reconnect": the stream ends rather than carrying on
		// with a history the client can no longer trust.
		expect((await iterator.next()).done).toBe(true);
	});
});

describe("closing the bus", () => {
	it("ends the subscriptions parked on it, so the process can stop", async () => {
		// Behind a parked subscriber is an open response holding a socket. Left
		// parked, they keep the server from closing and the process from exiting,
		// which is a restart that never finishes.
		const { events } = bus();
		const stream = events.subscribe(STREAM)[Symbol.asyncIterator]();
		// Parks it: nothing has been published, so it is waiting for the first event.
		const parked = stream.next();

		await events.close();

		expect(await parked).toEqual({ done: true, value: undefined });
	});
});

describe("listening to other processes", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * A relay whose first `failures` starts fail, as Postgres refusing
	 * connections while it restarts does, and which then hands over what
	 * other processes broadcast through `broadcastFromElsewhere`.
	 */
	function relayFailingFirst(failures: number) {
		let receive: Parameters<EventRelay["listen"]>[0] | undefined;
		const starts = { tried: 0, stopped: 0 };
		const relay: EventRelay = {
			broadcast: async () => {},
			async listen(onDelivery) {
				starts.tried++;
				if (starts.tried <= failures) throw new Error("connection refused");
				receive = onDelivery;
				return async () => {
					starts.stopped++;
				};
			},
		};
		const broadcastFromElsewhere = (stream: EventStream, delivery: EventBus.Delivery) =>
			receive?.(stream, delivery);
		return { relay, starts, broadcastFromElsewhere };
	}

	it("keeps trying to start, waiting longer each time, and delivers once it has", async () => {
		vi.useFakeTimers();
		const { relay, starts, broadcastFromElsewhere } = relayFailingFirst(2);
		const logged: string[] = [];
		const events = EventBus.inProcess({
			relay,
			log: (message) => logged.push(message),
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(starts.tried).toBe(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(starts.tried).toBe(2);
		await vi.advanceTimersByTimeAsync(1999);
		expect(starts.tried).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(starts.tried).toBe(3);

		const subscription = events.subscribe(STREAM)[Symbol.asyncIterator]();
		const next = subscription.next();
		broadcastFromElsewhere(STREAM, { seq: 7, event: rawEvent("message.created", { id: "m1" }) });

		expect((await next).value).toEqual({
			seq: 7,
			event: rawEvent("message.created", { id: "m1" }),
		});
		expect(logged).toEqual([
			"Listening for other processes' events failed; live updates are local only until it starts. Trying again in 1 s",
			"Listening for other processes' events failed; live updates are local only until it starts. Trying again in 2 s",
		]);
		await events.close();
		expect(starts.stopped).toBe(1);
	});

	it("closes without waiting to retry a start that fails after it was asked to close", async () => {
		vi.useFakeTimers();
		const { promise: refused, reject: refuse } = Promise.withResolvers<never>();
		let tried = 0;
		const relay: EventRelay = {
			broadcast: async () => {},
			listen: () => {
				tried++;
				return refused;
			},
		};
		const events = EventBus.inProcess({ relay, log: () => {} });
		await vi.advanceTimersByTimeAsync(0);
		let closed = false;
		const closing = events.close().then(() => {
			closed = true;
		});

		refuse(new Error("connection refused"));
		await vi.advanceTimersByTimeAsync(0);

		expect(closed).toBe(true);
		expect(tried).toBe(1);
		await closing;
	});

	it("stops trying once the bus closes", async () => {
		vi.useFakeTimers();
		const { relay, starts } = relayFailingFirst(Number.POSITIVE_INFINITY);
		const events = EventBus.inProcess({ relay, log: () => {} });
		await vi.advanceTimersByTimeAsync(0);

		await events.close();
		await vi.advanceTimersByTimeAsync(120_000);

		expect(starts.tried).toBe(1);
	});
});
