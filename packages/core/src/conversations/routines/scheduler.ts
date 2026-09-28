import { Duration, Effect, Layer } from "effect";
import { Routines } from "./routines.ts";

/** How long the scheduler waits to look again when no routine was due. */
const POLL_INTERVAL = Duration.seconds(15);

/** Accepts the runs of cron routines as they fall due. */
export const routineSchedulerLayer = Layer.effectDiscard(
	Effect.gen(function* () {
		const routines = yield* Routines.Service;
		const iteration = Effect.suspend(() => routines.processNextDue()).pipe(
			Effect.flatMap((accepted) => (accepted ? Effect.void : Effect.sleep(POLL_INTERVAL))),
			Effect.catchCause((cause) =>
				Effect.logError("Routine scheduler iteration failed", cause).pipe(
					Effect.andThen(Effect.sleep(POLL_INTERVAL)),
				),
			),
		);
		// Untraced, because an idle poll would be a trace of its own every interval.
		// The turn a due Routine starts is traced by its turn workflow.
		yield* Effect.forkScoped(iteration.pipe(Effect.forever, Effect.withTracerEnabled(false)));
	}),
);
