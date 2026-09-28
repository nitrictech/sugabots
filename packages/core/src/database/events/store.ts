export * as EventStore from "./store.ts";

import type { Channel, StreamEvent } from "@sugabots/contracts";
import { and, asc, count, eq, gt, lt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { type Database, type Executor, type QueryFailure, query } from "../database.ts";
import { event } from "../schema.ts";

/**
 * Where durable events are kept between a disconnect and a reconnect.
 *
 * An interface rather than a handful of queries because the bus above it has
 * nothing else to say to the database, and because a store that lives in memory
 * lets the bus, the routes and the client be tested end to end without one.
 * `make` is the real thing; `inMemory` is the same contract, for tests.
 */
export interface Interface {
	/** Persists an event on a channel and returns its `seq`. */
	append(channel: Channel, event: StreamEvent): Promise<number>;

	/** Events on a channel after `since`, oldest first, at most `limit` of them. */
	replay(channel: Channel, since: number, limit: number): Promise<Stored[]>;

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

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/EventStore") {}

/**
 * The store on the database the Effect is run with. Its methods are promises
 * because the bus above it is, so it keeps the context it was built in to run
 * its queries on.
 */
export const make: Effect.Effect<Interface, never, Database> = Effect.gen(function* () {
	const context = yield* Effect.context<Database>();
	const run = <A>(statement: (db: Executor) => Effect.Effect<A, QueryFailure>) =>
		Effect.runPromiseWith(context)(query(statement));

	return {
		async append(channel, payload) {
			const [row] = await run((db) =>
				db
					.insert(event)
					.values({ channel, type: payload.type, payload })
					.returning({ seq: event.seq }),
			);

			if (!row) {
				throw new Error(`Storing a ${payload.type} on ${channel} returned no row`);
			}
			return row.seq;
		},

		async replay(channel, since, limit) {
			const rows = await run((db) =>
				db
					.select({ seq: event.seq, payload: event.payload })
					.from(event)
					.where(and(eq(event.channel, channel), gt(event.seq, since)))
					.orderBy(asc(event.seq))
					.limit(limit),
			);

			return rows.map((row) => ({ seq: row.seq, event: row.payload }));
		},

		async has(channel, seq) {
			const rows = await run((db) =>
				db
					.select({ seq: event.seq })
					.from(event)
					.where(and(eq(event.channel, channel), eq(event.seq, seq)))
					.limit(1),
			);

			return rows.length > 0;
		},

		async prune(before) {
			// The count, not the rows. A week of events is the largest result set
			// this process would ever pull back, and it was only being counted.
			const [counted] = await run((db) => {
				const deleted = db
					.$with("deleted")
					.as(db.delete(event).where(lt(event.createdAt, before)).returning({ seq: event.seq }));
				return db.with(deleted).select({ removed: count() }).from(deleted);
			});
			return counted?.removed ?? 0;
		},
	};
});

export const layer = Layer.effect(Service, make);

/** A durable event as it was stored, with the `seq` clients resume from. */
export interface Stored {
	seq: number;
	event: StreamEvent;
}

interface MemoryRow extends Stored {
	channel: Channel;
	createdAt: Date;
}

export interface InMemoryOptions {
	/** The clock rows are stamped with. Only pruning reads it, and only a test
	 * ever needs to move it. */
	now?: () => Date;
}

/**
 * The same store, in an array. Sequence numbers are global and monotonic here
 * too, so anything that depends on ordering behaves as it does in Postgres.
 */
export function inMemory({ now = () => new Date() }: InMemoryOptions = {}): Interface {
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
