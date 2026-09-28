export * as DomainEvents from "./domain-events.ts";

import { Effect } from "effect";
import { beforeCommit, type Database, type Transaction } from "../database.ts";

/**
 * Reacts to events inside the emitting transaction. It may emit more events,
 * and a failure in it is a defect that rolls the transaction back.
 */
export type Handler<Event> = (
	events: ReadonlyArray<Event>,
) => Effect.Effect<void, never, Database | Transaction>;

/** Records facts on the current transaction for the handlers to react to. */
export type Emit<Event> = (
	events: ReadonlyArray<Event>,
) => Effect.Effect<void, never, Database | Transaction>;

/**
 * Emits to `handlers`, in the order given.
 *
 * Emitting requires a transaction, so what the handlers write commits or
 * rolls back with the facts they react to. Events wait on the transaction
 * and reach the handlers just before the outermost transaction commits, so
 * events emitted in a savepoint that rolls back, or in a transaction that
 * fails, reach no handler.
 *
 * Each emitted batch reaches every handler before the next batch reaches
 * any, and batches arrive in the order they were emitted. Events a handler
 * emits join the back of the queue: every handler hears them after the batch
 * that caused them, and the transaction commits once the queue is empty.
 */
export const emitTo =
	<Event>(handlers: ReadonlyArray<Handler<Event>>): Emit<Event> =>
	(events) =>
		events.length === 0
			? Effect.void
			: beforeCommit(Effect.forEach(handlers, (handle) => handle(events), { discard: true }));
