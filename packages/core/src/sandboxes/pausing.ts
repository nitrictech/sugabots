import { Duration, Effect, Layer, Schedule } from "effect";
import type { Database } from "../database/database.ts";
import type { PodSandboxStore } from "./store.ts";

/** How long a sandbox may sit with nobody using it before it is paused, unless the installation says. */
export const DEFAULT_IDLE_PAUSE_MINUTES = 5;

/** How often idle sandboxes are looked for. A pause lands up to this long after it is due. */
const SWEEP_EVERY = Duration.minutes(1);

export interface SandboxPausingOptions {
	store: Pick<PodSandboxStore, "pauseIdle">;
	idlePauseMinutes?: number;
	every?: Duration.Input;
}

/**
 * Pauses sandboxes nobody has used for a while, for as long as the layer's
 * scope is open.
 *
 * Every process runs it, like the other background loops. Two processes
 * sweeping at once is harmless: each takes a pod's lock without waiting before
 * pausing its sandbox, and checks again under it that nobody has leased it.
 * A failed sweep is logged, and the next one tries again.
 */
export const sandboxPausingLayer = ({
	store,
	idlePauseMinutes = DEFAULT_IDLE_PAUSE_MINUTES,
	every = SWEEP_EVERY,
}: SandboxPausingOptions): Layer.Layer<never, never, Database> =>
	Layer.effectDiscard(
		Effect.forkScoped(
			store.pauseIdle(idlePauseMinutes * 60).pipe(
				Effect.flatMap((paused) =>
					paused > 0 ? Effect.logInfo(`paused ${paused} idle sandboxes`) : Effect.void,
				),
				Effect.catchCause((cause) => Effect.logError("pausing idle sandboxes failed", cause)),
				Effect.withSpan("Sandbox pausing"),
				Effect.repeat(Schedule.spaced(every)),
				Effect.asVoid,
			),
		),
	);
