import {
	type DurableEventType,
	EVENT_VERSION,
	type EventStream,
	type EventType,
	type StreamEvent,
} from "@sugabots/contracts";
import { describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
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

const types = (deliveries: EventBus.Delivery[]) =>
	deliveries.map((delivery) => delivery.event.type);

/** A bus over a memory store, and `commit`, which stores an event and delivers it as the outbox does. */
function bus() {
	const store = inMemoryEventStore();
	const events = EventBus.inProcess({ store });
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
			store,
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

describe("resume", () => {
	it("replays what a subscriber missed, then goes live", async () => {
		const { events, commit } = bus();

		await commit(STREAM, rawEvent("message.created", { id: "m1" }));
		await commit(STREAM, rawEvent("message.completed", { id: "m1" }));

		// Resuming after the first: the second is replayed from the table, the
		// third arrives live, and there is no gap between them.
		const resumed = take(events.subscribe(STREAM, { since: 1 }), 2);
		await commit(STREAM, rawEvent("message.created", { id: "m2" }));

		const [replayed, live] = await resumed;
		expect(replayed).toEqual({ seq: 2, event: { v: 1, type: "message.completed", id: "m1" } });
		expect(live?.seq).toBe(3);
	});

	it("never replays a delta", async () => {
		const { events, commit } = bus();

		await commit(STREAM, rawEvent("message.created"));
		await events.publish(STREAM, rawEvent("message.delta", { text: "gone" }));
		await commit(STREAM, rawEvent("message.completed"));

		expect(types(await take(events.subscribe(STREAM, { since: 1 }), 1))).toEqual([
			"message.completed",
		]);
	});

	it("delivers an event committed during the replay exactly once", async () => {
		const { events, commit } = bus();
		await commit(STREAM, rawEvent("message.created", { n: 1 }));

		// Subscribing and committing without yielding in between is the race
		// the subscriber registers early to close: the new event is buffered
		// live *and* readable from the table, and must arrive once.
		const stream = take(events.subscribe(STREAM, { since: 1 }), 2);
		await commit(STREAM, rawEvent("message.created", { n: 2 }));
		await commit(STREAM, rawEvent("message.created", { n: 3 }));

		expect((await stream).map((delivery) => delivery.seq)).toEqual([2, 3]);
	});

	it("resets a resume point that has been pruned away", async () => {
		const { events, store, commit } = bus();

		await commit(STREAM, rawEvent("message.created"));
		await store.prune(new Date(Date.now() + 1000));

		const stream = take(events.subscribe(STREAM, { since: 1 }), 2);
		await commit(STREAM, rawEvent("message.completed"));

		const [first, second] = await stream;
		expect(first?.event.type).toBe("reset");
		// After a reset the client refetches over REST and keeps listening, so
		// the stream stays open and live events keep coming.
		expect(second?.event.type).toBe("message.completed");
	});

	it("resets an id that was never on this stream", async () => {
		const { events, commit } = bus();
		await commit("workspace:w1", rawEvent("chat.changed"));

		const stream = take(events.subscribe(STREAM, { since: 1 }), 1);
		expect(types(await stream)).toEqual(["reset"]);
	});

	it("starts live when there is nothing to resume from", async () => {
		const { events, commit } = bus();
		await commit(STREAM, rawEvent("message.created"));

		const stream = take(events.subscribe(STREAM), 1);
		await commit(STREAM, rawEvent("message.completed"));

		expect(types(await stream)).toEqual(["message.completed"]);
	});
});

describe("slow subscribers", () => {
	it("are dropped with a reset rather than buffered forever", async () => {
		const events = EventBus.inProcess({ store: inMemoryEventStore(), maxBuffered: 3 });
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

describe("a resume point that cannot be trusted", () => {
	it("does not let an invented id swallow the events that follow", async () => {
		const { events, commit } = bus();

		// An id far beyond anything issued. The reset is the easy part; what
		// matters is that live events, whose seq is far below it, still arrive.
		const stream = take(events.subscribe(STREAM, { since: 9_999_999 }), 2);
		await commit(STREAM, rawEvent("message.created"));

		expect(types(await stream)).toEqual(["reset", "message.created"]);
	});
});

describe("a long replay", () => {
	it("is sent in full when it is worth sending", async () => {
		const { events, commit } = bus();
		for (let n = 0; n < 600; n += 1) {
			await commit(STREAM, rawEvent("message.created", { n }));
		}

		// Comfortably more than a handful, and well under the reset threshold.
		const replayed = await take(events.subscribe(STREAM, { since: 1 }), 599);

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
		const { events } = bus();
		const stream = events.subscribe(STREAM)[Symbol.asyncIterator]();
		// Parks it: nothing has been published, so it is waiting for the first event.
		const parked = stream.next();

		await events.close();

		expect(await parked).toEqual({ done: true, value: undefined });
	});
});
