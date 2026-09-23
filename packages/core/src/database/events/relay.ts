import { randomUUID } from "node:crypto";
import type { Channel, StreamEvent } from "@sugabots/contracts";
import type { Notification, Pool, PoolClient } from "pg";
import type { Delivery } from "./bus.ts";
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
	broadcast(channel: Channel, delivery: Delivery): Promise<void>;
	/**
	 * Hands over what other processes broadcast, until the returned function is
	 * called. Resolves once listening, so nothing published after that is missed.
	 */
	listen(receive: (channel: Channel, delivery: Delivery) => void): Promise<() => Promise<void>>;
}

/** The Postgres notification channel every process listens on. */
const NOTIFY_CHANNEL = "sugabots_events";

/**
 * Postgres caps a notification payload at 8000 bytes. Under this a delivery
 * travels whole; over it, a durable event travels as its `seq` and is read
 * back from the store, and an ephemeral one is not relayed at all.
 */
const MAX_NOTICE_BYTES = 7_000;

const RECONNECT_DELAY_MS = 1_000;

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
 */
export function postgresEventRelay(
	pool: Pool,
	store: Pick<EventStore, "replay">,
	{ log = console.error }: { log?: (message: string, cause: unknown) => void } = {},
): EventRelay {
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
			await pool.query("select pg_notify($1, $2)", [NOTIFY_CHANNEL, notice]);
		},

		async listen(receive) {
			let closed = false;
			let client: PoolClient | undefined;
			let reconnecting: ReturnType<typeof setTimeout> | undefined;

			const onNotification = (notification: Notification) => {
				void deliverNotice(notification.payload).catch((cause) =>
					log("Relaying an event from another process failed", cause),
				);
			};

			async function deliverNotice(payload: string | undefined) {
				if (!payload) return;
				const notice = JSON.parse(payload) as Notice;
				if (notice.from === origin) return;
				const event = notice.event ?? (await storedEvent(notice));
				if (!event) return;
				receive(notice.channel, notice.seq === undefined ? { event } : { seq: notice.seq, event });
			}

			async function storedEvent({ channel, seq }: Notice): Promise<StreamEvent | undefined> {
				if (seq === undefined) return undefined;
				const [stored] = await store.replay(channel, seq - 1, 1);
				return stored?.seq === seq ? stored.event : undefined;
			}

			// A dropped connection is replaced rather than surfaced: the process
			// keeps serving its own events meanwhile, and rejoins when it can.
			async function connect(): Promise<void> {
				const connected = await pool.connect();
				connected.on("notification", onNotification);
				connected.once("error", (cause) => {
					log("Event relay connection lost", cause);
					connected.release(true);
					if (client === connected) {
						client = undefined;
						reconnectLater();
					}
				});
				try {
					await connected.query(`listen ${NOTIFY_CHANNEL}`);
				} catch (cause) {
					connected.release(true);
					throw cause;
				}
				client = connected;
			}

			function reconnectLater(): void {
				if (closed || reconnecting) return;
				reconnecting = setTimeout(() => {
					reconnecting = undefined;
					void connect().catch((cause) => {
						log("Event relay could not reconnect", cause);
						reconnectLater();
					});
				}, RECONNECT_DELAY_MS);
			}

			await connect();

			return async () => {
				closed = true;
				clearTimeout(reconnecting);
				const open = client;
				client = undefined;
				if (open) {
					open.off("notification", onNotification);
					await open.query(`unlisten ${NOTIFY_CHANNEL}`).catch(() => {});
					open.release();
				}
			};
		},
	};
}
