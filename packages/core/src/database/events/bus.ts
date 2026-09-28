import {
	type Channel,
	isDurableEventType,
	resetEvent,
	type StreamEvent,
} from "@sugabots/contracts";
import type { CommittedEvent } from "./outbox.ts";
import type { EventRelay } from "./relay.ts";
import type { EventStore } from "./store.ts";

/**
 * Publish and fan-out for live updates (ADR 001).
 *
 * An in-process registry of subscribers plus a table for the events worth
 * replaying. A process is never alone for long (a second dev server, a rolling
 * restart, a second replica), so each delivery made here is also handed to the
 * relay, which carries it to the other processes' buses; what they broadcast
 * arrives here and is delivered like a local publish.
 */

/** An event as a subscriber receives it. Only durable events carry a `seq`. */
export interface Delivery {
	seq?: number;
	event: StreamEvent;
}

export interface SubscribeOptions {
	/** Resume after this `seq` — the client's `Last-Event-ID`. */
	since?: number;
	/** Ends the subscription. The stream route aborts on disconnect and on age. */
	signal?: AbortSignal;
}

export interface EventBus {
	publish(channel: Channel, event: StreamEvent): Promise<void>;
	publishCommitted(events: CommittedEvent[]): Promise<void>;
	subscribe(channel: Channel, options?: SubscribeOptions): AsyncIterable<Delivery>;
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

/** The bus a process owns: the one that can be closed when the process stops. */
export interface OwnedEventBus extends EventBus {
	/**
	 * Stops listening to other processes and ends every subscription here.
	 *
	 * Ending them is what lets the process stop. A subscriber parks forever
	 * waiting for the next event, and behind each one is an open response
	 * holding a socket, so a server that closes without this waits on clients
	 * that are never going to hang up.
	 */
	close(): Promise<void>;
}

export interface EventBusOptions {
	store: EventStore;
	/** Without one, deliveries stay in this process: right for tests, wrong for a server. */
	relay?: EventRelay;
	maxBuffered?: number;
	log?: (message: string, cause: unknown) => void;
}

export function createEventBus({
	store,
	relay,
	maxBuffered = MAX_BUFFERED,
	log = console.error,
}: EventBusOptions): OwnedEventBus {
	const channels = new Map<Channel, Set<Subscriber>>();
	let closed = false;

	// Failing to tell the other processes must not fail the publish: the change
	// is committed and this process's subscribers have it.
	const broadcast = relay
		? (channel: Channel, delivery: Delivery) =>
				relay
					.broadcast(channel, delivery)
					.catch((cause) => log("Relaying an event to other processes failed", cause))
		: async () => {};
	const listening = relay
		? relay.listen(deliver).catch((cause) => {
				log("Listening for other processes' events failed; live updates are local only", cause);
				return async () => {};
			})
		: Promise.resolve(async () => {});

	/**
	 * One publish at a time per channel.
	 *
	 * ADR 001 promises ordering within a channel, and two overlapping publishes
	 * could otherwise take their sequence numbers in one order and reach
	 * subscribers in the other. Callers are expected to be a single writer per
	 * thread anyway (ADR 002); this makes the guarantee true regardless.
	 */
	const publishing = new Map<Channel, Promise<void>>();

	function serialize(channel: Channel, thread: () => Promise<void>): Promise<void> {
		const done = (publishing.get(channel) ?? Promise.resolve()).then(thread, thread);
		// The queue holds a promise that never rejects, so one failed publish
		// does not reject every publish queued behind it.
		const queued = done.catch(() => {});
		publishing.set(channel, queued);

		void queued.then(() => {
			if (publishing.get(channel) === queued) {
				publishing.delete(channel);
			}
		});

		return done;
	}

	function deliver(channel: Channel, delivery: Delivery): void {
		for (const subscriber of channels.get(channel) ?? []) {
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
		publish(channel, event) {
			return serialize(channel, async () => {
				const seq = isDurableEventType(event.type) ? await store.append(channel, event) : undefined;
				const delivery: Delivery = seq === undefined ? { event } : { seq, event };
				deliver(channel, delivery);
				// Inside the serialised publish so this channel's notices leave in
				// the order its events were numbered.
				await broadcast(channel, delivery);
			});
		},

		async publishCommitted(events) {
			await Promise.all(
				events.map((committed) =>
					serialize(committed.channel, async () => {
						const delivery: Delivery = { seq: committed.seq, event: committed.event };
						deliver(committed.channel, delivery);
						await broadcast(committed.channel, delivery);
					}),
				),
			);
		},

		async close() {
			closed = true;
			for (const subscribers of channels.values()) {
				for (const subscriber of subscribers) {
					subscriber.wake?.();
				}
			}
			const stop = await listening;
			await stop();
		},

		async *subscribe(channel, { since, signal } = {}) {
			// Registered before the replay reads a row, so an event published
			// during the replay is buffered rather than lost in the gap between
			// the last row read and the first live delivery.
			const subscriber: Subscriber = { queue: [], overflowed: false };
			const subscribers = channels.get(channel) ?? new Set<Subscriber>();
			subscribers.add(subscriber);
			channels.set(channel, subscribers);

			try {
				let replayed = since ?? 0;

				if (since !== undefined && since > 0) {
					if (await store.has(channel, since)) {
						// One row past the cap is how "too long to be worth
						// sending" is detected without a second query.
						const missed = await store.replay(channel, since, MAX_REPLAY + 1);

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
						// and an id from another channel, or an invented one,
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
					channels.delete(channel);
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
