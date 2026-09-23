import type { Channel, StreamEvent } from "@sugabots/contracts";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { event } from "../schema.ts";

/**
 * Where durable events are kept between a disconnect and a reconnect.
 *
 * An interface rather than a handful of queries because the bus above it has
 * nothing else to say to the database, and because a store that lives in memory
 * lets the bus, the routes and the client be tested end to end without one.
 * `postgresEventStore` is the real thing; `memoryEventStore` is the same
 * contract for tests and for a process that has no need to survive a restart.
 */

/** A durable event as it was stored, with the `seq` clients resume from. */
export interface StoredEvent {
	seq: number;
	event: StreamEvent;
}

export interface EventStore {
	/** Persists an event on a channel and returns its `seq`. */
	append(channel: Channel, event: StreamEvent): Promise<number>;

	/** Events on a channel after `since`, oldest first, at most `limit` of them. */
	replay(channel: Channel, since: number, limit: number): Promise<StoredEvent[]>;

	/**
	 * Whether the event a client claims to have last seen is still here.
	 *
	 * This is how a resume point is judged, rather than comparing it to the
	 * oldest surviving `seq`: the sequence is global, so a channel's ids have
	 * gaps that say nothing about what was pruned. If the row a client names is
	 * gone, its history is broken and it needs a `reset`.
	 */
	has(channel: Channel, seq: number): Promise<boolean>;

	/** Drops events older than `before`. Returns how many went. */
	prune(before: Date): Promise<number>;
}

export function postgresEventStore(db: NodePgDatabase): EventStore {
	return {
		async append(channel, payload) {
			const [row] = await db
				.insert(event)
				.values({ channel, type: payload.type, payload })
				.returning({ seq: event.seq });

			if (!row) {
				throw new Error(`Storing a ${payload.type} on ${channel} returned no row`);
			}
			return row.seq;
		},

		async replay(channel, since, limit) {
			const rows = await db
				.select({ seq: event.seq, payload: event.payload })
				.from(event)
				.where(and(eq(event.channel, channel), gt(event.seq, since)))
				.orderBy(asc(event.seq))
				.limit(limit);

			return rows.map((row) => ({ seq: row.seq, event: row.payload }));
		},

		async has(channel, seq) {
			const rows = await db
				.select({ seq: event.seq })
				.from(event)
				.where(and(eq(event.channel, channel), eq(event.seq, seq)))
				.limit(1);

			return rows.length > 0;
		},

		async prune(before) {
			// The count, not the rows. A week of events is the largest result set
			// this process would ever pull back, and it was only being counted.
			const deleted = await db.delete(event).where(lt(event.createdAt, before));
			return deleted.rowCount ?? 0;
		},
	};
}

interface MemoryRow extends StoredEvent {
	channel: Channel;
	createdAt: Date;
}

export interface MemoryEventStoreOptions {
	/** The clock rows are stamped with. Only pruning reads it, and only a test
	 * ever needs to move it. */
	now?: () => Date;
}

/**
 * The same store, in an array. Sequence numbers are global and monotonic here
 * too, so anything that depends on ordering behaves as it does in Postgres.
 */
export function memoryEventStore({
	now = () => new Date(),
}: MemoryEventStoreOptions = {}): EventStore {
	const rows: MemoryRow[] = [];
	let next = 0;

	return {
		async append(channel, event) {
			next += 1;
			rows.push({ seq: next, channel, event, createdAt: now() });
			return next;
		},

		async replay(channel, since, limit) {
			return rows
				.filter((row) => row.channel === channel && row.seq > since)
				.slice(0, limit)
				.map(({ seq, event }) => ({ seq, event }));
		},

		async has(channel, seq) {
			return rows.some((row) => row.channel === channel && row.seq === seq);
		},

		async prune(before) {
			const survivors = rows.filter((row) => row.createdAt >= before);
			const removed = rows.length - survivors.length;
			rows.splice(0, rows.length, ...survivors);
			return removed;
		},
	};
}
