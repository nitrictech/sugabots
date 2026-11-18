import { Duration, Effect, Layer } from "effect";
import { AutomationRunner } from "./automation-runner.ts";

/** How long the scheduler waits to look again when no automation was due. */
const POLL_INTERVAL = Duration.seconds(15);

/** Accepts the runs of scheduled automations as they fall due. */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const runner = yield* AutomationRunner.Service;
		const iteration = runner.processNextDue().pipe(
			Effect.flatMap((accepted) => (accepted ? Effect.void : Effect.sleep(POLL_INTERVAL))),
			Effect.catchCause((cause) =>
				Effect.logError("Automation scheduler iteration failed", cause).pipe(
					Effect.andThen(Effect.sleep(POLL_INTERVAL)),
				),
			),
		);
		// Untraced, because an idle poll would be a trace of its own every interval.
		// The turn a due automation starts is traced by its turn workflow.
		yield* Effect.forkScoped(iteration.pipe(Effect.forever, Effect.withTracerEnabled(false)));
	}),
);
