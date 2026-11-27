export * as EventOutbox from "./outbox.ts";

import type { DurableEventType, EventStream, StreamEvent } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { processLayer, Tier } from "../../tiers.ts";
import {
	afterCommit,
	batchedBeforeCommit,
	type Database,
	type Executor,
	query,
	transaction,
} from "../database.ts";
import { event } from "../schema.ts";
import { EventBus } from "./bus.ts";

/**
 * Records events on the current transaction and delivers them once it
 * commits. A durable event is a row in the `event` table plus a delivery to
 * whoever is listening: the row commits or rolls back with the change it
 * describes, and the delivery waits for the commit, so a subscriber is never
 * told about a change that then rolled back.
 */
export interface Interface {
	readonly publish: (pending: readonly PendingEvent[]) => Effect.Effect<void, never, Database>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/EventOutbox") {
	declare readonly [Tier]: "process";
}

/**
 * An outbox whose events are delivered through the process's bus. Everything
 * a transaction publishes is stored together, just before it commits (see
 * `appendEvents`).
 */
export const make = Effect.map(EventBus.Service, (bus) => {
	const appendBeforeCommit = batchedBeforeCommit((pending: readonly PendingEvent[]) =>
		Effect.gen(function* () {
			const committed = yield* query((db) => appendEvents(db, pending));
			yield* afterCommit(Effect.promise(() => bus.publishCommitted(committed)));
		}),
	);
	return Service.of({ publish: (pending) => transaction(appendBeforeCommit(pending)) });
});

export const layer = processLayer(Layer.effect(Service, make));

export interface PendingEvent {
	stream: EventStream;
	event: StreamEvent & { type: DurableEventType };
}

export interface CommittedEvent extends PendingEvent {
	/** The row's position in the `event` table, and the SSE id clients resume from. */
	seq: number;
}

/**
 * Inserts the rows, holding a lock per stream until the transaction ends.
 *
 * The lock is what gives a stream's events one order: without it two
 * transactions could take sequence numbers in one order and commit in the
 * other, and a client resuming from the lower id would miss the higher one.
 * The database's `lock_event_streams` takes the locks, as the trigger that
 * stores `session.ended` when a session is deleted does too, in one order so
 * that transactions touching the same streams cannot deadlock.
 *
 * One statement, so one round trip: each row joins the locking's one row, so the locks are held
 * before any row takes its `seq`.
 */
const appendEvents = Effect.fn("EventOutbox.appendEvents")(function* (
	db: Executor,
	pending: readonly PendingEvent[],
) {
	if (pending.length === 0) return [];
	const rows = pending.map(({ stream, event }) => ({ stream, type: event.type, payload: event }));
	// Postgres numbers and returns the rows of one insert in the order given.
	const inserted = yield* db.execute<{ seq: string | number }>(
		sql`with pending as (
				select item, ordinal
				from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) with ordinality as given(item, ordinal)
			),
			locked as materialized (
				select lock_event_streams(array(select item ->> 'stream' from pending))
			)
			insert into ${event} ("stream", "type", "payload")
			select item ->> 'stream', item ->> 'type', item -> 'payload'
			from pending cross join locked
			order by ordinal
			returning "seq"`,
		"objects",
	);
	return pending.map((pendingEvent, index): CommittedEvent => {
		const row = inserted[index];
		if (!row) throw new Error(`Storing a ${pendingEvent.event.type} returned no row`);
		return { ...pendingEvent, seq: Number(row.seq) };
	});
});
