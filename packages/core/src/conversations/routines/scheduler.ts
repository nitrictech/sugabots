import { Duration, Effect, Layer } from "effect";
import type { Database } from "../../database/database.ts";
import type { RoutineStore } from "./store.ts";

export interface RoutineSchedulerOptions {
	store: Pick<RoutineStore, "processNextDue">;
	pollInterval?: Duration.Input;
}

export const routineSchedulerLayer = ({
	store,
	pollInterval = Duration.seconds(15),
}: RoutineSchedulerOptions): Layer.Layer<never, never, Database> => {
	const iteration = Effect.suspend(() => store.processNextDue()).pipe(
		Effect.flatMap((accepted) => (accepted ? Effect.void : Effect.sleep(pollInterval))),
		Effect.catchCause((cause) =>
			Effect.sync(() => console.error("Routine scheduler iteration failed", cause)).pipe(
				Effect.andThen(Effect.sleep(pollInterval)),
			),
		),
	);
	return Layer.effectDiscard(Effect.forkScoped(iteration.pipe(Effect.forever)));
};
