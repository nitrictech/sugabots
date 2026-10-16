export * as UnsentUploads from "./unsent-uploads.ts";

import { Duration, Effect, Layer, Schedule } from "effect";
import { ThreadFiles } from "./thread-files.ts";

/** How long an upload may wait to be attached to a message before it is removed. */
const UNSENT_FOR = Duration.hours(24);

/** How often unsent uploads are looked for. */
const INTERVAL = Duration.hours(1);

/**
 * Removes uploads never attached to a message, such as files added to a draft
 * that was abandoned, every `INTERVAL` for as long as the layer's scope is
 * open, starting at once.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const files = yield* ThreadFiles.Service;
		yield* Effect.forkScoped(
			files.removeUnsentUploads(UNSENT_FOR).pipe(
				Effect.catchCause((cause) => Effect.logError("Removing unsent uploads failed", cause)),
				Effect.repeat(Schedule.spaced(INTERVAL)),
			),
		);
	}),
).pipe(Layer.provide(ThreadFiles.layer));
