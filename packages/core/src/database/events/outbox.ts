export * as EventOutbox from "./outbox.ts";

import type { Channel, DurableEventType, StreamEvent } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { afterCommit, type Database, type Executor, query, transaction } from "../database.ts";
import { event } from "../schema.ts";
import type { EventBus } from "./bus.ts";

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

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/EventOutbox") {}

/** An outbox whose events are delivered through `bus`. */
export const make = (bus: Pick<EventBus, "publishCommitted">): Interface =>
	Service.of({
		publish: (pending) =>
			transaction(
				Effect.gen(function* () {
					const committed = yield* query((db) => appendEvents(db, pending));
					yield* afterCommit(Effect.promise(() => bus.publishCommitted(committed)));
				}),
			),
	});

export const layer = (bus: Pick<EventBus, "publishCommitted">) => Layer.succeed(Service, make(bus));

export interface PendingEvent {
	channel: Channel;
	event: StreamEvent & { type: DurableEventType };
}

export interface CommittedEvent extends PendingEvent {
	/** The row's position in the `event` table, and the SSE id clients resume from. */
	seq: number;
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
const appendEvents = Effect.fn("EventOutbox.appendEvents")(function* (
	db: Executor,
	pending: readonly PendingEvent[],
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
