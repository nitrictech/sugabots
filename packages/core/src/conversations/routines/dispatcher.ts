import { Duration, Effect, Layer } from "effect";
import type { Database } from "../../database/database.ts";
import type { RoutineStore } from "./store.ts";

export interface RoutineDispatcherOptions {
	store: Pick<RoutineStore, "claimNext" | "reconcileRunning">;
	pollInterval?: Duration.Input;
}

export const routineDispatcherLayer = ({
	store,
	pollInterval = Duration.millis(250),
}: RoutineDispatcherOptions): Layer.Layer<never, never, Database> => {
	const iteration = Effect.suspend(() => store.reconcileRunning()).pipe(
		Effect.andThen(Effect.suspend(() => store.claimNext())),
		Effect.flatMap((claimed) => (claimed ? Effect.void : Effect.sleep(pollInterval))),
		Effect.catchCause((cause) =>
			Effect.sync(() => console.error("Routine dispatcher iteration failed", cause)).pipe(
				Effect.andThen(Effect.sleep(pollInterval)),
			),
		),
	);
	return Layer.effectDiscard(Effect.forkScoped(iteration.pipe(Effect.forever)));
};
