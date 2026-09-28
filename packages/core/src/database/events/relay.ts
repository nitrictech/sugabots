import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import type { Channel, StreamEvent } from "@sugabots/contracts";
import { Deferred, Duration, Effect, Fiber, Queue } from "effect";
import type { EventBus } from "./bus.ts";
import type { EventStore } from "./store.ts";

/**
 * How one process's deliveries reach the subscribers of another.
 *
 * Every API process has its own bus, and any of them may run the worker that
 * makes a change. Without a relay a client streaming from one process, or a
 * tool waiting in it, never hears about a turn another process ran. This is
 * the seam ADR 001 left for that: Postgres `NOTIFY` for the wake-up, the
 * `event` table for a payload too large to carry.
 */
export interface EventRelay {
	/** Tells every other process about a delivery this one has already made locally. */
	broadcast(channel: Channel, delivery: EventBus.Delivery): Promise<void>;
	/**
	 * Hands over what other processes broadcast, until the returned function is
	 * called. Resolves once listening, so nothing published after that is missed.
	 */
	listen(
		receive: (channel: Channel, delivery: EventBus.Delivery) => void,
	): Promise<() => Promise<void>>;
}

/** The Postgres notification channel every process listens on. */
const NOTIFY_CHANNEL = "sugabots_events";

/**
 * Postgres caps a notification payload at 8000 bytes. Under this a delivery
 * travels whole; over it, a durable event travels as its `seq` and is read
 * back from the store, and an ephemeral one is not relayed at all.
 */
const MAX_NOTICE_BYTES = 7_000;

const RECONNECT_DELAY = Duration.seconds(1);

/** What travels in a notification. `event` is absent when it did not fit. */
interface Notice {
	from: string;
	channel: Channel;
	seq?: number;
	event?: StreamEvent;
}

/**
 * The relay over the process's own pool. Listening holds one of the pool's
 * connections for as long as it runs; broadcasting borrows one per notice.
 * Its methods are promises because the bus is, so it keeps the context it
 * was built in to run on.
 */
export const postgresEventRelay = (
	store: Pick<EventStore.Interface, "replay">,
	{ log = console.error }: { log?: (message: string, cause: unknown) => void } = {},
): Effect.Effect<EventRelay, never, PgClient.PgClient> =>
	Effect.gen(function* () {
		const client = yield* PgClient.PgClient;
		const context = yield* Effect.context<never>();
		const runPromise = Effect.runPromiseWith(context);
		/** Identifies this process, so it can ignore its own notices coming back. */
		const origin = randomUUID();

		return {
			async broadcast(channel, delivery) {
				const whole: Notice = { from: origin, channel, seq: delivery.seq, event: delivery.event };
				let notice = JSON.stringify(whole);
				if (Buffer.byteLength(notice) > MAX_NOTICE_BYTES) {
					if (delivery.seq === undefined) {
						// A delta this large is rare, and the durable event that follows
						// it carries the whole text anyway.
						return;
					}
					notice = JSON.stringify({ from: origin, channel, seq: delivery.seq } satisfies Notice);
				}
				await runPromise(client.notify(NOTIFY_CHANNEL, notice));
			},

			async listen(receive) {
				async function deliverNotice(payload: string) {
					const notice = JSON.parse(payload) as Notice;
					if (notice.from === origin) return;
					const event = notice.event ?? (await storedEvent(notice));
					if (!event) return;
					receive(
						notice.channel,
						notice.seq === undefined ? { event } : { seq: notice.seq, event },
					);
				}

				async function storedEvent({ channel, seq }: Notice): Promise<StreamEvent | undefined> {
					if (seq === undefined) return undefined;
					const [stored] = await store.replay(channel, seq - 1, 1);
					return stored?.seq === seq ? stored.event : undefined;
				}

				const relayNotice = (payload: string) =>
					Effect.promise(() =>
						deliverNotice(payload).catch((cause) =>
							log("Relaying an event from another process failed", cause),
						),
					);

				const listening = Deferred.makeUnsafe<void, unknown>();

				/**
				 * One connection's worth of listening. It ends when the connection
				 * does, which shuts the queue.
				 */
				const session = Effect.scoped(
					Effect.gen(function* () {
						const notifications = yield* client.listen(NOTIFY_CHANNEL);
						yield* Deferred.succeed(listening, undefined);
						return yield* Effect.forever(
							Effect.flatMap(Queue.take(notifications), ({ payload }) => relayNotice(payload)),
						);
					}),
				);

				// A dropped connection is replaced rather than surfaced: the process
				// keeps serving its own events meanwhile, and rejoins when it can. The
				// first connection is the exception, so the caller learns that
				// listening never started.
				const relaying = Effect.forever(
					session.pipe(
						Effect.catchCause((cause) =>
							Effect.gen(function* () {
								if (yield* Deferred.failCause(listening, cause)) return;
								log("Event relay connection lost", cause);
								yield* Effect.sleep(RECONNECT_DELAY);
							}),
						),
					),
				);

				const fiber = Effect.runForkWith(context)(relaying);
				try {
					await runPromise(Deferred.await(listening));
				} catch (cause) {
					await runPromise(Fiber.interrupt(fiber));
					throw cause;
				}
				return () => runPromise(Fiber.interrupt(fiber));
			},
		} satisfies EventRelay;
	});
