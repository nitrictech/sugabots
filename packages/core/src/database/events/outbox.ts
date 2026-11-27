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
 *
 * Every transaction takes its streams' locks in one order, by name, so two
 * transactions touching the same streams cannot deadlock. The locks are also
 * taken by the trigger that stores `session.ended` when a session is deleted,
 * and both record what they locked in the transaction's `LOCKED_STREAMS`
 * setting. Locking a stream that sorts before one the transaction already
 * holds fails at once, rather than waiting on a transaction that may be
 * waiting on this one.
 */
const appendEvents = Effect.fn("EventOutbox.appendEvents")(function* (
	db: Executor,
	pending: readonly PendingEvent[],
) {
	const [setting] = yield* db.execute<{ locked: string | null }>(
		sql`select current_setting(${LOCKED_STREAMS}, true) as locked`,
		"objects",
	);
	const locked = setting?.locked ? setting.locked.split(",") : [];
	const toLock = [...new Set(pending.map(({ stream }) => stream))]
		.filter((stream) => !locked.includes(stream))
		.sort();
	const lastLocked = locked.toSorted().at(-1);
	const [firstToLock] = toLock;
	if (firstToLock !== undefined && lastLocked !== undefined && firstToLock < lastLocked) {
		return yield* Effect.die(
			new Error(
				`Locking event stream ${firstToLock} after ${lastLocked} would take a transaction's stream locks out of order`,
			),
		);
	}
	for (const stream of toLock) {
		yield* db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${stream}, 0))`);
	}
	if (toLock.length > 0) {
		yield* db.execute(
			sql`select set_config(${LOCKED_STREAMS}, ${[...locked, ...toLock].join(",")}, true)`,
		);
	}

	if (pending.length === 0) return [];
	// Postgres numbers and returns the rows of one insert in the order given.
	const rows = yield* db
		.insert(event)
		.values(
			pending.map((pendingEvent) => ({
				stream: pendingEvent.stream,
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

/** The transaction-local setting listing the event streams the transaction has locked. */
const LOCKED_STREAMS = "sugabots.locked_streams";
