export * as EventStore from "./store.ts";

import type { DurableEventType, EventStream, StreamEvent } from "@sugabots/contracts";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { processLayer, Tier } from "../../tiers.ts";
import {
	type Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../database.ts";
import { CONTROL_EVENT_TYPES, event, eventRetention, isControlEvent } from "./sql.ts";

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

	/** The starting cursor for each distinct stream, taken together before following them. */
	latest(
		streams: ReadonlyArray<EventStream>,
		signal?: AbortSignal,
	): Promise<Map<EventStream, number>>;

	/** resume reads the first batch, or returns undefined if cursor cannot be replayed. */
	resume(
		stream: EventStream,
		cursor: number,
		limit: number,
		controls?: ReadonlyArray<Feed>,
	): Promise<StoredOn[] | undefined>;

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
			const rows = await run((db) => followingRows(db, feeds, limit));
			return rows.map(({ seq, stream, payload }) => ({ seq, stream, event: payload }));
		},

		async latest(streams, signal) {
			if (streams.length === 0) return new Map();
			const wanted = sql`array[${sql.join(
				streams.map((stream) => sql`${stream}`),
				sql`, `,
			)}]::text[]`;
			const rows = await Effect.runPromiseWith(context)(
				transaction(
					Effect.gen(function* () {
						// A writer can reserve a sequence number before its event is visible.
						// Wait for writers on these streams before taking the read snapshot.
						yield* query((db) =>
							db.execute(
								sql`select pg_advisory_xact_lock_shared(hashtextextended(stream, 0))
								from (select distinct stream collate "C" as stream from unnest(${wanted}) as stream
									order by stream) as ordered`,
								"objects",
							),
						);
						return yield* query((db) =>
							db.execute<{ stream: EventStream; cursor: string | number }>(
								sql`select stream, coalesce(
									(select max(${event.seq}) from ${event}
										where ${event.stream} = wanted.stream and ${event.seq} >= (${retentionBoundary})),
									-(${sequencePosition}) - 1
								) as cursor
								from (select distinct stream from unnest(${wanted}) as stream) as wanted`,
								"objects",
							),
						);
					}),
				),
				{ signal },
			);
			return new Map(rows.map(({ stream, cursor }) => [stream, Number(cursor)]));
		},

		async resume(stream, cursor, limit, controls = []) {
			const position = afterCursor(cursor);
			const retained = sql`${position} >= (${retentionBoundary}) and ${
				cursor <= 0
					? sql`${position} <= (${sequencePosition}) and not exists (
						select 1 from ${event} where ${event.stream} = ${stream}
						and ${event.seq} between (${retentionBoundary}) and ${position}
					)`
					: sql`exists (
						select 1 from ${event} as anchor where anchor.seq = ${cursor}
						and (anchor.stream = ${stream} or not exists (
							select 1 from ${event} where ${event.stream} = ${stream}
							and ${event.seq} <= ${position}
						))
					)`
			}`;
			const rows = await run((db) => {
				const batch = followingRows(db, [{ stream, since: position }, ...controls], limit);
				return db.execute<{
					retained: boolean;
					seq: string | null;
					stream: EventStream;
					payload: StreamEvent;
				}>(
					sql`select retained, batch.* from (select ${retained} as retained) as resume
						left join lateral (${batch}) as batch on retained order by batch.seq`,
					"objects",
				);
			});
			if (!rows[0]?.retained) return undefined;
			return rows.flatMap(({ seq, stream, payload }) =>
				seq === null ? [] : [{ seq: Number(seq), stream, event: payload }],
			);
		},

		async prune(before) {
			const [row] = await run((db) =>
				db.execute<{ removed: number }>(
					sql`with deleted as (
						delete from ${event} where ${event.createdAt} < ${before.toISOString()}::timestamptz
						returning seq
					), counted as (
						select count(*)::integer as removed, max(seq) as pruned_through from deleted
					), saved as (
						insert into ${eventRetention} (singleton, pruned_through)
						select true, pruned_through from counted where pruned_through is not null
						on conflict (singleton) do update
						set pruned_through = greatest(${eventRetention}.pruned_through, excluded.pruned_through)
					)
					select removed from counted`,
					"objects",
				),
			);
			return row?.removed ?? 0;
		},
	};
});

export const layer = processLayer(Layer.effect(Service, make));

const sequencePosition = sql`select case when is_called then last_value else 0 end from event_seq_seq`;

// Pruning records one watermark across streams, so a gap can conservatively reset another stream.
const retentionBoundary = sql`select coalesce((select pruned_through from ${eventRetention}), 0)`;

function followingRows(db: Executor, feeds: readonly Feed[], limit: number) {
	return db
		.select({
			seq: event.seq,
			stream: sql<EventStream>`${event.stream}`.as("stream"),
			payload: event.payload,
		})
		.from(event)
		.where(
			or(
				...feeds.map(({ stream, since, types }) =>
					and(eq(event.stream, stream), gt(event.seq, since), typesInFeed(types)),
				),
			),
		)
		.orderBy(asc(event.seq))
		.limit(limit);
}

/** afterCursor returns the sequence position to read after, including a cursor without a retained event. */
export function afterCursor(cursor: number): number {
	return cursor < 0 ? -cursor - 1 : cursor;
}

/** A durable event as it was stored, with the `seq` clients resume from. */
export interface Stored {
	seq: number;
	event: StreamEvent;
}

/** A stored event, and the stream it is on. */
export interface StoredOn extends Stored {
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
