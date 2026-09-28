export * as EventPruning from "./prune.ts";

import { Duration, Effect, Layer, Schedule } from "effect";
import { EventStore } from "./store.ts";

/**
 * The `event` table is a resume buffer, not a log. Seven days is far longer
 * than any tab stays open and short enough that the table stays small; past it,
 * a client is told to `reset` and refetch, which costs one query instead of a
 * replay of everything since it left.
 */
export const RETENTION_DAYS = 7;

const NIGHTLY = Duration.days(1);

/**
 * Sweeps the event store every `every` for as long as the layer's scope is
 * open.
 *
 * A scoped fibre rather than a `setInterval` and a stop function: the sweep
 * ends when the process's scope closes, in order, without anyone remembering to
 * call anything. The fibre is interrupted mid-sweep if that is where it is, and
 * an interrupted sweep deletes nothing it had not already committed.
 *
 * It runs once immediately, because a process that restarts daily would
 * otherwise never prune.
 */
export const sweepingEvery = (
	every: Duration.Input,
): Layer.Layer<never, never, EventStore.Service> =>
	Layer.effectDiscard(
		Effect.flatMap(EventStore.Service, (store) =>
			Effect.forkScoped(sweep(store).pipe(Effect.repeat(Schedule.spaced(every)), Effect.asVoid)),
		),
	);

/** The nightly sweep. */
export const layer = sweepingEvery(NIGHTLY);

/**
 * One sweep. A failure is logged and swallowed on purpose: the next sweep
 * deletes whatever this one did not, and a full table is not worth taking the
 * API down for.
 */
const sweep = (store: EventStore.Interface) =>
	Effect.promise(() =>
		store.prune(new Date(Date.now() - RETENTION_DAYS * Duration.toMillis(Duration.days(1)))),
	).pipe(
		Effect.flatMap((removed) =>
			removed > 0
				? Effect.log(`Pruned ${removed} events older than ${RETENTION_DAYS} days`)
				: Effect.void,
		),
		Effect.catchCause((cause) => Effect.logError("Pruning events failed", cause)),
		Effect.withSpan("Event prune"),
	);
