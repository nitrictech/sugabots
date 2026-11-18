export * as EventBus from "./bus.ts";

import {
	type EventStream,
	isDurableEventType,
	resetEvent,
	type StreamEvent,
} from "@sugabots/contracts";
import { Context, Effect, Layer } from "effect";
import type { CommittedEvent } from "./outbox.ts";
import { type EventRelay, postgresEventRelay } from "./relay.ts";
import { EventStore } from "./store.ts";

/**
 * Publish and fan-out for live updates, in order within each stream.
 *
 * An in-process registry of subscribers plus a table for the events worth
 * replaying. A process is never alone for long (a second dev server, a rolling
 * restart, a second replica), so each delivery made here is also handed to the
 * relay, which carries it to the other processes' buses; what they broadcast
 * arrives here and is delivered like a local publish.
 */

export interface Interface {
	publish(stream: EventStream, event: StreamEvent): Promise<void>;
	publishCommitted(events: CommittedEvent[]): Promise<void>;
	subscribe(stream: EventStream, options?: SubscribeOptions): AsyncIterable<Delivery>;
	/**
	 * Stops listening to other processes and ends every subscription here.
	 *
	 * Ending them is what lets the process stop. A subscriber parks forever
	 * waiting for the next event, and behind each one is an open response
	 * holding a socket, so a server that closes without this waits on clients
	 * that are never going to hang up. Closing twice is the same as once.
	 */
	close(): Promise<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/EventBus") {}

/**
 * The process's bus, over the event store and relayed to the other processes
 * through Postgres: every process runs workflows, so what one writes the
 * others must hear about. Closed when the layer's scope is.
 */
export const make = Effect.gen(function* () {
	const store = yield* EventStore.Service;
	const runFork = Effect.runForkWith(yield* Effect.context<never>());
	const log = (message: string, cause: unknown) => void runFork(Effect.logError(message, cause));
	const relay = yield* postgresEventRelay(store, { log });
	return yield* Effect.acquireRelease(
		Effect.sync(() => inProcess({ store, relay, log })),
		(bus) => Effect.promise(() => bus.close()),
	);
});

export const layer = Layer.effect(Service, make);

/** An event as a subscriber receives it. Only durable events carry a `seq`. */
export interface Delivery {
	seq?: number;
	event: StreamEvent;
}

interface SubscribeOptions {
	/** Resume after this `seq` — the client's `Last-Event-ID`. */
	since?: number;
	/** Ends the subscription. The stream route aborts on disconnect and on age. */
	signal?: AbortSignal;
}

/** How many events a subscriber may fall behind before it is dropped. */
const MAX_BUFFERED = 1000;

/**
 * Beyond this, a replay costs more than a refetch. The client gets a `reset`
 * and rebuilds the view over REST, which is one query instead of thousands.
 */
const MAX_REPLAY = 5000;

interface Subscriber {
	queue: Delivery[];
	/** Set while the subscriber is parked waiting for the next event. */
	wake?: () => void;
	/** True once the queue overflowed: the subscriber gets a `reset` and ends. */
	overflowed: boolean;
}

interface InProcessOptions {
	store: EventStore.Interface;
	/** Without one, deliveries stay in this process: right for tests, wrong for a server. */
	relay?: EventRelay;
	maxBuffered?: number;
	log?: (message: string, cause: unknown) => void;
}

/** The bus in this process, with `relay` carrying its deliveries to other processes. */
export function inProcess({
	store,
	relay,
	maxBuffered = MAX_BUFFERED,
	log = console.error,
}: InProcessOptions): Interface {
	const streams = new Map<EventStream, Set<Subscriber>>();
	let closed = false;

	// Failing to tell the other processes must not fail the publish: the change
	// is committed and this process's subscribers have it.
	const broadcast = relay
		? (stream: EventStream, delivery: Delivery) =>
				relay
					.broadcast(stream, delivery)
					.catch((cause) => log("Relaying an event to other processes failed", cause))
		: async () => {};
	const listening = relay
		? relay.listen(deliver).catch((cause) => {
				log("Listening for other processes' events failed; live updates are local only", cause);
				return async () => {};
			})
		: Promise.resolve(async () => {});

	/**
	 * One publish at a time per stream.
	 *
	 * Subscribers receive a stream's events in sequence order, and two
	 * overlapping publishes could otherwise take their sequence numbers in one
	 * order and reach subscribers in the other.
	 */
	const publishing = new Map<EventStream, Promise<void>>();

	function serialize(stream: EventStream, publishOne: () => Promise<void>): Promise<void> {
		const done = (publishing.get(stream) ?? Promise.resolve()).then(publishOne, publishOne);
		// The queue holds a promise that never rejects, so one failed publish
		// does not reject every publish queued behind it.
		const queued = done.catch(() => {});
		publishing.set(stream, queued);

		void queued.then(() => {
			if (publishing.get(stream) === queued) {
				publishing.delete(stream);
			}
		});

		return done;
	}

	function deliver(stream: EventStream, delivery: Delivery): void {
		for (const subscriber of streams.get(stream) ?? []) {
			if (subscriber.overflowed) {
				continue;
			}
			if (subscriber.queue.length >= maxBuffered) {
				// A consumer this far behind will not catch up by being sent
				// more. Drop what it has not read; it reconnects and resumes.
				subscriber.overflowed = true;
				subscriber.queue.length = 0;
			} else {
				subscriber.queue.push(delivery);
			}
			subscriber.wake?.();
		}
	}

	return {
		publish(stream, event) {
			return serialize(stream, async () => {
				const seq = isDurableEventType(event.type) ? await store.append(stream, event) : undefined;
				const delivery: Delivery = seq === undefined ? { event } : { seq, event };
				deliver(stream, delivery);
				// Inside the serialised publish so this stream's notices leave in
				// the order its events were numbered.
				await broadcast(stream, delivery);
			});
		},

		async publishCommitted(events) {
			await Promise.all(
				events.map((committed) =>
					serialize(committed.stream, async () => {
						const delivery: Delivery = { seq: committed.seq, event: committed.event };
						deliver(committed.stream, delivery);
						await broadcast(committed.stream, delivery);
					}),
				),
			);
		},

		async close() {
			closed = true;
			for (const subscribers of streams.values()) {
				for (const subscriber of subscribers) {
					subscriber.wake?.();
				}
			}
			const stop = await listening;
			await stop();
		},

		async *subscribe(stream, { since, signal } = {}) {
			// Registered before the replay reads a row, so an event published
			// during the replay is buffered rather than lost in the gap between
			// the last row read and the first live delivery.
			const subscriber: Subscriber = { queue: [], overflowed: false };
			const subscribers = streams.get(stream) ?? new Set<Subscriber>();
			subscribers.add(subscriber);
			streams.set(stream, subscribers);

			try {
				let replayed = since ?? 0;

				if (since !== undefined && since > 0) {
					if (await store.has(stream, since)) {
						// One row past the cap is how "too long to be worth
						// sending" is detected without a second query.
						const missed = await store.replay(stream, since, MAX_REPLAY + 1);

						if (missed.length > MAX_REPLAY) {
							// Sending events the client is about to discard helps
							// nobody: reset, and let it refetch over REST.
							replayed = 0;
							yield { event: resetEvent() };
						} else {
							for (const stored of missed) {
								replayed = stored.seq;
								yield stored;
							}
						}
					} else {
						// The resume point has been pruned, or was never ours.
						// Nothing was replayed, so nothing live is a duplicate —
						// and an id from another stream, or an invented one,
						// must not go on suppressing events for being too small.
						replayed = 0;
						yield { event: resetEvent() };
					}
				}

				while (!signal?.aborted && !closed) {
					if (subscriber.overflowed) {
						yield { event: resetEvent() };
						return;
					}

					const delivery = subscriber.queue.shift();
					if (!delivery) {
						await parked(subscriber, signal);
						continue;
					}
					// Already sent from the table; the live copy is a duplicate.
					if (delivery.seq !== undefined && delivery.seq <= replayed) {
						continue;
					}

					yield delivery;
				}
			} finally {
				subscribers.delete(subscriber);
				if (subscribers.size === 0) {
					streams.delete(stream);
				}
			}
		},
	};
}

/** Waits for the next event on this subscriber, or for the stream to end. */
function parked(subscriber: Subscriber, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => {
			subscriber.wake = undefined;
			signal?.removeEventListener("abort", done);
			resolve();
		};

		subscriber.wake = done;
		signal?.addEventListener("abort", done, { once: true });
	});
}
