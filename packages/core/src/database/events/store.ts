export * as EventStore from "./store.ts";

import type { DurableEventType, EventStream, StreamEvent } from "@sugabots/contracts";
import { and, asc, count, eq, gt, inArray, lt, lte, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Effect, Layer } from "effect";
import { processLayer, Tier } from "../../tiers.ts";
import {
	type Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../database.ts";
import { CONTROL_EVENT_TYPES, event, isControlEvent } from "./sql.ts";

/**
 * Where durable events are read back between a disconnect and a reconnect.
 * `EventOutbox` writes them, on the transaction that made the change.
 *
 * An interface rather than a handful of queries because the bus above it has
 * nothing else to say to the database, and because a store that lives in memory
 * lets the bus, the routes and the client be tested end to end without one.
 * `make` is the real thing; `inMemoryEventStore` in `testing.ts` is the same contract, for tests.
 */
export interface Interface {
	/** Events on a stream after `since`, oldest first, at most `limit` of them. */
	replay(stream: EventStream, since: number, limit: number): Promise<Stored[]>;

	/**
	 * Events on several streams, each after its own `since` and, where it says,
	 * only of its `types`, oldest first across them all, at most `limit`.
	 * Within one stream events commit in the order of their `seq`, so a reader
	 * that moves each stream's `since` to the last event it read misses none;
	 * and an event committed before another was stored has the lower `seq`, so
	 * one read in this order is read before anything stored after it.
	 */
	following(feeds: ReadonlyArray<Feed>, limit: number): Promise<StoredOn[]>;

	/**
	 * Where the stream is now: the `seq` of its newest event, or, when it has
	 * none, of the newest event on any stream, after which everything stored on
	 * it is new. 0 only while no event is stored at all.
	 */
	latest(stream: EventStream): Promise<number>;

	/**
	 * Whether a client that last saw `seq` on the stream can resume after it:
	 * the event at `seq` is still here, and is the stream's, or is where
	 * `latest` put the stream while it had nothing stored.
	 *
	 * This is how a resume point is judged, rather than comparing it to the
	 * oldest surviving `seq`: the sequence is global, so a stream's ids have
	 * gaps that say nothing about what was pruned. Events are pruned oldest
	 * first, so if the row a client names is gone, so may be what came after
	 * it: its history is broken and it needs a `reset`.
	 */
	has(stream: EventStream, seq: number): Promise<boolean>;

	/** Drops events older than `before`. Returns how many went. */
	prune(before: Date): Promise<number>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/EventStore") {
	declare readonly [Tier]: "process";
}

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
		async replay(stream, since, limit) {
			const rows = await run((db) =>
				db
					.select({ seq: event.seq, payload: event.payload })
					.from(event)
					.where(and(eq(event.stream, stream), gt(event.seq, since)))
					.orderBy(asc(event.seq))
					.limit(limit),
			);

			return rows.map((row) => ({ seq: row.seq, event: row.payload }));
		},

		async following(feeds, limit) {
			if (feeds.length === 0) return [];
			const rows = await run((db) =>
				db
					.select({ seq: event.seq, stream: event.stream, payload: event.payload })
					.from(event)
					.where(
						or(
							...feeds.map(({ stream, since, types }) =>
								and(eq(event.stream, stream), gt(event.seq, since), typesInFeed(types)),
							),
						),
					)
					.orderBy(asc(event.seq))
					.limit(limit),
			);
			return rows.map((row) => ({
				seq: row.seq,
				stream: row.stream as EventStream,
				event: row.payload,
			}));
		},

		async latest(stream) {
			const [row] = await Effect.runPromiseWith(context)(
				transaction(
					Effect.gen(function* () {
						// Waits for any event being stored on the stream to commit: one stored
						// next takes a `seq` above every event committed by then.
						yield* query((db) =>
							db.execute(sql`select lock_event_streams(array[${stream}]::text[])`, "objects"),
						);
						return yield* query((db) =>
							db.execute<{ seq: string | number }>(
								sql`select coalesce(
									(select max(${event.seq}) from ${event} where ${event.stream} = ${stream}),
									(select max(${event.seq}) from ${event}),
									0
								) as seq`,
								"objects",
							),
						);
					}),
				),
			);
			return Number(row?.seq ?? 0);
		},

		async has(stream, seq) {
			const earlier = alias(event, "earlier");
			const rows = await run((db) =>
				db
					.select({ seq: event.seq })
					.from(event)
					.where(
						and(
							eq(event.seq, seq),
							or(
								eq(event.stream, stream),
								notExists(
									db
										.select({ seq: earlier.seq })
										.from(earlier)
										.where(and(eq(earlier.stream, stream), lte(earlier.seq, seq))),
								),
							),
						),
					)
					.limit(1),
			);

			return rows.length > 0;
		},

		async prune(before) {
			// The count, not the rows: a week of events is the largest result set
			// this process would ever pull back, and only its size is wanted.
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

export const layer = processLayer(Layer.effect(Service, make));

/** A durable event as it was stored, with the `seq` clients resume from. */
export interface Stored {
	seq: number;
	event: StreamEvent;
}

/** A stored event, and the stream it is on. */
interface StoredOn extends Stored {
	stream: EventStream;
}

/** One stream to read, after `since`, and only `types` of its events where given. */
export interface Feed {
	readonly stream: EventStream;
	readonly since: number;
	readonly types?: ReadonlyArray<DurableEventType>;
}

function typesInFeed(types: readonly DurableEventType[] | undefined) {
	if (types === undefined) return undefined;
	if (
		types.length === CONTROL_EVENT_TYPES.length &&
		CONTROL_EVENT_TYPES.every((type) => types.includes(type))
	) {
		return isControlEvent(event.type);
	}
	return inArray(event.type, [...types]);
}
