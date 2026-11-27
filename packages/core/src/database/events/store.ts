export * as EventStore from "./store.ts";

import { createHash } from "node:crypto";
import type { DurableEventType, EventStream, StreamEvent } from "@sugabots/contracts";
import type { StreamCursor } from "@sugabots/contracts/operations/events";
import { and, asc, gt, gte, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { Context, Effect, Layer, Random } from "effect";
import { processLayer, Tier } from "../../tiers.ts";
import {
	type Database,
	type Executor,
	type QueryFailure,
	query,
	transaction,
} from "../database.ts";
import { CONTROL_EVENT_TYPES, event, eventRetention, isControlEvent } from "./sql.ts";

/** Durable events that streams read after a disconnect and while following. */
export interface Interface {
	/** Events on a stream after `since`, oldest first, at most `limit` of them. */
	replay(
		stream: EventStream,
		since: number,
		limit: number,
		signal?: AbortSignal,
	): Promise<Stored[]>;

	/**
	 * Events on several streams, each after its own `since` and, where it says,
	 * only of its `types`, oldest first across them all, at most `limit`.
	 * Within one stream events commit in the order of their `seq`, so a reader
	 * that moves each stream's `since` to the last event it read misses none;
	 * and an event committed before another was stored has the lower `seq`, so
	 * one read in this order is read before anything stored after it.
	 */
	following(feeds: ReadonlyArray<Feed>, limit: number, signal?: AbortSignal): Promise<StoredOn[]>;

	/** The starting cursor for each distinct stream, taken together before following them. */
	latest(
		streams: ReadonlyArray<EventStream>,
		signal?: AbortSignal,
	): Promise<Map<EventStream, StreamCursor>>;

	/** replayPage reads a batch through page.through if given, or returns undefined for an unusable starting position. */
	replayPage(
		page: ReplayPage,
		limit: number,
		signal?: AbortSignal,
	): Promise<StoredOn[] | undefined>;

	/** Drops events older than `before`. Returns how many went. */
	prune(before: Date): Promise<number>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/EventStore") {
	declare readonly [Tier]: "process";
}

export const make: Effect.Effect<Interface, never, Database> = Effect.gen(function* () {
	const context = yield* Effect.context<Database>();
	const runPromise = Effect.runPromiseWith(context);
	const run = <A>(
		statement: (db: Executor) => Effect.Effect<A, QueryFailure>,
		signal?: AbortSignal,
	) => runPromise(query(statement), { signal });
	const following: Interface["following"] = async (feeds, limit, signal) => {
		if (feeds.length === 0) return [];
		const rows = await run(
			(db) => db.execute<EventRow>(selectFeedRows(db, feeds, limit), "objects"),
			signal,
		);
		return rows.map(({ seq, stream, payload }) => ({ seq: Number(seq), stream, event: payload }));
	};

	return {
		async replay(stream, since, limit, signal) {
			const rows = await following([{ stream, since }], limit, signal);
			return rows.map(({ seq, event }) => ({ seq, event }));
		},

		following,

		async latest(streams, signal) {
			if (streams.length === 0) return new Map();
			const wanted = sql`array[${sql.join(
				streams.map((stream) => sql`${stream}`),
				sql`, `,
			)}]::text[]`;
			const attempt = transaction(
				Effect.gen(function* () {
					// Writers can reserve sequence numbers before their events are visible.
					// Take a fresh snapshot after locking every stream.
					const [locks] = yield* query((db) =>
						db.execute<{ acquired: boolean }>(
							sql`select bool_and(pg_try_advisory_xact_lock_shared(hashtextextended(stream, 0))) as acquired
								from (select distinct stream collate "C" as stream from unnest(${wanted}) as stream
									order by stream) as ordered`,
							"objects",
						),
					);
					if (!locks?.acquired) return undefined;
					return yield* query((db) =>
						db.execute<{ stream: EventStream; seq: string | null; position: string }>(
							sql`select stream,
								(select max(${event.seq}) from ${event}
									where ${event.stream} = wanted.stream and ${event.seq} >= (${retentionBoundary(sql`wanted.stream`)})) as seq,
								(${sequencePosition}) as position
							from (select distinct stream from unnest(${wanted}) as stream) as wanted`,
							"objects",
						),
					);
				}),
			);
			const rows = await runPromise(
				Effect.gen(function* () {
					while (true) {
						const starts = yield* attempt;
						if (starts !== undefined) return starts;
						// The attempt has returned its connection and released any locks it took.
						const retryAfterMillis = yield* Random.nextIntBetween(100, 250);
						yield* Effect.sleep(retryAfterMillis);
					}
				}),
				{ signal },
			);
			return new Map(
				rows.map(({ stream, seq, position }) => [
					stream,
					seq === null ? buildEmptyCursor(stream, Number(position)) : Number(seq),
				]),
			);
		},

		async replayPage(page, limit, signal) {
			const feed =
				"cursor" in page ? { stream: page.stream, since: afterCursor(page.cursor) } : page.feed;
			if (!Number.isSafeInteger(feed.since)) return undefined;

			const retained = sql`${feed.since} >= (${retentionBoundary(feed.stream)}) and ${validReplayPosition(page)}`;
			const rows = await run((db) => {
				const batch = selectFeedRows(db, [feed, ...page.controls], limit, page.through);
				return db.execute<Omit<EventRow, "seq"> & { retained: boolean; seq: string | null }>(
					sql`select retained, batch.* from (select ${retained} as retained) as replay
						left join lateral (${batch}) as batch on retained order by batch.seq`,
					"objects",
				);
			}, signal);
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
						returning stream, seq
					), saved as (
						insert into ${eventRetention} (stream, pruned_through)
						select stream, max(seq) from deleted group by stream order by stream collate "C"
						on conflict (stream) do update
						set pruned_through = greatest(${eventRetention}.pruned_through, excluded.pruned_through)
					)
					select count(*)::integer as removed from deleted`,
					"objects",
				),
			);
			return row?.removed ?? 0;
		},
	};
});

export const layer = processLayer(Layer.effect(Service, make));

const sequencePosition = sql`select case when is_called then last_value else 0 end from event_seq_seq`;

const retentionBoundary = (stream: EventStream | SQL) =>
	sql`select coalesce((
		select ${eventRetention.prunedThrough} from ${eventRetention}
		where ${eventRetention.stream} = ${stream}
	), 0)`;

function validReplayPosition(page: ReplayPage) {
	if ("feed" in page) return sql`true`;
	const { stream, cursor } = page;
	if (typeof cursor === "number") {
		return sql`exists (
			select 1 from ${event} where ${event.seq} = ${cursor} and ${event.stream} = ${stream}
		)`;
	}
	const position = afterCursor(cursor);
	if (cursor !== buildEmptyCursor(stream, position)) return sql`false`;
	return sql`${position} <= (${sequencePosition}) and not exists (
		select 1 from ${event} where ${event.stream} = ${stream}
		and ${event.seq} between (${retentionBoundary(stream)}) and ${position}
	)`;
}

const eventSelection = {
	seq: event.seq,
	stream: sql<EventStream>`${event.stream}`.as("stream"),
	payload: event.payload,
};

interface EventRow {
	seq: string;
	stream: EventStream;
	payload: StreamEvent;
}

function selectFeedRows(db: Executor, feeds: readonly Feed[], limit: number, through?: number) {
	// Overlapping feeds on the same stream must still return each event once.
	const batches = [...Map.groupBy(feeds, (feed) => feed.stream)].map(([stream, sameStream]) => {
		const batch = db
			.select(eventSelection)
			.from(event)
			.where(
				and(
					// Keep stream in the index order. An equality would let Postgres
					// drop it from ORDER BY and scan the global sequence index.
					gte(event.stream, stream),
					lte(event.stream, stream),
					through === undefined ? undefined : lte(event.seq, through),
					or(...sameStream.map(matchesFeed)),
				),
			)
			.orderBy(asc(event.stream), asc(event.seq))
			.limit(limit);
		return sql`(${batch})`;
	});
	const combined = sql.join(batches, sql` union all `);
	return batches.length === 1 ? combined : sql`${combined} order by seq limit ${limit}`;
}

function matchesFeed({ since, types }: Feed) {
	return and(gt(event.seq, since), typesInFeed(types));
}

/** afterCursor returns the sequence position to read after, including a cursor without a retained event. */
export function afterCursor(cursor: StreamCursor): number {
	return typeof cursor === "number" ? cursor : Number(cursor.split(".")[1]);
}

export function buildEmptyCursor(stream: EventStream, position: number): StreamCursor {
	return `empty.${position}.${createHash("sha256").update(stream).digest("hex")}`;
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

/** The client's cursor for the first page, or the stream's read position for later pages. */
export type ReplayPage = (
	| {
			readonly stream: EventStream;
			readonly cursor: StreamCursor;
	  }
	| { readonly feed: Feed }
) & {
	readonly controls: readonly Feed[];
	readonly through?: number;
};

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
