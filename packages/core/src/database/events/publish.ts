import type { Channel, DurableEventType, StreamEvent } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { afterCommit, type Database, type Executor, query, transaction } from "../database.ts";
import { event } from "../schema.ts";
import type { EventBus } from "./bus.ts";

/**
 * How a store announces what it wrote.
 *
 * A durable event is a row in the `event` table plus a delivery to whoever is
 * listening. The row goes in on the caller's transaction, so it commits or
 * rolls back with the change it describes; the delivery waits for the commit,
 * so a subscriber is never told about a change that then rolled back.
 */

export interface PendingEvent {
	channel: Channel;
	event: StreamEvent & { type: DurableEventType };
}

export interface CommittedEvent extends PendingEvent {
	/** The row's position in the `event` table, and the SSE id clients resume from. */
	seq: number;
}

/** Records events on the current transaction and delivers them once it commits. */
export type PublishEvents = (pending: PendingEvent[]) => Effect.Effect<void, never, Database>;

export function eventPublisher(bus: Pick<EventBus, "publishCommitted">): PublishEvents {
	return (pending) =>
		transaction(
			Effect.gen(function* () {
				const committed = yield* query((db) => appendEvents(db, pending));
				yield* afterCommit(Effect.promise(() => bus.publishCommitted(committed)));
			}),
		);
}

/**
 * Inserts the rows, holding a lock per channel until the transaction ends.
 *
 * The lock is what gives a channel's events one order: without it two
 * transactions could take sequence numbers in one order and commit in the
 * other, and a client resuming from the lower id would miss the higher one.
 * Channels are locked in sorted order so two transactions touching the same
 * pair cannot deadlock.
 */
const appendEvents = Effect.fn("EventPublisher.appendEvents")(function* (
	db: Executor,
	pending: PendingEvent[],
) {
	for (const channel of [...new Set(pending.map(({ channel }) => channel))].sort()) {
		yield* db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${channel}, 0))`);
	}

	if (pending.length === 0) return [];
	// Postgres numbers and returns the rows of one insert in the order given.
	const rows = yield* db
		.insert(event)
		.values(
			pending.map((pendingEvent) => ({
				channel: pendingEvent.channel,
				type: pendingEvent.event.type,
				payload: pendingEvent.event,
			})),
		)
		.returning({ seq: event.seq });
	return pending.map((pendingEvent, index): CommittedEvent => {
		const row = rows[index];
		if (!row) throw new Error(`Storing a ${pendingEvent.event.type} returned no row`);
		return { ...pendingEvent, seq: row.seq };
	});
});
