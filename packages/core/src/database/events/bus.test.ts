import { EVENT_VERSION, type EventType, type StreamEvent, streamEvent } from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { EventStore } from "./store.ts";

/**
 * The bus, without an HTTP layer. `events.test.ts` beside the routes proves the
 * same behaviour over a real stream; these are the cases that are awkward to
 * provoke through a socket.
 */

const CHANNEL = "thread:c1";

function rawEvent(type: EventType, data: Record<string, unknown> = {}): StreamEvent {
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

const types = (deliveries: EventBus.Delivery[]) =>
	deliveries.map((delivery) => delivery.event.type);

function bus(): EventBus.Interface {
	return EventBus.inProcess({ store: EventStore.inMemory() });
}

describe("publish and subscribe", () => {
	it("fans out an already committed event without storing it twice", async () => {
		const store = EventStore.inMemory();
		const events = EventBus.inProcess({ store });
		const live = take(events.subscribe(CHANNEL), 1);
		const event = streamEvent("agent.updated", { id: "m1" });
		const seq = await store.append(CHANNEL, event);

		await events.publishCommitted([{ channel: CHANNEL, seq, event }]);

		expect(await live).toEqual([{ seq, event }]);
		expect(await store.replay(CHANNEL, 0, 10)).toEqual([{ seq, event }]);
	});

	it("delivers to every live subscriber", async () => {
		const events = bus();
		const first = take(events.subscribe(CHANNEL), 1);
		const second = take(events.subscribe(CHANNEL), 1);

		await events.publish(CHANNEL, rawEvent("message.created", { id: "m1" }));

		expect((await first)[0]?.event.id).toBe("m1");
		expect((await second)[0]?.event.id).toBe("m1");
	});

	it("keeps channels apart", async () => {
		const events = bus();
		const thread = take(events.subscribe(CHANNEL), 1);

		await events.publish("workspace:w1", rawEvent("thread.created"));
		await events.publish(CHANNEL, rawEvent("message.created"));

		expect(types(await thread)).toEqual(["message.created"]);
	});

	it("numbers durable events and leaves deltas unnumbered", async () => {
		const events = bus();
		const stream = take(events.subscribe(CHANNEL), 3);

		await events.publish(CHANNEL, rawEvent("message.created"));
		await events.publish(CHANNEL, rawEvent("message.delta", { text: "hi" }));
		await events.publish(CHANNEL, rawEvent("message.completed"));

		const [created, delta, completed] = await stream;
		expect(created?.seq).toBe(1);
		expect(delta?.seq).toBeUndefined();
		// The delta took no sequence number, so the next state change is 2.
		expect(completed?.seq).toBe(2);
	});

	it("holds ordering within a channel when publishes overlap", async () => {
		const events = bus();
		const stream = take(events.subscribe(CHANNEL), 5);

		await Promise.all(
			[1, 2, 3, 4, 5].map((n) => events.publish(CHANNEL, rawEvent("turn.started", { n }))),
		);

		expect((await stream).map((delivery) => delivery.event.n)).toEqual([1, 2, 3, 4, 5]);
	});

	it("queues committed fan-out behind an in-flight publish on the same channel", async () => {
		let releaseAppend = () => {};
		const appendBlocked = new Promise<void>((resolve) => {
			releaseAppend = resolve;
		});
		const store = EventStore.inMemory();
		const append = store.append.bind(store);
		store.append = async (channel, event) => {
			await appendBlocked;
			return append(channel, event);
		};
		const events = EventBus.inProcess({ store });
		const stream = take(events.subscribe(CHANNEL), 2);
		const first = events.publish(CHANNEL, rawEvent("message.created", { n: 1 }));
		const second = events.publishCommitted([
			{ channel: CHANNEL, seq: 2, event: streamEvent("agent.updated", { n: 2 }) },
		]);

		releaseAppend();
		await Promise.all([first, second]);

		expect((await stream).map((delivery) => delivery.event.n)).toEqual([1, 2]);
	});

	it("stops when the caller aborts", async () => {
		const events = bus();
		const abort = new AbortController();
		const stream = events.subscribe(CHANNEL, { signal: abort.signal });

		const drained = (async () => {
			const seen: EventBus.Delivery[] = [];
			for await (const delivery of stream) {
				seen.push(delivery);
				abort.abort();
			}
			return seen;
		})();

		await events.publish(CHANNEL, rawEvent("message.created"));

		expect(await drained).toHaveLength(1);
	});
});

describe("resume", () => {
	it("replays what a subscriber missed, then goes live", async () => {
		const events = bus();

		await events.publish(CHANNEL, rawEvent("message.created", { id: "m1" }));
		await events.publish(CHANNEL, rawEvent("message.completed", { id: "m1" }));

		// Resuming after the first: the second is replayed from the table, the
		// third arrives live, and there is no gap between them.
		const resumed = take(events.subscribe(CHANNEL, { since: 1 }), 2);
		await events.publish(CHANNEL, rawEvent("message.created", { id: "m2" }));

		const [replayed, live] = await resumed;
		expect(replayed).toEqual({ seq: 2, event: { v: 1, type: "message.completed", id: "m1" } });
		expect(live?.seq).toBe(3);
	});

	it("never replays a delta", async () => {
		const events = bus();

		await events.publish(CHANNEL, rawEvent("message.created"));
		await events.publish(CHANNEL, rawEvent("message.delta", { text: "gone" }));
		await events.publish(CHANNEL, rawEvent("message.completed"));

		expect(types(await take(events.subscribe(CHANNEL, { since: 1 }), 1))).toEqual([
			"message.completed",
		]);
	});

	it("delivers an event published during the replay exactly once", async () => {
		const events = bus();
		await events.publish(CHANNEL, rawEvent("message.created", { n: 1 }));

		// Subscribing and publishing without yielding in between is the race
		// the subscriber registers early to close: the new event is buffered
		// live *and* readable from the table, and must arrive once.
		const stream = take(events.subscribe(CHANNEL, { since: 1 }), 2);
		await events.publish(CHANNEL, rawEvent("message.created", { n: 2 }));
		await events.publish(CHANNEL, rawEvent("message.created", { n: 3 }));

		expect((await stream).map((delivery) => delivery.seq)).toEqual([2, 3]);
	});

	it("resets a resume point that has been pruned away", async () => {
		const store = EventStore.inMemory();
		const events = EventBus.inProcess({ store });

		await events.publish(CHANNEL, rawEvent("message.created"));
		await store.prune(new Date(Date.now() + 1000));

		const stream = take(events.subscribe(CHANNEL, { since: 1 }), 2);
		await events.publish(CHANNEL, rawEvent("message.completed"));

		const [first, second] = await stream;
		expect(first?.event.type).toBe("reset");
		// After a reset the client refetches over REST and keeps listening, so
		// the stream stays open and live events keep coming.
		expect(second?.event.type).toBe("message.completed");
	});

	it("resets an id that was never on this channel", async () => {
		const events = bus();
		await events.publish("workspace:w1", rawEvent("thread.created"));

		const stream = take(events.subscribe(CHANNEL, { since: 1 }), 1);
		expect(types(await stream)).toEqual(["reset"]);
	});

	it("starts live when there is nothing to resume from", async () => {
		const events = bus();
		await events.publish(CHANNEL, rawEvent("message.created"));

		const stream = take(events.subscribe(CHANNEL), 1);
		await events.publish(CHANNEL, rawEvent("message.completed"));

		expect(types(await stream)).toEqual(["message.completed"]);
	});
});

describe("slow subscribers", () => {
	it("are dropped with a reset rather than buffered forever", async () => {
		const events = EventBus.inProcess({ store: EventStore.inMemory(), maxBuffered: 3 });
		const iterator = events.subscribe(CHANNEL)[Symbol.asyncIterator]();

		// One read, so the subscriber exists and is registered. It then sits on
		// the yield without asking for another, which is a consumer that has
		// stopped keeping up.
		const first = iterator.next();
		await events.publish(CHANNEL, rawEvent("message.delta", { n: 0 }));
		expect((await first).value?.event.n).toBe(0);

		for (const n of [1, 2, 3, 4]) {
			await events.publish(CHANNEL, rawEvent("message.delta", { n }));
		}

		expect((await iterator.next()).value?.event.type).toBe("reset");
		// Reset here means "reconnect": the stream ends rather than carrying on
		// with a history the client can no longer trust.
		expect((await iterator.next()).done).toBe(true);
	});
});

describe("a resume point that cannot be trusted", () => {
	it("does not let an invented id swallow the events that follow", async () => {
		const events = bus();

		// An id far beyond anything issued. The reset is the easy part; what
		// matters is that live events, whose seq is far below it, still arrive.
		const stream = take(events.subscribe(CHANNEL, { since: 9_999_999 }), 2);
		await events.publish(CHANNEL, rawEvent("message.created"));

		expect(types(await stream)).toEqual(["reset", "message.created"]);
	});
});

describe("a long replay", () => {
	it("is sent in full when it is worth sending", async () => {
		const events = bus();
		for (let n = 0; n < 600; n += 1) {
			await events.publish(CHANNEL, rawEvent("message.created", { n }));
		}

		// Comfortably more than a handful, and well under the reset threshold.
		const replayed = await take(events.subscribe(CHANNEL, { since: 1 }), 599);

		expect(replayed.map((delivery) => delivery.seq)).toEqual(
			Array.from({ length: 599 }, (_, index) => index + 2),
		);
	});
});

describe("closing the bus", () => {
	it("ends the subscriptions parked on it, so the process can stop", async () => {
		// Behind a parked subscriber is an open response holding a socket. Left
		// parked, they keep the server from closing and the process from exiting,
		// which is a restart that never finishes.
		const bus = EventBus.inProcess({ store: EventStore.inMemory() });
		const stream = bus.subscribe(CHANNEL)[Symbol.asyncIterator]();
		// Parks it: nothing has been published, so it is waiting for the first event.
		const parked = stream.next();

		await bus.close();

		expect(await parked).toEqual({ done: true, value: undefined });
	});
});
